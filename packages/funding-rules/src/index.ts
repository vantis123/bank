/**
 * @bank/funding-rules — Phillip's funding qualification rules.
 *
 * Takes a parsed CreditReport, computes a Scorecard with 8 criteria
 * graded per bureau, and a top-level verdict.
 *
 *   QUALIFIED minimum (any FAIL → refer to credit repair):
 *     - Credit score 680+ (lowest of 3 bureaus)
 *     - No negative items (collections, charge-offs, bankruptcies)
 *     - No late payments in last 24 months
 *     - 3+ open personal accounts
 *     - Average account age 3+ years
 *     - Per-card utilization under 30%
 *     - At least one credit card with $5K+ limit
 *     - At least one credit card with $10K+ limit (AU acceptable)
 *
 *   QUALIFIED → $30K-$75K range
 *   IDEAL (all PASS, plus stricter thresholds) → $75K+
 */

import type {
  Account,
  Bureau,
  CreditReport,
} from "@bank/parsers";

export type CriterionStatus = "pass" | "fail" | "mixed" | "unknown";
export type Verdict = "refer-credit-repair" | "qualified" | "ideal";

export interface BureauGrade {
  value: string; // human-readable display value (e.g. "629", "1y 8m", "$7,600", "—")
  status: "pass" | "fail" | "unknown";
}

export interface CriterionGrade {
  id: string;
  label: string; // 5th-grader friendly criterion text
  hint?: string; // one-line explanation
  status: CriterionStatus;
  bureaus: Record<Bureau, BureauGrade>;
}

export interface Scorecard {
  verdict: Verdict;
  verdictHeadline: string; // "Refer to Credit Repair" / "Qualified — $30K-$75K Range" / "Ideal Profile — $75K+ Max Funding"
  verdictSubtext: string;
  fundingRange: string; // "$0" / "$30K-$75K" / "$75K+"
  criteria: CriterionGrade[];
  passCount: number;
  failCount: number;
  mixedCount: number;
}

const BUREAUS: readonly Bureau[] = ["equifax", "experian", "transunion"] as const;

// Criteria that gate the funding verdict (the QUALIFIED minimum). If any of
// these fails, is mixed across bureaus, or can't be read (unknown), the client
// must be referred to credit repair — a funding tool fails CLOSED, never grades
// missing or negative data as fundable. Inquiries is informational, not gating.
const GATING_CRITERIA_IDS = new Set([
  "credit-score",
  "negatives",
  "no-lates-24mo",
  "open-accounts",
  "avg-age-3yr",
  "per-card-utilization",
  "card-5k",
  "card-10k",
]);

const NEGATIVE_CATEGORIES = new Set([
  "collection",
  "chargeoff",
  "foreclosure",
  "repossession",
  "bankruptcy",
]);

const LATE_CATEGORIES = new Set([
  "late30",
  "late60",
  "late90",
  "late120",
  "late150",
]);

export function computeScorecard(report: CreditReport): Scorecard {
  const criteria: CriterionGrade[] = [
    creditScoreCriterion(report),
    negativesCriterion(report),
    latesCriterion(report),
    inquiriesCriterion(report),
    openAccountsCriterion(report),
    accountAgeCriterion(report),
    utilizationCriterion(report),
    card5kCriterion(report),
    card10kCriterion(report),
  ];

  const passCount = criteria.filter((c) => c.status === "pass").length;
  const failCount = criteria.filter((c) => c.status === "fail").length;
  const mixedCount = criteria.filter((c) => c.status === "mixed").length;

  const verdict = computeVerdict(criteria);
  const { verdictHeadline, verdictSubtext, fundingRange } = formatVerdict(verdict, failCount, mixedCount);

  return {
    verdict,
    verdictHeadline,
    verdictSubtext,
    fundingRange,
    criteria,
    passCount,
    failCount,
    mixedCount,
  };
}

function computeVerdict(criteria: CriterionGrade[]): Verdict {
  const gating = criteria.filter((c) => GATING_CRITERIA_IDS.has(c.id));

  // Fail closed: a gating criterion that fails, is split across bureaus (mixed),
  // or can't be read (unknown, e.g. a thin/failed parse) blocks qualification.
  // A single-bureau collection surfaces here as fail (see negativesCriterion) or
  // mixed — either way the client is referred, never graded qualified.
  const gatingBlocked = gating.some(
    (c) => c.status === "fail" || c.status === "mixed" || c.status === "unknown"
  );
  if (gatingBlocked) return "refer-credit-repair";

  // Ideal requires every criterion (including the informational ones) to pass
  // cleanly across all three bureaus.
  const allPass = criteria.every((c) => c.status === "pass");
  if (allPass) return "ideal";

  // All gating criteria pass, but a non-gating item (e.g. inquiries) is flagged.
  return "qualified";
}

