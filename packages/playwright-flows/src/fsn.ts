/**
 * FSN (MyFreeScoreNow) capture flow.
 *
 * Strategy:
 *   1. Login — try new site (app.*) first, fall back to legacy (member.*) if
 *      we land on an enrollment funnel.
 *   2. Navigate to credit report — try text-based locators ("Credit Report"),
 *      then a list of known direct URLs (smart-3b, /credit-report, etc.).
 *   3. Capture — print-popup if available, else download, else per-tradeline
 *      expand-capture-collapse loop.
 */

import type { Page } from "playwright";
import { sleep, scrollPass, findVisible, snap } from "./util.ts";
import type { CaptureSource, FlowContext } from "./types.ts";

interface FSNSite {
  label: "new" | "legacy";
  loginUrl: string;
}

const FSN_SITES: FSNSite[] = [
  { label: "new", loginUrl: "https://app.myfreescorenow.com/login" },
  { label: "legacy", loginUrl: "https://member.myfreescorenow.com/login" },
];

const REPORT_URLS = [
  "https://member.myfreescorenow.com/member/credit-report/smart-3b/",
  "https://member.myfreescorenow.com/member/credit-report/smart-3b",
  "https://app.myfreescorenow.com/credit-report",
  "https://app.myfreescorenow.com/credit_report",
  "https://app.myfreescorenow.com/report",
  "https://app.myfreescorenow.com/3b-report",
  "https://member.myfreescorenow.com/credit-report",
  "https://member.myfreescorenow.com/3b-report",
  "https://member.myfreescorenow.com/Reports",
  "https://member.myfreescorenow.com/Members/Reports",
];

export async function fsnLogin(
  ctx: FlowContext,
  username: string,
  password: string
): Promise<FSNSite> {
  let lastErr: Error | null = null;
  for (const site of FSN_SITES) {
    try {
      const ok = await fsnLoginSite(ctx, username, password, site);
      if (ok) {
        ctx.log(`  -> Logged in via ${site.label} site`);
        return site;
      }
    } catch (err) {
      lastErr = err as Error;
      ctx.log(`  -> ${site.label} login threw: ${(err as Error).message}`);
    }
  }
  throw lastErr ?? new Error("FSN login failed on all known sites");
}

async function fsnLoginSite(
  ctx: FlowContext,
  username: string,
  password: string,
  site: FSNSite
): Promise<boolean> {
  ctx.log(`  -> Trying ${site.label}: ${site.loginUrl}`);
  await ctx.page.goto(site.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(3000);

  const userField = await findVisible(ctx.page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="userName"]',
    "#email",
    "#username",
    'input[placeholder*="email" i]',
    'input[autocomplete="username"]',
  ]);
  const passField = await findVisible(ctx.page, [
    'input[type="password"]',
    'input[name="password"]',
    "#password",
  ]);

  if (!userField || !passField) {
    throw new Error(
      `Login fields not found (user=${!!userField}, pass=${!!passField})`
    );
  }

  await ctx.page.fill(userField, username);
  await sleep(400);
  await ctx.page.fill(passField, password);
  await sleep(700);

  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Login")',
    'a:has-text("Sign In")',
  ];
  const submit = await findVisible(ctx.page, submitSelectors);
  if (submit) {
    await ctx.page.click(submit);
  } else {
    await ctx.page.press(passField, "Enter");
  }

  try {
    await ctx.page.waitForNavigation({ waitUntil: "networkidle", timeout: 25000 });
  } catch {
    await sleep(7000);
  }

  const finalUrl = ctx.page.url();
  ctx.log(`  -> Post-login URL: ${finalUrl}`);

  if (
    /\/enroll\//i.test(finalUrl) ||
    /\/login\b/i.test(finalUrl) ||
    /\/signup\b/i.test(finalUrl)
  ) {
    ctx.log(
      `  -> ${site.label} dropped to ${finalUrl} — not a real dashboard, will try next site`
    );
    return false;
  }
  return true;
}

