/**
 * @bank/dashboard — local Bank dashboard.
 *
 * Single-page web app that runs on localhost. User enters FSN/IIQ creds + their
 * client's name, hits Run. Dashboard kicks off the capture → parse → score →
 * render pipeline and shows the resulting PDF inline + download.
 *
 *   npm run start    # → http://localhost:7878
 */

import express from "express";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

import { parseFSNAny, parseIIQ } from "@bank/parsers";
import { computeScorecard } from "@bank/funding-rules";
import { renderBankPdf } from "@bank/pdf-renderer";
import { captureFSN, captureIIQ } from "@bank/playwright-flows";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");

const HOME = process.env.HOME || process.cwd();
const SANDBOX_DIR = resolve(HOME, ".bank", "sandbox");
const REPORTS_DIR = resolve(HOME, ".bank", "reports");

const PORT = Number(process.env.PORT ?? 7878);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

// Serve generated PDFs (and any artifacts in REPORTS_DIR) — read-only.
app.use("/reports", express.static(REPORTS_DIR));

interface RunBody {
  platform: "fsn" | "iiq";
  username: string;
  password: string;
  last4?: string;
  clientName: string;
  preparer?: string;
  phone?: string;
  email?: string;
  headed?: boolean;
}

app.post("/api/run", async (req, res) => {
  const body = req.body as RunBody;

  if (!body.platform || !body.username || !body.password || !body.clientName) {
    return res.status(400).json({
      ok: false,
      stage: "validate",
      error: "platform, username, password, and clientName are required",
    });
  }

  await mkdir(SANDBOX_DIR, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });

  try {
    const captureFn = body.platform === "fsn" ? captureFSN : captureIIQ;
    const cap = await captureFn({
      username: body.username,
      password: body.password,
      last4: body.last4,
      headed: body.headed ?? true,
      sandboxDir: SANDBOX_DIR,
    });

    if (!cap.ok || cap.text.length === 0) {
      return res.status(200).json({
        ok: false,
        stage: "capture",
        error: cap.error ?? "Empty capture text — login may have failed or account isn't fully verified",
        warnings: cap.warnings,
        screenshots: cap.screenshots.map((p) => "/reports/" + basename(p)),
      });
    }

    const report =
      body.platform === "iiq" ? parseIIQ(cap.text) : parseFSNAny(cap.text);
    const scorecard = computeScorecard(report);

    const fileName = `${slug(body.clientName)}-bank-report-${Date.now()}.pdf`;
    const outPath = resolve(REPORTS_DIR, fileName);

    await renderBankPdf({
      report,
      scorecard,
      client: {
        name: body.clientName,
        preparer: body.preparer ?? "Your Name",
        phone: body.phone,
        email: body.email,
      },
      outputPath: outPath,
    });

    return res.json({
      ok: true,
      pdfUrl: `/reports/${fileName}`,
      pdfPath: outPath,
      verdict: scorecard.verdict,
      verdictHeadline: scorecard.verdictHeadline,
      verdictSubtext: scorecard.verdictSubtext,
      fundingRange: scorecard.fundingRange,
      passCount: scorecard.passCount,
      failCount: scorecard.failCount,
      mixedCount: scorecard.mixedCount,
      accountsTotal: report.accounts.length,
      accountsNegative: report.accounts.filter((a) => a.isNegative).length,
      scores: report.scores,
      captureSource: cap.source,
      captureWarnings: cap.warnings,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      stage: "pipeline",
      error: (err as Error).message,
    });
  }
});

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "client"
  );
}

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Bank dashboard running at ${url}`);
  console.log(`  Sandbox:  ${SANDBOX_DIR}`);
  console.log(`  Reports:  ${REPORTS_DIR}\n`);

  // Auto-open in default browser. `start` on Windows is a cmd.exe builtin,
  // not an executable, so it has to be invoked via cmd /c. Wrapping in
  // try/catch + child error handler so a failed open never takes down the
  // server — the URL is already logged either way.
  if (process.env.BANK_NO_OPEN !== "1" && existsSync(PUBLIC_DIR)) {
    import("node:child_process").then(({ spawn }) => {
      try {
        let cmd: string;
        let args: string[];
        if (process.platform === "win32") {
          cmd = "cmd.exe";
          args = ["/c", "start", "", url];
        } else if (process.platform === "darwin") {
          cmd = "open";
          args = [url];
        } else {
          cmd = "xdg-open";
          args = [url];
        }
        const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: false });
        child.on("error", () => {
          // Browser open failed — that's OK, the URL is already in the console
        });
        child.unref();
      } catch {
        // Same — never crash the server because of a browser-open issue
      }
    }).catch(() => {});
  }
});
