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

const server = new McpServer(
  {
    name: "bank",
    version: "0.0.1",
  },
  {
    instructions:
      "Bank is Arvantis Tech's funding-intelligence agent. It logs into a client's " +
      "MyFreeScoreNow or IdentityIQ account, pulls their full 3-bureau credit report, " +
      "grades it against 9 funding-underwriter criteria, and renders a luxury PDF " +
      "with a clear verdict (Refer to Credit Repair / Qualified $30K-$75K / Ideal $75K+).\n\n" +
      "FOR TYPICAL USER REQUESTS like 'run a Bank report for client X' or 'pull funding " +
      "analysis for this client', call `bank_run_full` — it's one call from credentials " +
      "to PDF.\n\n" +
      "USE THE GRANULAR TOOLS (`bank_capture`, `bank_parse`, `bank_score`, `bank_render`) " +
      "only when the user wants finer control — e.g., reviewing the parsed accounts before " +
      "scoring, scoring text the user pasted manually, or rendering a report from a " +
      "previously captured fixture.\n\n" +
      "NOTE: Bank opens a real browser window during capture so the user can see it work. " +
      "All processing is local — no client data ever leaves the user's machine.",
  }
);

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
      "Takes a parsed CreditReport and returns a Scorecard with a verdict " +
      "(refer-credit-repair / qualified / ideal) plus per-bureau grades for " +
      "9 funding criteria: credit score 680+, no collections, no lates 24mo, " +
      "under 2 hard inquiries per bureau, 3+ open accounts, 36mo+ average " +
      "account age, per-card utilization under 30%, $5K+ card limit, $10K+ " +
      "card limit. Any FAIL → refer-credit-repair. All PASS at stricter " +
      "thresholds → ideal. Pipe the result into bank_render for the PDF.",
    inputSchema: {
      report: z
        .unknown()
        .describe(
          "CreditReport object (the JSON returned by bank_parse — has scores, summary, accounts arrays)"
        ),
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
      report: z
        .unknown()
        .describe("CreditReport object from bank_parse — the parsed credit report data"),
      scorecard: z
        .unknown()
        .describe("Scorecard object from bank_score — has the verdict + 9 criteria grades"),
      clientName: z.string().describe("Client's full name — appears on the cover and page headers"),
      preparer: z
        .string()
        .optional()
        .describe(
          "Credit pro's name (the user) — appears in the PDF footer. Falls back to env BANK_PREPARER, then 'Your Name'."
        ),
      phone: z.string().optional().describe("Preparer's phone — shows in the PDF footer"),
      email: z.string().optional().describe("Preparer's email — shows in the PDF footer"),
      outputPath: z
        .string()
        .optional()
        .describe(`Where to write the PDF. Defaults to ${DEFAULT_OUT}/<client-name-slug>-bank-report.pdf`),
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
      "One-call pipeline: logs into the client's credit-monitoring account, " +
      "captures their 3-bureau report, parses it, scores it against the 9 " +
      "funding criteria, and renders the luxury PDF — all in ~60 seconds. " +
      "This is the right tool for typical user requests like 'pull a Bank " +
      "report for client X' or 'run funding analysis on my client'. Returns " +
      "the PDF path + a summary of the verdict, scores, and account counts. " +
      "Opens a real browser window during capture (headed=true by default).",
    inputSchema: {
      platform: z
        .enum(["fsn", "iiq"])
        .describe(
          "Which credit-monitoring service the client uses. 'fsn' = MyFreeScoreNow, 'iiq' = IdentityIQ."
        ),
      username: z.string().describe("Client's login email or username for the monitoring service"),
      password: z.string().describe("Client's login password for the monitoring service"),
      last4: z
        .string()
        .optional()
        .describe(
          "Last 4 of client's SSN — required for IdentityIQ's security challenge, ignored for FSN. Skip if platform=fsn."
        ),
      clientName: z
        .string()
        .describe("Client's full name — appears on the PDF cover, every page header, and the filename"),
      preparer: z
        .string()
        .optional()
        .describe(
          "The credit pro's name (the user calling Bank) — appears in the PDF footer as who prepared the report. Falls back to env BANK_PREPARER, then to 'Your Name'."
        ),
      phone: z.string().optional().describe("Preparer's phone — appears in the PDF footer next to the preparer name"),
      email: z.string().optional().describe("Preparer's email — appears in the PDF footer"),
      outputPath: z
        .string()
        .optional()
        .describe(
          `Where to write the PDF. Defaults to ${DEFAULT_OUT}/<client-name-slug>-bank-report.pdf`
        ),
      headed: z
        .boolean()
        .default(true)
        .describe(
          "Show the Playwright browser window during capture (default true). Set false for headless environments like servers/codespaces."
        ),
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