export async function fsnNavigateToReport(
  ctx: FlowContext
): Promise<{ url: string; source: CaptureSource } | null> {
  ctx.log("  -> Looking for report link in nav");

  for (const text of ["Credit Report", "3B Report", "View Full Report", "View Report"]) {
    try {
      const el = ctx.page.getByText(text, { exact: true }).first();
      if (await el.isVisible({ timeout: 1500 })) {
        ctx.log(`  -> Clicking text: "${text}"`);
        await el.click();
        await sleep(6000);
        return { url: ctx.page.url(), source: classifyUrl(ctx.page.url()) };
      }
    } catch {}
  }

  for (const url of REPORT_URLS) {
    try {
      ctx.log(`  -> Trying direct URL: ${url}`);
      const resp = await ctx.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      if (resp && resp.status() < 400) {
        await sleep(4000);
        const finalUrl = ctx.page.url();
        if (!finalUrl.endsWith("/dashboard") && !finalUrl.endsWith("/login")) {
          return { url: finalUrl, source: classifyUrl(finalUrl) };
        }
      }
    } catch {}
  }
  return null;
}

function classifyUrl(url: string): CaptureSource {
  if (/member\.myfreescorenow\.com\/member\/credit-report\/smart-3b/i.test(url)) {
    return "fsn-legacy-3b";
  }
  if (/member\.myfreescorenow\.com\/credit-report/i.test(url)) {
    return "fsn-legacy-equifax";
  }
  return "fsn-new";
}

export async function fsnCaptureReport(
  ctx: FlowContext
): Promise<{ text: string; source: CaptureSource; pdfPath?: string }> {
  await sleep(4000);
  await snap(ctx, ctx.page, "fsn-dashboard");

  const nav = await fsnNavigateToReport(ctx);
  if (!nav) {
    ctx.warnings.push("Could not navigate to a credit-report page; capturing dashboard");
  }

  ctx.log("  -> Scrolling to trigger lazy content");
  await scrollPass(ctx.page, 20);
  await sleep(2000);
  await snap(ctx, ctx.page, "fsn-credit-report");

  // Try the print-button strategy first (fastest, gets a real PDF)
  const printResult = await tryPrintFlow(ctx);
  if (printResult.captured) {
    ctx.log(`  -> PRINT CAPTURED via ${printResult.source} (${printResult.text.length} chars)`);
    return {
      text: printResult.text,
      source: printResult.source,
      pdfPath: printResult.pdfPath,
    };
  }
  ctx.log(`  -> Print path no-op (${printResult.reason}) — falling back`);

  // Fallback: per-tradeline expand-capture-collapse loop
  const seeDetailsCount = await ctx.page.locator('text="See Details"').count();
  ctx.log(`  -> See Details elements: ${seeDetailsCount}`);

  if (seeDetailsCount === 0) {
    const text = await ctx.page.evaluate(() => document.body?.innerText || "");
    return { text, source: nav?.source ?? "fsn-new" };
  }

  ctx.log(`  -> Per-tradeline capture loop`);
  const segments: string[] = [];
  let captured = 0;
  let failed = 0;

  for (let i = 0; i < seeDetailsCount; i++) {
    try {
      const el = ctx.page.locator('text="See Details"').nth(i);
      await el.scrollIntoViewIfNeeded({ timeout: 3000 });
      await sleep(150);
      await el.click({ timeout: 3000 });
      await sleep(400);

      const segment = await ctx.page.evaluate(() => {
        const seeLessEls = Array.from(document.querySelectorAll("*")).filter((el) => {
          const t = (el.textContent || "").trim();
          return /See Less\s*$/.test(t) && el.children.length < 5;
        });
        if (seeLessEls.length === 0) return null;
        const seeLessEl = seeLessEls[seeLessEls.length - 1];
        if (!seeLessEl) return null;
        let container: Element | null = seeLessEl;
        for (let depth = 0; depth < 12 && container; depth++) {
          if (container.textContent && /Account Name/i.test(container.textContent)) break;
          container = container.parentElement;
        }
        if (!container) return null;
        return (container as HTMLElement).innerText || container.textContent || "";
      });

      if (segment && segment.length > 200) {
        segments.push(`\n=== Tradeline ${i + 1} ===\n${segment}\n`);
        captured++;
      }

      if ((i + 1) % 10 === 0) {
        ctx.log(`     ... ${i + 1}/${seeDetailsCount} processed (${captured} ok, ${failed} failed)`);
      }
    } catch (e) {
      failed++;
    }
  }

  ctx.log(`  -> Tradeline capture: ${captured} ok / ${failed} failed / ${seeDetailsCount} total`);

  const baselineText = await ctx.page.evaluate(() => document.body?.innerText || "");
  const fullText = baselineText + "\n\n=== EXPANDED TRADELINES ===\n" + segments.join("\n");

  return { text: fullText, source: "fsn-tradeline-loop" };
}