function formatVerdict(
  verdict: Verdict,
  failCount: number,
  mixedCount: number
): { verdictHeadline: string; verdictSubtext: string; fundingRange: string } {
  if (verdict === "refer-credit-repair") {
    return {
      verdictHeadline: "Refer to Credit Repair",
      verdictSubtext: `Client does not currently qualify for funding. ${failCount} criteria fail. Estimated cleanup window: 90-120 days after disputes resolve.`,
      fundingRange: "$0",
    };
  }
  if (verdict === "qualified") {
    return {
      verdictHeadline: "Qualified for Funding",
      verdictSubtext: `Client meets the minimum funding criteria. ${mixedCount > 0 ? `${mixedCount} item${mixedCount > 1 ? "s" : ""} flagged for upgrade.` : "Standard funding stack approachable."}`,
      fundingRange: "$30K-$75K",
    };
  }
  return {
    verdictHeadline: "Ideal Profile — Max Funding",
    verdictSubtext: "Client clears all criteria. Eligible for premium funding stack.",
    fundingRange: "$75K+",
  };
}

// ── Criteria builders ──────────────────────────────────────────────

function creditScoreCriterion(report: CreditReport): CriterionGrade {
  const bureaus = mapBureaus((b) => {
    const score = report.scores[b];
    if (score === null) return { value: "—", status: "unknown" };
    return {
      value: String(score),
      status: score >= 680 ? "pass" : "fail",
    };
  });
  const status = aggregateStatus(bureaus);
  return {
    id: "credit-score",
    label: "Credit score over 680",
    hint: "Lenders use your lowest score",
    status,
    bureaus,
  };
}

function negativesCriterion(report: CreditReport): CriterionGrade {
  const negativeAccounts = report.accounts.filter((a) =>
    NEGATIVE_CATEGORIES.has(a.category)
  );

  const bureaus = mapBureaus((b) => {
    const negsOnBureau = negativeAccounts.filter((a) => a.bureaus[b] !== undefined);
    return {
      value: String(negsOnBureau.length),
      status: negsOnBureau.length === 0 ? "pass" : "fail",
    };
  });
  // Gating: any single-bureau negative is a criterion fail. Do NOT soften a
  // one-bureau collection to "mixed" — that leaked past the refer verdict.
  const status = aggregateGatingStatus(bureaus);
  return {
    id: "negatives",
    label: "No accounts in collections",
    hint: "Collections, charge-offs, or bankruptcies",
    status,
    bureaus,
  };
}

function latesCriterion(report: CreditReport): CriterionGrade {
  // Count accounts with any late-payment category
  const lateAccounts = report.accounts.filter((a) => LATE_CATEGORIES.has(a.category));

  const bureaus = mapBureaus((b) => {
    const latesOnBureau = lateAccounts.filter((a) => a.bureaus[b] !== undefined);
    return {
      value: String(latesOnBureau.length),
      status: latesOnBureau.length === 0 ? "pass" : "fail",
    };
  });
  // Gating: any single-bureau late is a criterion fail (same leak as negatives).
  const status = aggregateGatingStatus(bureaus);
  return {
    id: "no-lates-24mo",
    label: "No late payments in past 2 years",
    hint: "Even one late is a red flag",
    status,
    bureaus,
  };
}

function inquiriesCriterion(report: CreditReport): CriterionGrade {
  const bureaus = mapBureaus((b) => {
    const n = report.summary[b]?.inquiries;
    if (n === undefined || n === null) return { value: "—", status: "unknown" };
    return {
      value: String(n),
      status: n < 2 ? "pass" : "fail",
    };
  });
  const status = aggregateStatus(bureaus);
  return {
    id: "inquiries-under-2",
    label: "Under 2 hard inquiries per bureau",
    hint: "Recent inquiries signal credit shopping",
    status,
    bureaus,
  };
}

function openAccountsCriterion(report: CreditReport): CriterionGrade {
  const bureaus = mapBureaus((b) => {
    const open = report.summary[b]?.openAccounts;
    if (open === undefined) return { value: "—", status: "unknown" };
    return {
      value: String(open),
      status: open >= 3 ? "pass" : "fail",
    };
  });
  const status = aggregateStatus(bureaus);
  return {
    id: "open-accounts",
    label: "At least 3 active credit accounts",
    hint: "Open accounts in good standing",
    status,
    bureaus,
  };
}

function accountAgeCriterion(report: CreditReport): CriterionGrade {
  const bureaus = mapBureaus((b) => {
    const months = report.summary[b]?.averageAgeMonths;
    if (months === undefined || months === null) return { value: "—", status: "unknown" };
    const display = formatMonths(months);
    return {
      value: display,
      status: months >= 36 ? "pass" : "fail", // 3 years
    };
  });
  const status = aggregateStatus(bureaus);
  return {
    id: "avg-age-3yr",
    label: "Accounts open for over 3 years",
    hint: "Average age across all accounts",
    status,
    bureaus,
  };
}

