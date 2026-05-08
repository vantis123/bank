/**
 * FSN / MFSN downloaded PDF format parser.
 *
 * When a member clicks "Print Selected Document" on MFSN, the page generates
 * a downloadable PDF in a structured format with:
 *   - "Three Bureau Credit Report" header
 *   - Numbered table of contents (1. Report Summary, 2. Revolving Accounts, ...)
 *   - Per-bureau Account Summary tables
 *   - Per-account sections with bureau-concatenated values
 *   - "EquifaxExperianTransUnion" bureau header (note: EQ/EX/TU order, NOT IIQ's TU/EX/EQ)
 *
 * This is the most common path — 3 of 4 test clients hit this format.
 * Format detection: presence of "Three Bureau Credit Report" + "EquifaxExperianTransUnion".
 */

import {
  type Account,
  type AccountCategory,
  type Bureau,
  type BureauAccountDetail,
  type BureauSummary,
  type CreditReport,
  type Inquiry,
  type PublicRecord,
} from "./types.ts";
import {
  categorizeBureau,
  isNegativeCategory,
  parseDollar,
  rollupCategory,
  splitEqualOrNull,
} from "./shared.ts";

/** Bureau column order in the downloaded PDF format: Equifax / Experian / TransUnion */
const BUREAU_ORDER: readonly Bureau[] = ["equifax", "experian", "transunion"] as const;

const BUREAU_HEADER = "EquifaxExperianTransUnion";

export function isFSNPdfFormat(text: string): boolean {
  return /Three Bureau Credit Report/i.test(text) && /EquifaxExperianTransUnion/i.test(text);
}

export function parseFSNPDF(text: string): CreditReport {
  const report: CreditReport = {
    platform: "fsn",
    reportDate: null,
    referenceNumber: null,
    scores: { equifax: null, experian: null, transunion: null },
    summary: { equifax: {}, experian: {}, transunion: {} },
    accounts: [],
    inquiries: [],
    publicRecords: [],
    personalInfo: {},
    warnings: [],
    errors: [],
  };

  if (!isFSNPdfFormat(text)) {
    report.errors.push("Not a downloaded MFSN PDF format");
    return report;
  }

  const lines = text.split("\n").map((l) => l.trim());

  // ── Report date (e.g., "Brandon W Bailer | February 27, 2026") ──
  for (const line of lines.slice(0, 30)) {
    const m = line.match(/\|\s*(.+\d{4})$/);
    if (m) {
      report.reportDate = m[1]?.trim() ?? null;
      break;
    }
  }

  // ── Scores ──
  // Pattern: bureau name on one line, ranking number, score, rating
  // "Equifax\n1\n663\nGood\nExperian\n2\n651\nFair\nTransUnion\n3\n615\nFair"
  parseScoresFromBureauBlocks(lines, report);

  // ── Per-bureau summary ──
  parseBureauSummaries(lines, report);

  // ── Accounts ──
  parseAccountSections(lines, report);

  // ── Inquiries + Public Records ──
  parseInquiries(lines, report);
  parsePublicRecords(lines, report);

  return report;
}

function parseScoresFromBureauBlocks(lines: string[], report: CreditReport): void {
  // Find the score block — typically appears once near the top, where each bureau is followed by:
  //   <ranking> <score> <rating>
  // E.g., "Equifax", "1", "663", "Good"
  for (let i = 0; i < Math.min(lines.length - 4, 200); i++) {
    if (lines[i] !== "Equifax") continue;
    if (!/^[1-3]$/.test(lines[i + 1] ?? "")) continue;
    if (!/^\d{3}$/.test(lines[i + 2] ?? "")) continue;
    if (!/^(Excellent|Good|Fair|Poor|Very Poor)$/i.test(lines[i + 3] ?? "")) continue;
    // Found the score block — read all 3 bureaus
    const eqScore = parseInt(lines[i + 2]!, 10);
    if (eqScore >= 300 && eqScore <= 850) report.scores.equifax = eqScore;

    // Now find Experian
    for (let j = i + 4; j < Math.min(i + 30, lines.length - 3); j++) {
      if (lines[j] === "Experian" && /^[1-3]$/.test(lines[j + 1] ?? "") && /^\d{3}$/.test(lines[j + 2] ?? "")) {
        const exScore = parseInt(lines[j + 2]!, 10);
        if (exScore >= 300 && exScore <= 850) report.scores.experian = exScore;
        break;
      }
    }
    for (let j = i + 4; j < Math.min(i + 30, lines.length - 3); j++) {
      if (lines[j] === "TransUnion" && /^[1-3]$/.test(lines[j + 1] ?? "") && /^\d{3}$/.test(lines[j + 2] ?? "")) {
        const tuScore = parseInt(lines[j + 2]!, 10);
        if (tuScore >= 300 && tuScore <= 850) report.scores.transunion = tuScore;
        break;
      }
    }
    break;
  }

  if (!report.scores.equifax) report.warnings.push("Missing equifax score");
  if (!report.scores.experian) report.warnings.push("Missing experian score");
  if (!report.scores.transunion) report.warnings.push("Missing transunion score");
}