interface PrintResult {
  captured: boolean;
  source: CaptureSource;
  text: string;
  pdfPath?: string;
  reason?: string;
}

async function tryPrintFlow(ctx: FlowContext): Promise<PrintResult> {
  const page = ctx.page;
  const context = ctx.context;
  let popupPage: Page | null = null;
  let downloadPath: string | null = null;
  let printCalled = false;

  await page.evaluate(() => {
    // @ts-ignore
    window.__printIntercepted = false;
    const orig = window.print;
    window.print = function () {
      // @ts-ignore
      window.__printIntercepted = true;
    };
  });

  const popupPromise = context
    .waitForEvent("page", { timeout: 8000 })
    .then((p) => {
      popupPage = p;
      return p;
    })
    .catch(() => null);
  const downloadPromise = page
    .waitForEvent("download", { timeout: 8000 })
    .then(async (d) => {
      const fileName = `fsn-print-download-${Date.now()}.pdf`;
      const path = `${ctx.sandboxDir}/${fileName}`;
      await d.saveAs(path);
      downloadPath = path;
      return d;
    })
    .catch(() => null);

  let clicked = false;
  for (const sel of [
    'button:has-text("Print Selected Document")',
    'button[aria-label*="Print"]',
    'button:has-text("Print")',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    return { captured: false, source: "fsn-new", text: "", reason: "print button not found" };
  }

  await sleep(3000);
  printCalled = await page.evaluate(() => !!(window as any).__printIntercepted);
  await Promise.race([popupPromise, downloadPromise, sleep(5000)]);

  if (popupPage) {
    const p = popupPage as Page;
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 15000 });
      await sleep(3000);
      await p.emulateMedia({ media: "screen" });
      await scrollPass(p, 20);
      await sleep(1000);

      const text = await p.evaluate(() => document.body?.innerText || "");
      const pdfPath = `${ctx.sandboxDir}/fsn-print-popup-${Date.now()}.pdf`;
      await p.pdf({
        path: pdfPath,
        format: "Letter",
        printBackground: true,
        margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" },
      });
      return {
        captured: true,
        source: "fsn-print-popup",
        text,
        pdfPath,
      };
    } finally {
      await p.close().catch(() => {});
    }
  }

  if (downloadPath) {
    return {
      captured: true,
      source: "fsn-print-download",
      text: "", // text extracted later via @bank/parsers from the PDF if needed
      pdfPath: downloadPath,
    };
  }

  if (printCalled) {
    await page.emulateMedia({ media: "screen" });
    await sleep(1500);
    const text = await page.evaluate(() => document.body?.innerText || "");
    return { captured: true, source: "fsn-new", text };
  }

  return { captured: false, source: "fsn-new", text: "", reason: "no popup, no download, no intercept" };
}
