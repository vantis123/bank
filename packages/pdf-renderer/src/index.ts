/**
 * @bank/pdf-renderer — turns a parsed CreditReport + Scorecard into a luxury PDF.
 *
 *   renderBankPdf({ report, scorecard, client, outputPath })
 */

import Handlebars from "handlebars";
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type {
  Account,
  Bureau,
  BureauAccountDetail,
  CreditReport,
} from "@bank/parsers";
import type { Scorecard, Verdict } from "@bank/funding-rules";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, "template.hbs");
const SAMPLE_DIR = resolve(__dirname, "..", "sample");
const DEFAULT_LOGO = resolve(SAMPLE_DIR, "arvantis-logo.png");

const BUREAU_KEYS: Bureau[] = ["equifax", "experian", "transunion"];

export interface ClientMeta {
  name: string;
  reportDate?: string;
  prepDate?: string;
  preparer?: string;
  phone?: string;
  email?: string;
}

export interface RenderOptions {
  report: CreditReport;
  scorecard: Scorecard;
  client: ClientMeta;
  outputPath: string;
  logoPath?: string;
  /** When true, also writes the rendered HTML next to the PDF for debugging. */
  emitHtml?: boolean;
}

let cachedTemplate: HandlebarsTemplateDelegate | null = null;
let helpersRegistered = false;

function registerHelpersOnce() {
  if (helpersRegistered) return;
  Handlebars.registerHelper("statusIcon", (status: string) => {
    if (status === "pass") return "✓";
    if (status === "fail") return "✗";
    return "—";
  });
  Handlebars.registerHelper("statusLabel", (status: string) => {
    if (!status) return "Unknown";
    return status.charAt(0).toUpperCase() + status.slice(1);
  });
  helpersRegistered = true;
}

async function loadTemplate(): Promise<HandlebarsTemplateDelegate> {
  if (cachedTemplate) return cachedTemplate;
  registerHelpersOnce();
  const src = await readFile(TEMPLATE_PATH, "utf8");
  cachedTemplate = Handlebars.compile(src, { noEscape: false });
  return cachedTemplate;
}