/**
 * Parse the per-bureau summary tables.
 * Pattern: after "EquifaxExperianTransUnion" header, fields appear with values
 * concatenated for the 3 bureaus (e.g., "Average Account Age9 Years8 Years7 Years").
 */
function parseBureauSummaries(lines: string[], report: CreditReport): void {
  // Find the first "Equifax Accounts Summary" or similar
  const summaryIdx = lines.findIndex((l) => /Accounts Summary/i.test(l));
  if (summaryIdx === -1) return;

  // Look for "EquifaxExperianTransUnion" header within reasonable distance
  let headerIdx = -1;
  for (let i = summaryIdx; i < Math.min(summaryIdx + 80, lines.length); i++) {
    if (lines[i] === BUREAU_HEADER) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return;

  // Walk forward, looking for known summary fields
  const SUMMARY_FIELDS: Array<{ label: string; key: keyof BureauSummary; isDollar?: boolean }> = [
    { label: "Open Accounts", key: "openAccounts" },
    { label: "Closed Accounts", key: "closedAccounts" },
    { label: "Total Accounts", key: "totalAccounts" },
    { label: "Total Balance", key: "totalBalance", isDollar: true },
    { label: "Public Records", key: "publicRecords" },
    { label: "Inquiries", key: "inquiries" },
    { label: "Inquiries (2 Years)", key: "inquiries" },
    { label: "Total Credit Limit", key: "totalCreditLimit", isDollar: true },
    { label: "Total Available Credit", key: "totalAvailableCredit", isDollar: true },
  ];

  for (let i = headerIdx + 1; i < Math.min(headerIdx + 60, lines.length); i++) {
    const line = lines[i] ?? "";
    if (line === BUREAU_HEADER) continue; // header may repeat
    if (/Accounts Summary|Score and Rating|Factors affecting/i.test(line)) break;

    for (const field of SUMMARY_FIELDS) {
      // Some lines: "Open Accounts134"
      // Others: "Open Accounts" then on next line "1\n3\n4"
      if (line === field.label || line.startsWith(field.label)) {
        // Inline value pattern: "Total Accounts3845"
        const inlineRest = line.slice(field.label.length).trim();
        if (inlineRest) {
          assignFromConcat(field, inlineRest, report);
          break;
        }
        // Or value is on next non-empty line
        const v = nextNonEmptyValue(lines, i + 1, 6);
        if (v) {
          assignFromConcat(field, v, report);
          break;
        }
      }
    }
  }
}

function nextNonEmptyValue(lines: string[], startIdx: number, maxAhead: number): string | null {
  for (let i = startIdx; i < Math.min(startIdx + maxAhead, lines.length); i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function assignFromConcat(
  field: { key: keyof BureauSummary; isDollar?: boolean },
  value: string,
  report: CreditReport
): void {
  if (field.isDollar) {
    // "$X$Y$Z" → 3 dollar values
    const parts = value.split("$").filter(Boolean);
    if (parts.length === 3) {
      const [eq, ex, tu] = parts.map(parseDollar);
      if (eq !== null) (report.summary.equifax as any)[field.key] = eq;
      if (ex !== null) (report.summary.experian as any)[field.key] = ex;
      if (tu !== null) (report.summary.transunion as any)[field.key] = tu;
    }
    return;
  }
  // Non-dollar: try to split equally if length divisible by 3
  const cleaned = value.replace(/[^\d]/g, "");
  if (cleaned.length > 0 && cleaned.length <= 9) {
    // Try equal split
    const split = splitEqualOrNull(cleaned);
    if (split) {
      const [eq, ex, tu] = split.map((s) => parseInt(s, 10));
      if (Number.isFinite(eq)) (report.summary.equifax as any)[field.key] = eq;
      if (Number.isFinite(ex)) (report.summary.experian as any)[field.key] = ex;
      if (Number.isFinite(tu)) (report.summary.transunion as any)[field.key] = tu;
    } else {
      report.warnings.push(`Summary ${String(field.key)}: ambiguous "${cleaned}"`);
    }
  }
}

/**
 * Account sections look like:
 *   "4.1 Florida Institute Of (CLOSED)" — account header (numbered, optional CLOSED)
 *   ... description text ...
 *   "EquifaxExperianTransUnion" — bureau header
 *   "ReportedYesNoYes" — per-bureau reporting flag
 *   "Account Numberxxx 4AU7N/Axxx 4AU7" — 3 account numbers
 *   "Account StatusClosedN/AClosed" — 3 statuses
 *   "Credit Limit$0N/A$0" — 3 limits
 *   "Reported Balance$0N/A$0" — 3 balances
 *   ...
 */
function parseAccountSections(lines: string[], report: CreditReport): void {
  const sectionStarts: Array<{ idx: number; title: string; isClosed: boolean }> = [];
  // Match patterns like "4.1 Florida Institute Of (CLOSED)", "2.1 Capital One Bank Usa6"
  // The trailing digit is page reference, ignore. The (CLOSED) marker is optional.
  const sectionHeaderRe = /^([1-9]\d?)\.(\d+)\s+(.+?)(?:\s*\(([A-Z]+)\))?(?:\d+)?$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(sectionHeaderRe);
    if (!m) continue;
    const major = parseInt(m[1]!, 10);
    if (major < 2 || major > 8) continue; // section 2-7 are account sections; skip TOC + others
    // Skip TOC entries — they reference page numbers like "(CLOSED)5" with trailing page num
    // Heuristic: TOC entries appear in the first ~80 lines, body sections appear later
    const title = m[3]!.trim();
    const statusMarker = m[4];
    if (!title) continue;
    // Skip if this is a TOC line — look at neighboring lines for body markers
    const next20 = lines.slice(i + 1, i + 20).join("\n");
    const isBody = /Payment History|Account Number|Account Status|Reported Balance|Credit Limit/i.test(next20);
    if (!isBody) continue;
    // Avoid duplicates — only add if this title hasn't appeared yet
    if (sectionStarts.some((s) => s.title === title && Math.abs(s.idx - i) < 100)) continue;
    sectionStarts.push({
      idx: i,
      title,
      isClosed: statusMarker === "CLOSED",
    });
  }

  // Define each section's slice
  for (let k = 0; k < sectionStarts.length; k++) {
    const start = sectionStarts[k]!;
    const endIdx = sectionStarts[k + 1]?.idx ?? Math.min(start.idx + 200, lines.length);
    const account = parseAccountSection(lines, start.idx, endIdx, start.title, start.isClosed);
    if (account) report.accounts.push(account);
  }
}

function parseAccountSection(
  lines: string[],
  startIdx: number,
  endIdx: number,
  title: string,
  isClosed: boolean
): Account | null {
  // Find the EquifaxExperianTransUnion bureau header within the section
  let headerIdx = -1;
  for (let i = startIdx; i < endIdx; i++) {
    if (lines[i] === BUREAU_HEADER) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  // Walk forward extracting fields
  const fields = new Map<string, string>();
  const FIELD_LABELS = [
    "Reported",
    "Account Number",
    "Account Type",
    "Account Status",
    "Account Ownership",
    "Date Opened",
    "Date Last Active",
    "Date Last Reported",
    "Date Last Payment",
    "Last Reported",
    "Credit Limit",
    "Reported Balance",
    "Balance",
    "Past Due Amount",
    "Past Due",
    "High Balance",
    "Charge Off Amount",
    "Months Reviewed",
    "Monthly Payment",
    "Last Activity",
  ];

  for (let i = headerIdx + 1; i < endIdx; i++) {
    const line = lines[i] ?? "";
    if (!line) continue;
    if (line === BUREAU_HEADER) continue;
    // Skip year row patterns (Year + month columns)
    if (/^Year/.test(line) && line.length > 30) continue;

    for (const label of FIELD_LABELS) {
      if (!line.startsWith(label)) continue;
      const value = line.slice(label.length).trim();
      if (value && !fields.has(label)) {
        fields.set(label, value);
      }
      break;
    }
  }

  // Build per-bureau details
  const bureaus: Partial<Record<Bureau, BureauAccountDetail>> = {};
  const perBureauCat: Partial<Record<Bureau, AccountCategory>> = {};

  // Account Number is concatenated with potentially "N/A" markers
  // e.g., "xxxxxxxxxxxxxxxx 4AU7N/Axxxxxxxxxxxxxx 4AU7"
  const accountNumberRaw = fields.get("Account Number") ?? "";
  const accountNumberParts = splitConcatField(accountNumberRaw);

  // Account Status: "ClosedN/AClosed" or "OpenN/AOpen"
  const accountStatusParts = splitConcatField(fields.get("Account Status") ?? "");

  // Credit Limit: "$0N/A$0" → ["$0", "N/A", "$0"]
  const creditLimitParts = splitConcatField(fields.get("Credit Limit") ?? "");
  const reportedBalanceParts = splitConcatField((fields.get("Reported Balance") ?? "") || (fields.get("Balance") ?? ""));
  const pastDueParts = splitConcatField(fields.get("Past Due Amount") ?? fields.get("Past Due") ?? "");
  const monthlyPaymentParts = splitConcatField(fields.get("Monthly Payment") ?? "");
  const dateOpenedParts = splitConcatField(fields.get("Date Opened") ?? "");
  const dateLastActiveParts = splitConcatField(fields.get("Date Last Active") ?? fields.get("Last Activity") ?? "");
  const lastReportedParts = splitConcatField(fields.get("Date Last Reported") ?? fields.get("Last Reported") ?? "");

  // Get the entire section text for keyword scanning
  const sectionText = lines.slice(startIdx, endIdx).join("\n");

  for (let bIdx = 0; bIdx < BUREAU_ORDER.length; bIdx++) {
    const bureau = BUREAU_ORDER[bIdx]!;
    const detail: BureauAccountDetail = {
      accountNumber: cleanNA(accountNumberParts[bIdx]),
      accountStatus: cleanNA(accountStatusParts[bIdx]),
      creditLimit: parseDollar(creditLimitParts[bIdx]),
      balance: parseDollar(reportedBalanceParts[bIdx]),
      pastDue: parseDollar(pastDueParts[bIdx]),
      monthlyPayment: parseDollar(monthlyPaymentParts[bIdx]),
      dateOpened: cleanNA(dateOpenedParts[bIdx]),
      lastPayment: cleanNA(dateLastActiveParts[bIdx]),
      lastReported: cleanNA(lastReportedParts[bIdx]),
    };
    bureaus[bureau] = detail;
    perBureauCat[bureau] = categorizeFromSectionContext(detail, sectionText, isClosed);
  }

  const category = rollupCategory(perBureauCat);

  // Apply title-based override: if title says (CLOSED) and category is unknown, mark as closed
  let finalCategory: AccountCategory = category;
  if (category === "unknown") {
    if (isClosed) finalCategory = "closed";
    else finalCategory = "current";
  }

  return {
    creditor: title,
    category: finalCategory,
    isNegative: isNegativeCategory(finalCategory),
    bureaus,
  };
}

/**
 * Split a 3-bureau concatenated field. Handles N/A markers.
 * E.g., "xxx 4AU7N/Axxx 4AU7" → ["xxx 4AU7", "N/A", "xxx 4AU7"]
 *       "ClosedN/AClosed" → ["Closed", "N/A", "Closed"]
 *       "$0N/A$0" → ["$0", "N/A", "$0"]
 */
function splitConcatField(s: string): [string, string, string] {
  if (!s) return ["", "", ""];
  const trimmed = s.trim();

  // Look for N/A separators
  const naPattern = /N\/A/g;
  const naMatches = [...trimmed.matchAll(naPattern)];

  if (naMatches.length > 0) {
    // Split on N/A markers — at least one bureau didn't report
    // Find positions of N/A and split around them
    const parts: string[] = [];
    let lastIdx = 0;
    for (const match of naMatches) {
      const before = trimmed.slice(lastIdx, match.index!);
      if (before) parts.push(before);
      parts.push("N/A");
      lastIdx = match.index! + 3;
    }
    const after = trimmed.slice(lastIdx);
    if (after) parts.push(after);

    // Pad to 3 parts if needed
    while (parts.length < 3) parts.push("");
    return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
  }

  // No N/A — try equal split if length divisible by 3
  if (trimmed.length % 3 === 0 && trimmed.length > 0) {
    const len = trimmed.length / 3;
    const a = trimmed.slice(0, len);
    const b = trimmed.slice(len, len * 2);
    const c = trimmed.slice(len * 2);
    if (a === b && b === c) {
      return [a, b, c];
    }
  }

  // Fall back: assign whole value to all 3
  return [trimmed, trimmed, trimmed];
}

function cleanNA(s: string | undefined): string | undefined {
  if (!s) return undefined;
  if (s === "N/A" || s === "" || s === "--") return undefined;
  return s;
}

function categorizeFromSectionContext(
  detail: BureauAccountDetail,
  sectionText: string,
  isClosedHeader: boolean
): AccountCategory {
  // Section-text keyword scanning
  if (sectionText) {
    if (/COLLECTION/i.test(sectionText)) return "collection";
    if (/CHARGED?\s*-?OFF|CHARGE.?OFF/i.test(sectionText) && !/CHARGE OFF AMOUNT[\s$]*0/i.test(sectionText)) {
      // Check if charge-off is a real flag, not just a "$0" placeholder
      if (/CHARGE.?OFF/i.test(sectionText)) return "chargeoff";
    }
    if (/FORECLOSURE/i.test(sectionText)) return "foreclosure";
    if (/REPOSSESS/i.test(sectionText)) return "repossession";
    if (/BANKRUPT/i.test(sectionText)) return "bankruptcy";

    if (/150 days late|150\+/i.test(sectionText)) return "late150";
    if (/120 days late/i.test(sectionText)) return "late120";
    if (/90 days late/i.test(sectionText)) return "late90";
    if (/60 days late/i.test(sectionText)) return "late60";
    if (/30 days late/i.test(sectionText)) return "late30";
  }

  // Past Due > 0 = negative
  if ((detail.pastDue ?? 0) > 0) return "late30";

  // Charge Off Amount > 0 = chargeoff
  if ((detail.chargeOffAmount ?? 0) > 0) return "chargeoff";

  // Status fallback
  if (detail.accountStatus) {
    const s = detail.accountStatus.toLowerCase();
    if (s.includes("collection")) return "collection";
    if (s.includes("charge")) return "chargeoff";
    if (s.includes("late")) return "late30";
    if (s === "closed") {
      // Closed alone isn't necessarily negative — but if past due / charge off / collection markers exist
      return "closed";
    }
    if (s === "open") return "current";
  }

  if (isClosedHeader) return "closed";
  return "unknown";
}

function parseInquiries(lines: string[], report: CreditReport): void {
  // Find "9. Inquiries" section
  const inqIdx = lines.findIndex((l) => /^9\.\s*Inquiries/i.test(l));
  if (inqIdx === -1) return;

  // Walk forward looking for inquiry entries until next major section
  for (let i = inqIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^1[0-9]\.\s/.test(line)) break; // hit "10. Public Records" etc

    // Date pattern at start of line indicates an inquiry
    const m = line.match(/^([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})\s*(.*)$/);
    if (m) {
      report.inquiries.push({
        bureau: "equifax", // bureau detection requires more context
        creditor: m[2]?.trim() || "Unknown",
        date: m[1] ?? "",
      });
    }
  }
}

function parsePublicRecords(lines: string[], report: CreditReport): void {
  const prIdx = lines.findIndex((l) => /^10\.\s*Public Records/i.test(l));
  if (prIdx === -1) return;

  for (let i = prIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^1[1-9]\.\s/.test(line)) break;
    if (/^\d+\.\d+\s/.test(line)) {
      // sub-section like "10.1 Bankruptcy"
      const title = line.replace(/^\d+\.\d+\s/, "").trim();
      report.publicRecords.push({
        bureau: "equifax",
        type: title,
      });
    }
  }
}