function utilizationCriterion(report: CreditReport): CriterionGrade {
  // Per-card under 30%. We approximate by: any open revolving account with balance > 30% of limit fails.
  const revolvingCards = report.accounts.filter((a) => {
    const anyType = Object.values(a.bureaus)[0]?.accountType;
    return anyType?.toUpperCase().includes("REVOLVING");
  });

  const bureaus = mapBureaus((b) => {
    const cardsOnBureau = revolvingCards
      .map((a) => a.bureaus[b])
      .filter((d): d is NonNullable<typeof d> => !!d && (d.creditLimit ?? 0) > 0);

    if (cardsOnBureau.length === 0) {
      // No revolving cards reporting on this bureau — ambiguous, skip
      return { value: "—", status: "unknown" };
    }

    const overUtilCount = cardsOnBureau.filter((d) => {
      const limit = d.creditLimit ?? 0;
      const balance = d.balance ?? 0;
      if (limit === 0) return false;
      return (balance / limit) * 100 > 30;
    }).length;

    if (overUtilCount === 0) return { value: "All <30%", status: "pass" };
    return { value: `${overUtilCount} card${overUtilCount > 1 ? "s" : ""} >30%`, status: "fail" };
  });
  const status = aggregateStatus(bureaus);
  return {
    id: "per-card-utilization",
    label: "Each card balance under 30%",
    hint: "Per-card utilization",
    status,
    bureaus,
  };
}

function card5kCriterion(report: CreditReport): CriterionGrade {
  return cardLimitCriterion(report, {
    threshold: 5000,
    id: "card-5k",
    label: "Has a credit card with $5K+ limit",
    hint: "Required minimum for entry funding",
  });
}

function card10kCriterion(report: CreditReport): CriterionGrade {
  return cardLimitCriterion(report, {
    threshold: 10000,
    id: "card-10k",
    label: "Has a credit card with $10K+ limit",
    hint: "Drives better funding offers",
  });
}

function cardLimitCriterion(
  report: CreditReport,
  opts: { threshold: number; id: string; label: string; hint: string }
): CriterionGrade {
  const revolvingCards = report.accounts.filter((a) => {
    const anyType = Object.values(a.bureaus)[0]?.accountType;
    return anyType?.toUpperCase().includes("REVOLVING");
  });

  const bureaus = mapBureaus((b) => {
    const cards = revolvingCards
      .map((a) => a.bureaus[b])
      .filter((d): d is NonNullable<typeof d> => !!d && (d.creditLimit ?? 0) > 0);

    if (cards.length === 0) return { value: "—", status: "fail" };

    const maxLimit = Math.max(...cards.map((d) => d.creditLimit ?? 0));
    if (maxLimit >= opts.threshold) {
      return { value: `$${formatNumber(maxLimit)}`, status: "pass" };
    }
    return { value: `Max $${formatNumber(maxLimit)}`, status: "fail" };
  });
  const status = aggregateStatus(bureaus);
  return {
    id: opts.id,
    label: opts.label,
    hint: opts.hint,
    status,
    bureaus,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function mapBureaus(fn: (b: Bureau) => BureauGrade): Record<Bureau, BureauGrade> {
  return {
    equifax: fn("equifax"),
    experian: fn("experian"),
    transunion: fn("transunion"),
  };
}

function aggregateStatus(bureaus: Record<Bureau, BureauGrade>): CriterionStatus {
  const statuses = BUREAUS.map((b) => bureaus[b].status);
  const allPass = statuses.every((s) => s === "pass");
  const allFail = statuses.every((s) => s === "fail");
  const allUnknown = statuses.every((s) => s === "unknown");
  const anyPass = statuses.includes("pass");
  const anyFail = statuses.includes("fail");

  if (allPass) return "pass";
  if (allFail) return "fail";
  if (allUnknown) return "unknown";
  if (anyPass && anyFail) return "mixed";
  if (anyPass) return "pass"; // some pass, rest unknown — call it pass
  if (anyFail) return "fail"; // some fail, rest unknown — call it fail
  return "unknown";
}

// Stricter roll-up for gating criteria where a single bad bureau must not be
// diluted. Any bureau fail → the whole criterion fails; any unread bureau →
// unknown (fail closed downstream); only an all-clear reads as pass.
function aggregateGatingStatus(bureaus: Record<Bureau, BureauGrade>): CriterionStatus {
  const statuses = BUREAUS.map((b) => bureaus[b].status);
  if (statuses.some((s) => s === "fail")) return "fail";
  if (statuses.some((s) => s === "unknown")) return "unknown";
  return "pass";
}

function formatMonths(m: number): string {
  if (m < 12) return `${m}m`;
  const years = Math.floor(m / 12);
  const months = m % 12;
  if (months === 0) return `${years}y`;
  return `${years}y ${months}m`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}
