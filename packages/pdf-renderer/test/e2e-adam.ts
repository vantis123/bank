/**
 * E2E pipeline test: capture text → parse → score → render PDF.
 *
 * Pulls Adam's captured FSN text fixture, runs it through the full pipeline,
 * and writes a PDF to dist/. Proves the renderer works dynamically for any
 * client, not just the hardcoded Mitchell sample.
 */

import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { parseFSN } from "@bank/parsers";
import { computeScorecard } from "@bank/funding-rules";
import { renderBankPdf } from "../src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = resolve(ROOT, "..", "parsers", "fixtures", "fsn-adam.txt");
const OUT_DIR = resolve(ROOT, "dist");
const OUT_PDF = resolve(OUT_DIR, "adam-bank-report.pdf");

(async () => {
  console.log("─".repeat(70));
  console.log("Bank E2E Pipeline Test — Adam");
  console.log("─".repeat(70));

  await mkdir(OUT_DIR, { recursive: true });

  console.log(`\n[1/4] Reading fixture: ${FIXTURE}`);
  const text = await readFile(FIXTURE, "utf8");
  console.log(`      ${text.length.toLocaleString()} chars loaded`);

  console.log("\n[2/4] Parsing FSN credit report…");
  const report = parseFSN(text);
  console.log(`      Platform: ${report.platform}`);
  console.log(`      Report date: ${report.reportDate ?? "unknown"}`);
  console.log(
    `      Scores: EQ=${report.scores.equifax ?? "—"} EX=${report.scores.experian ?? "—"} TU=${report.scores.transunion ?? "—"}`
  );
  console.log(`      Accounts: ${report.accounts.length}`);
  const negCount = report.accounts.filter((a) => a.isNegative).length;
  console.log(`      Negative accounts: ${negCount}`);
  if (report.warnings.length > 0) {
    console.log(`      Warnings: ${report.warnings.length}`);
  }

  console.log("\n[3/4] Computing scorecard…");
  const scorecard = computeScorecard(report);
  console.log(`      Verdict: ${scorecard.verdict.toUpperCase()}`);
  console.log(`      Funding range: ${scorecard.fundingRange}`);
  console.log(`      Pass: ${scorecard.passCount} · Fail: ${scorecard.failCount} · Mixed: ${scorecard.mixedCount}`);
  console.log("      Per-criterion:");
  for (const c of scorecard.criteria) {
    const eq = c.bureaus.equifax;
    const ex = c.bureaus.experian;
    const tu = c.bureaus.transunion;
    console.log(
      `        · ${c.label.padEnd(40)} ${c.status.toUpperCase().padEnd(7)}` +
        `  EQ=${eq.value}/${eq.status[0]?.toUpperCase()}` +
        `  EX=${ex.value}/${ex.status[0]?.toUpperCase()}` +
        `  TU=${tu.value}/${tu.status[0]?.toUpperCase()}`
    );
  }

  console.log("\n[4/4] Rendering PDF…");
  await renderBankPdf({
    report,
    scorecard,
    client: {
      name: "Adam Vitek",
      reportDate: report.reportDate ?? "—",
      preparer: "Phillip Rivera",
      phone: "(555) 555-5555",
      email: "phillip@arvantis.tech",
    },
    outputPath: OUT_PDF,
    emitHtml: true,
  });
  console.log(`      Written: ${OUT_PDF}`);

  console.log("\nDone. Opening…");
  const opener = spawn("open", [OUT_PDF], { detached: true, stdio: "ignore" });
  opener.unref();
})().catch((err) => {
  console.error("\nE2E pipeline failed:");
  console.error(err);
  process.exit(1);
});