async function logoAsDataUrl(logoFsPath: string): Promise<string> {
  // Embed the logo as base64 so the renderer doesn't depend on file:// loads
  // (Playwright's setContent runs at about:blank and blocks file:// fetches).
  const buf = await readFile(logoFsPath);
  const ext = logoFsPath.split(".").pop()?.toLowerCase() ?? "png";
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "svg"
      ? "image/svg+xml"
      : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export async function renderBankPdf(opts: RenderOptions): Promise<void> {
  const logoSrc = await logoAsDataUrl(opts.logoPath ?? DEFAULT_LOGO);
  const view = buildViewModel(opts, logoSrc);
  const tpl = await loadTemplate();
  const html = tpl(view);

  if (opts.emitHtml) {
    await writeFile(opts.outputPath.replace(/\.pdf$/i, ".html"), html, "utf8");
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "screen" });
    await page.pdf({
      path: opts.outputPath,
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  } finally {
    await browser.close();
  }
}

// ── View-model construction ───────────────────────────────────────

function buildViewModel(opts: RenderOptions, logoPath: string) {
  const { report, scorecard, client } = opts;

  const verdictClass = verdictClassName(scorecard.verdict);
  const verdictHeadlineHtml = formatVerdictHeadline(scorecard);

  const negatives = report.accounts.filter((a) => a.isNegative);
  const negativesList = negatives.map((a) => ({
    creditor: a.creditor,
    categoryLabel: humanCategory(a.category),
  }));
  const negativesDetailed = negatives
    .slice(0, MAX_NEG_DETAILED)
    .map((a) => negativeCard(a));

  const positives = buildPositives(report);
  const hasNegatives = negatives.length > 0;

  const strengthsPages = positives.pages.length;
  const pageTotal = 3 + (hasNegatives ? 1 : 0) + strengthsPages;
  const strengthsSectionNum = hasNegatives ? "04" : "03";
  const strengthsStartPage = 3 + (hasNegatives ? 1 : 0) + 1;

  // Stamp each positives page with its absolute page number so the footer is correct.
  positives.pages.forEach((p, idx) => {
    (p as any).pageNum = strengthsStartPage + idx;
  });

  const path = buildPath(scorecard);

  return {
    client: {
      name: client.name,
      reportDate: client.reportDate ?? report.reportDate ?? "—",
      prepDate: client.prepDate ?? formatToday(),
      preparer: client.preparer ?? "Your Name",
      phone: client.phone ?? "",
      email: client.email ?? "",
    },
    logoPath,
    verdictClass,
    verdictHeadlineHtml,
    verdictSubtext: scorecard.verdictSubtext,
    fundingRange: scorecard.fundingRange,
    criteria: scorecard.criteria,
    hasNegatives,
    negativeCount: negatives.length,
    negativesList,
    negativesDetailed,
    positives,
    strengthsSectionNum,
    pageTotal,
    path,
  };
}

function verdictClassName(v: Verdict): string {
  if (v === "qualified") return "qualified";
  if (v === "ideal") return "ideal";
  return "";
}

function formatVerdictHeadline(s: Scorecard): string {
  if (s.verdict === "refer-credit-repair") {
    return "Refer to <strong>Credit Repair</strong>";
  }
  if (s.verdict === "qualified") {
    return "Qualified for <strong>Funding</strong>";
  }
  return "<strong>Ideal Profile</strong> · Max Funding";
}

const MAX_NEG_DETAILED = 4;

function negativeCard(a: Account) {
  return {
    creditor: a.creditor,
    categoryLabel: humanCategory(a.category),
    cells: {
      reported: bureauValues(a, (d) => (d ? "Yes" : "No")),
      status: bureauValues(a, (d) =>
        d?.paymentStatus ?? d?.accountStatus ?? "—"
      ),
      balance: bureauValues(a, (d) => moneyOrDash(d?.balance)),
      pastDue: bureauValues(a, (d) => moneyOrDash(d?.pastDue)),
      dateOpened: bureauValues(a, (d) => d?.dateOpened ?? "—"),
    },
  };
}

const POSITIVES_CAP = 20;
const POSITIVES_FIRST_PAGE = 4; // section header takes space, fewer cards
const POSITIVES_CONT_PAGE = 5;  // continuation pages have just a header, more cards

function buildPositives(report: CreditReport) {
  // Only open accounts in good standing. No closed-paid filler, no aggregate stats.
  const open = report.accounts.filter(
    (a) => !a.isNegative && a.category === "current"
  );

  const sorted = open.sort((a, b) => maxLimit(b) - maxLimit(a));
  const detailed = sorted.slice(0, POSITIVES_CAP).map((a) => positiveCard(a));
  const overflowCount = Math.max(0, sorted.length - POSITIVES_CAP);

  const overflowLabel =
    overflowCount > 0
      ? `+ ${overflowCount} additional open account${overflowCount === 1 ? "" : "s"} on file (not shown for space).`
      : null;

  // Chunk into pages. First page fits fewer cards because of the section title.
  const pages: Array<{ cards: ReturnType<typeof positiveCard>[]; isFirst: boolean; isLast: boolean }> = [];
  if (detailed.length === 0) {
    pages.push({ cards: [], isFirst: true, isLast: true });
  } else {
    let i = 0;
    let firstPage = true;
    while (i < detailed.length) {
      const limit = firstPage ? POSITIVES_FIRST_PAGE : POSITIVES_CONT_PAGE;
      const chunk = detailed.slice(i, i + limit);
      i += limit;
      pages.push({ cards: chunk, isFirst: firstPage, isLast: i >= detailed.length });
      firstPage = false;
    }
  }

  return {
    pages,
    overflowLabel,
    isEmpty: open.length === 0,
    totalOpen: open.length,
  };
}

function positiveCard(a: Account) {
  return {
    creditor: a.creditor,
    typeLabel: typeLabel(a),
    isOpen: a.category === "current",
    cells: {
      reported: bureauValues(a, (d) => (d ? "Yes" : "No")),
      status: bureauValues(a, (d) =>
        d?.paymentStatus ?? d?.accountStatus ?? "—"
      ),
      limit: bureauValues(a, (d) => moneyOrDash(d?.creditLimit)),
      balance: bureauValues(a, (d) => moneyOrDash(d?.balance)),
      util: bureauValues(a, (d) => utilString(d)),
    },
  };
}

function hasType(a: Account, kind: string): boolean {
  for (const b of BUREAU_KEYS) {
    const t = a.bureaus[b]?.accountType;
    if (t && t.toUpperCase().includes(kind)) return true;
  }
  return false;
}

function formatMonths(m: number): string {
  if (m < 12) return `${m}m`;
  const y = Math.floor(m / 12);
  const rem = m % 12;
  if (rem === 0) return `${y}y`;
  return `${y}y ${rem}m`;
}

function buildPath(s: Scorecard) {
  if (s.verdict === "refer-credit-repair") {
    return {
      today: {
        headline: "Not Fundable",
        meta: `${s.failCount} hard fail${s.failCount === 1 ? "" : "s"} · refer to credit repair`,
        bullets: [
          "Hard fails block all unsecured funding paths",
          "Score and/or negative items below underwriting thresholds",
          "Open account count or age may also miss minimums",
          "File needs cleanup before lenders will engage",
        ],
      },
      next: {
        tag: "After Cleanup · 90-120 days",
        headline: "$30K-$75K Range",
        meta: "Qualified profile · standard funding stack",
        bullets: [
          "Once negatives are removed, scores typically lift 40-90 points",
          "Open 1-2 secured cards to push to 3+ active accounts",
          "Aggressive paydown on installment loans helps utilization",
          "Push existing tradelines to report on all 3 bureaus",
        ],
      },
      stretch: {
        tag: "Stretch · 6-12 months",
        headline: "$75K+ Max Funding",
        meta: "Ideal profile · premium funding stack",
        bullets: [
          "Add 2+ AUs on aged accounts (5+ years) to lift average age",
          "Build to 5+ open personal accounts",
          "One personal card with $15K+ limit (graduated Discover or Capital One)",
          "2+ year LLC if pursuing business funding",
        ],
      },
      recommendation: {
        headline: "Enroll in your credit repair program.",
        body: "Bank's analysis identifies the exact items requiring cleanup before they're funding-ready. The credit repair team handles the disputes, negotiations, and removals. Re-run Bank in 90 days to re-evaluate funding readiness.",
      },
    };
  }

  if (s.verdict === "qualified") {
    return {
      today: {
        headline: "Qualified · $30K-$75K",
        meta: "Standard funding stack approachable",
        bullets: [
          "All hard criteria met across the bureaus",
          "Eligible for unsecured personal & business funding",
          s.mixedCount > 0
            ? `${s.mixedCount} item${s.mixedCount === 1 ? "" : "s"} flagged for upgrade — addressable`
            : "Clean across the board",
          "Underwriters can engage now, not 90 days from now",
        ],
      },
      next: {
        tag: "Upgrade · 30-60 days",
        headline: "Tighten the Profile",
        meta: "Push from qualified into ideal range",
        bullets: [
          "Resolve any mixed-status criteria (per-bureau gaps)",
          "Build per-card utilization to <10% on cycle close",
          "Add a $10K+ tradeline if not already present",
          "Verify all positive accounts report to all 3 bureaus",
        ],
      },
      stretch: {
        tag: "Premium · 6-12 months",
        headline: "$75K+ Max Funding",
        meta: "Ideal profile · premium funding stack",
        bullets: [
          "Average account age 5+ years",
          "5+ open personal accounts in good standing",
          "Personal card with $15K+ limit",
          "2+ year LLC if pursuing business funding",
        ],
      },
      recommendation: {
        headline: "Move to funding strategy.",
        body: "Profile clears the qualification floor. Recommend stacking 2-3 personal cards or a personal + business funding combination. Re-evaluate after the upgrade items above to push into the ideal $75K+ range.",
      },
    };
  }

  return {
    today: {
      headline: "Ideal Profile · Max Funding",
      meta: "Premium funding stack · all PASS",
      bullets: [
        "Every criterion clears the ideal threshold",
        "Top-tier underwriting eligibility on personal & business",
        "No remediation needed — execute the funding plan",
        "Profile defends against the toughest lender pulls",
      ],
    },
    next: {
      tag: "Stack · 0-30 days",
      headline: "Maximize Stack",
      meta: "Pull personal + business in parallel",
      bullets: [
        "Personal card stacking — 3-5 issuers in 14-day windows",
        "Business funding — pull on aged LLC if available",
        "Velocity banking against personal limits for cash flow",
        "Maintain <10% per-card utilization through funding rounds",
      ],
    },
    stretch: {
      tag: "Long Game · 6-12 months",
      headline: "Build Toward $150K+",
      meta: "Premium-tier portfolio target",
      bullets: [
        "Graduate cards to $20K+ limits via APRs and CLIs",
        "Add a business credit card profile (Amex Business, Chase Ink)",
        "Establish business credit (Dun & Bradstreet, Experian Business)",
        "Use velocity banking to defend personal scores under aggressive stacking",
      ],
    },
    recommendation: {
      headline: "Execute the funding plan.",
      body: "Profile is ready. Pull personal funding stack now, then layer in business funding 30-45 days after. Bank's analysis confirms the file will hold through aggressive underwriting.",
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────

function bureauValues<T>(a: Account, fn: (d: BureauAccountDetail | undefined) => T) {
  return {
    equifax: fn(a.bureaus.equifax),
    experian: fn(a.bureaus.experian),
    transunion: fn(a.bureaus.transunion),
  };
}

function moneyOrDash(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return "$" + n.toLocaleString("en-US");
}

function utilString(d: BureauAccountDetail | undefined): string {
  if (!d) return "—";
  const limit = d.creditLimit ?? 0;
  const balance = d.balance ?? 0;
  if (limit === 0) return "—";
  const pct = Math.round((balance / limit) * 100);
  return `${pct}%`;
}

function maxLimit(a: Account): number {
  let max = 0;
  for (const b of BUREAU_KEYS) {
    const v = a.bureaus[b]?.creditLimit ?? 0;
    if (v > max) max = v;
  }
  return max;
}

function typeLabel(a: Account): string {
  for (const b of BUREAU_KEYS) {
    const t = a.bureaus[b]?.accountType;
    if (t) {
      const upper = t.toUpperCase();
      if (upper.includes("REVOLVING")) return "Revolving Card · Open";
      if (upper.includes("INSTALLMENT")) return "Installment Loan · Open";
      if (upper.includes("MORTGAGE")) return "Mortgage · Open";
      return `${capitalize(t)} · Open`;
    }
  }
  return "Account · Open";
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function humanCategory(c: string): string {
  switch (c) {
    case "collection": return "Collection";
    case "chargeoff": return "Charge-Off";
    case "foreclosure": return "Foreclosure";
    case "repossession": return "Repossession";
    case "bankruptcy": return "Bankruptcy";
    case "late30": return "30 Days Late";
    case "late60": return "60 Days Late";
    case "late90": return "90 Days Late";
    case "late120": return "120 Days Late";
    case "late150": return "150 Days Late";
    case "settled": return "Settled";
    case "transferred": return "Transferred";
    case "closed": return "Closed";
    case "current": return "Current";
    default: return capitalize(c);
  }
}

function formatToday(): string {
  const d = new Date();
  return d
    .toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" })
    .toUpperCase();
}
