#!/usr/bin/env node
/**
 * @bank/mcp-server
 * ----------------
 * Stdio MCP server exposing Bank as 5 tools any MCP-aware client (Claude
 * Code / Cursor / Codex) can call:
 *
 *   bank_capture     login → scrape FSN/IIQ → return text + source
 *   bank_parse       text → CreditReport (auto-detects platform/format)
 *   bank_score       CreditReport → Scorecard (Phillip's 8 funding criteria)
 *   bank_render      CreditReport + Scorecard + client info → PDF on disk
 *   bank_run_full    one call: capture → parse → score → render → PDF path
 *
 * Add to ~/.claude/mcp.json:
 *   { "mcpServers": { "bank": { "command": "node", "args": ["/path/to/bank/apps/mcp-server/src/index.ts"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  parseFSNAny,
  parseIIQ,
  type CreditReport,
} from "@bank/parsers";
import { computeScorecard, type Scorecard } from "@bank/funding-rules";
import { renderBankPdf } from "@bank/pdf-renderer";
import { captureFSN, captureIIQ } from "@bank/playwright-flows";

const server = new McpServer({
  name: "bank",
  version: "0.0.1",
});

// Default sandbox + output directories — under user's home so the dist zip
// doesn't pollute the package itself.
const HOME = process.env.HOME || process.cwd();
const DEFAULT_SANDBOX = resolve(HOME, ".bank", "sandbox");
const DEFAULT_OUT = resolve(HOME, ".bank", "reports");

// ───────────── bank_capture ─────────────────────────────────────────

server.registerTool(
  "bank_capture",
  {
    title: "Capture credit report",
    description:
      "Logs into FSN or IdentityIQ in a real browser (headed by default) and " +
      "scrapes the credit report. Returns the raw text + diagnostic info. " +
      "Pipe the text into bank_parse next.",
    inputSchema: {
      platform: z.enum(["fsn", "iiq"]).describe("Which monitoring service the user is on"),
      username: z.string().describe("Login email or username"),
      password: z.string().describe("Login password"),
      last4: z
        .string()
        .optional()
        .describe("Last 4 of SSN — required for IIQ security challenge, ignored for FSN"),
      headed: z
        .boolean()
        .default(true)
        .describe("Show the browser window — default true so the user can watch"),
      sandboxDir: z
        .string()
        .optional()
        .describe(`Where intermediate files are saved (default: ${DEFAULT_SANDBOX})`),
    },
  },
  async (args) => {
    const sandboxDir = args.sandboxDir ?? DEFAULT_SANDBOX;
    await mkdir(sandboxDir, { recursive: true });

    const fn = args.platform === "fsn" ? captureFSN : captureIIQ;
    const result = await fn({
      username: args.username,
      password: args.password,
      last4: args.last4,
      headed: args.headed,
      sandboxDir,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: result.ok,
              platform: result.platform,
              source: result.source,
              chars: result.text.length,
              pdfPath: result.pdfPath,
              screenshots: result.screenshots,
              warnings: result.warnings,
              error: result.error,
              text: result.text,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ───────────── bank_parse ───────────────────────────────────────────

server.registerTool(
  "bank_parse",
  {
    title: "Parse credit report text",
    description:
      "Takes raw report text (from bank_capture or pasted manually) and returns " +
      "a typed CreditReport. Auto-detects FSN vs IIQ vs FSN-legacy format.",
    inputSchema: {
      text: z.string().describe("Raw report text"),
      platform: z
        .enum(["fsn", "iiq", "auto"])
        .default("auto")
        .describe("Force a parser, or auto-detect"),
    },
  },
  async (args) => {
    const platform = args.platform === "auto" ? detectPlatform(args.text) : args.platform;
    const report = platform === "iiq" ? parseIIQ(args.text) : parseFSNAny(args.text);
    return jsonResult(report);
  }
);

// ───────────── bank_score ───────────────────────────────────────────

server.registerTool(
  "bank_score",
  {
    title: "Compute funding scorecard",
    description:
      "Takes a parsed CreditReport and returns a Scorecard with verdict " +
      "(refer-credit-repair / qualified / ideal) and Phillip's 8-criterion grades.",
    inputSchema: {
      report: z.unknown().describe("CreditReport from bank_parse"),
    },
  },
  async (args) => {
    const scorecard = computeScorecard(args.report as CreditReport);
    return jsonResult(scorecard);
  }
);

// ───────────── bank_render ──────────────────────────────────────────

server.registerTool(
  "bank_render",
  {
    title: "Render Bank PDF",
    description:
      "Takes a CreditReport + Scorecard + client info and renders a luxury " +
      "5-page Arvantis-branded PDF. Returns the file path.",
    inputSchema: {
      report: z.unknown().describe("CreditReport"),
      scorecard: z.unknown().describe("Scorecard"),
      clientName: z.string().describe("Client's full name (for cover + headers)"),
      preparer: z
        .string()
        .optional()
        .describe("Your name as it appears on the report (default: from env BANK_PREPARER)"),
      phone: z.string().optional(),
      email: z.string().optional(),
      outputPath: z.string().optional().describe(`Default: ${DEFAULT_OUT}/<slug>-bank-report.pdf`),
    },
  },
  async (args) => {
    const outDir = DEFAULT_OUT;
    await mkdir(outDir, { recursive: true });
    const outPath =
      args.outputPath ?? resolve(outDir, `${slug(args.clientName)}-bank-report.pdf`);

    await renderBankPdf({
      report: args.report as CreditReport,
      scorecard: args.scorecard as Scorecard,
      client: {
        name: args.clientName,
        preparer: args.preparer ?? process.env.BANK_PREPARER ?? "Your Name",
        phone: args.phone,
        email: args.email,
      },
      outputPath: outPath,
    });

    return jsonResult({ ok: true, path: outPath });
  }
);

// ───────────── bank_run_full ────────────────────────────────────────

server.registerTool(
  "bank_run_full",
  {
    title: "Full pipeline — capture to PDF",
    description:
      "One call: logs in, captures, parses, scores, renders the PDF. " +
      "Best for end users who just want their report PDF.",
    inputSchema: {
      platform: z.enum(["fsn", "iiq"]),
      username: z.string(),
      password: z.string(),
      last4: z.string().optional(),
      clientName: z.string(),
      preparer: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      outputPath: z.string().optional(),
      headed: z.boolean().default(true),
    },
  },
  async (args) => {
    const sandboxDir = DEFAULT_SANDBOX;
    await mkdir(sandboxDir, { recursive: true });
    await mkdir(DEFAULT_OUT, { recursive: true });

    const captureFn = args.platform === "fsn" ? captureFSN : captureIIQ;
    const cap = await captureFn({
      username: args.username,
      password: args.password,
      last4: args.last4,
      headed: args.headed,
      sandboxDir,
    });
    if (!cap.ok || cap.text.length === 0) {
      return jsonResult({
        ok: false,
        stage: "capture",
        error: cap.error ?? "Empty capture text",
        warnings: cap.warnings,
      });
    }

    const report =
      args.platform === "iiq" ? parseIIQ(cap.text) : parseFSNAny(cap.text);
    const scorecard = computeScorecard(report);
    const outPath =
      args.outputPath ??
      resolve(DEFAULT_OUT, `${slug(args.clientName)}-bank-report.pdf`);

    await renderBankPdf({
      report,
      scorecard,
      client: {
        name: args.clientName,
        preparer: args.preparer ?? process.env.BANK_PREPARER ?? "Your Name",
        phone: args.phone,
        email: args.email,
      },
      outputPath: outPath,
    });

    return jsonResult({
      ok: true,
      pdfPath: outPath,
      verdict: scorecard.verdict,
      fundingRange: scorecard.fundingRange,
      passCount: scorecard.passCount,
      failCount: scorecard.failCount,
      mixedCount: scorecard.mixedCount,
      accountsTotal: report.accounts.length,
      accountsNegative: report.accounts.filter((a) => a.isNegative).length,
      captureSource: cap.source,
      captureWarnings: cap.warnings,
    });
  }
);

// ───────────── Helpers ──────────────────────────────────────────────

function jsonResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

function detectPlatform(text: string): "fsn" | "iiq" {
  if (/IdentityIQ|identityiq\.com/i.test(text)) return "iiq";
  return "fsn";
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "client"
  );
}

// ───────────── Boot ─────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[bank-mcp] ready\n");
