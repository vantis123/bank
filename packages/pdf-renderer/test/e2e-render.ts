/**
 * Generic E2E renderer: text fixture → parse → score → PDF.
 *
 *   npx tsx packages/pdf-renderer/test/e2e-render.ts \
 *     --in <path-to-text> \
 *     --platform fsn|iiq \
 *     --name "Client Name" \
 *     [--out <path-to-pdf>]
 *
 * For quick repeat tests on a fixture, you can also call it without flags
 * and it will fall back to Adam's saved fixture.
 */

import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { parseFSNAny, parseIIQ } from "@bank/parsers";
import { computeScorecard } from "@bank/funding-rules";
import { renderBankPdf } from "../src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEFAULT_FIXTURE = resolve(
  ROOT,
  "..",
  "parsers",
  "fixtures",
  "fsn-adam.txt"
);
const DIST = resolve(ROOT, "dist");

interface CliOpts {
  in?: string;
  platform?: "fsn" | "iiq";
  name?: string;
  out?: string;
  preparer?: string;
  phone?: string;
  email?: string;
  open?: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--in" && next) { opts.in = next; i++; }
    else if (a === "--platform" && next) { opts.platform = next as "fsn" | "iiq"; i++; }
    else if (a === "--name" && next) { opts.name = next; i++; }
    else if (a === "--out" && next) { opts.out = next; i++; }
    else if (a === "--preparer" && next) { opts.preparer = next; i++; }
    else if (a === "--phone" && next) { opts.phone = next; i++; }
    else if (a === "--email" && next) { opts.email = next; i++; }
    else if (a === "--no-open") { opts.open = false; }
  }
  return opts;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));

  const fixturePath = opts.in ?? DEFAULT_FIXTURE;
  const platform = opts.platform ?? guessPlatform(fixturePath);
  const clientName = opts.name ?? guessName(fixturePath);
  const outPath =
    opts.out ?? resolve(DIST, `${slug(clientName)}-bank-report.pdf`);

  console.log("─".repeat(70));
  console.log(`Bank E2E Render — ${clientName}`);
  console.log("─".repeat(70));

  await mkdir(DIST, { recursive: true });

  console.log(`\n[1/4] Reading: ${fixturePath}`);
  const text = await readFile(fixturePath, "utf8");
  console.log(`      ${text.length.toLocaleString()} chars · platform=${platform}`);

  console.log(`\n[2/4] Parsing…`);
  const report = platform === "iiq" ? parseIIQ(text) : parseFSNAny(text);
  console.log(
    `      Scores: EQ=${report.scores.equifax ?? "—"} EX=${report.scores.experian ?? "—"} TU=${report.scores.transunion ?? "—"}`
  );
  console.log(`      Accounts: ${report.accounts.length} (${report.accounts.filter(a => a.isNegative).length} negative)`);
  if (report.warnings.length) console.log(`      Warnings: ${report.warnings.length}`);

  console.log(`\n[3/4] Scoring…`);
  const scorecard = computeScorecard(report);
  console.log(`      Verdict: ${scorecard.verdict.toUpperCase()} · ${scorecard.fundingRange}`);
  console.log(`      Pass=${scorecard.passCount} Fail=${scorecard.failCount} Mixed=${scorecard.mixedCount}`);

  console.log(`\n[4/4] Rendering…`);
  await renderBankPdf({
    report,
    scorecard,
    client: {
      name: clientName,
      reportDate: report.reportDate ?? "—",
      preparer: opts.preparer ?? "Phillip Rivera",
      phone: opts.phone,
      email: opts.email,
    },
    outputPath: outPath,
    emitHtml: true,
  });
  console.log(`      Written: ${outPath}`);

  if (opts.open) {
    console.log(`\nOpening…`);
    const opener = spawn("open", [outPath], { detached: true, stdio: "ignore" });
    opener.unref();
  }
})().catch((err) => {
  console.error("\nE2E render failed:");
  console.error(err);
  process.exit(1);
});

function guessPlatform(p: string): "fsn" | "iiq" {
  const b = basename(p).toLowerCase();
  if (b.includes("iiq") || b.includes("identityiq")) return "iiq";
  return "fsn";
}

function guessName(p: string): string {
  const b = basename(p, ".txt");
  // patterns: fsn-adam, iiq-hannah, fsn-nathaniel-altman-<ts>
  const cleaned = b.replace(/^(fsn|iiq)[-_]/i, "").replace(/[-_]?\d{6,}$/, "");
  return cleaned
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ") || "Client";
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
}
