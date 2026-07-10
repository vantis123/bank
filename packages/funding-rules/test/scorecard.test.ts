/**
 * Unit tests for the funding-verdict engine (computeScorecard / computeVerdict).
 *
 * Focus: the two correctness bugs a funding tool must never regress —
 *   1. A thin / failed parse (unknown gating data) must NOT grade qualified.
 *   2. A real collection on a single bureau must NOT grade qualified.
 * Both must fail CLOSED → "refer-credit-repair".
 *
 * Run: npm test  (tsx test/scorecard.test.ts)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  Account,
  Bureau,
  BureauSummary,
  CreditReport,
} from "@bank/parsers";
import { computeScorecard } from "../src/index.ts";

const BUREAUS: readonly Bureau[] = ["equifax", "experian", "transunion"];

function goodSummary(): BureauSummary {
  return {
    openAccounts: 5,
    averageAgeMonths: 60,
    inquiries: 0,
  };
}

/** A revolving card reporting identically on all three bureaus. */
function card(creditLimit: number, balance: number): Account {
  const detail = {
    accountType: "REVOLVING",
    accountCondition: "OPEN",
    creditLimit,
    balance,
  };
  return {
    creditor: "Chase Sapphire",
    category: "current",
    isNegative: false,
    bureaus: {
      equifax: { ...detail },
      experian: { ...detail },
      transunion: { ...detail },
    },
  };
}

/** Baseline: clears every criterion cleanly on all three bureaus → ideal. */
function baseReport(): CreditReport {
  return {
    platform: "fsn",
    reportDate: "2026-07-10",
    scores: { equifax: 720, experian: 725, transunion: 715 },
    summary: {
      equifax: goodSummary(),
      experian: goodSummary(),
      transunion: goodSummary(),
    },
    // 15k limit, 1k balance (~6.7% util) → passes util, $5k and $10k card checks.
    accounts: [card(15000, 1000)],
    inquiries: [],
    publicRecords: [],
    personalInfo: {},
    warnings: [],
    errors: [],
  };
}

test("clean profile grades ideal", () => {
  const sc = computeScorecard(baseReport());
  assert.equal(sc.verdict, "ideal");
  assert.equal(sc.fundingRange, "$75K+");
});

test("BUG #1: thin parse with unknown gating data must NOT qualify", () => {
  // Simulate a failed/thin parse: summary block missing entirely, so
  // openAccounts / averageAgeMonths / inquiries all read unknown. Scores and
  // accounts still look fine. This previously graded qualified.
  const r = baseReport();
  const empty: BureauSummary = {};
  r.summary = { equifax: empty, experian: empty, transunion: empty };

  const sc = computeScorecard(r);
  assert.equal(sc.verdict, "refer-credit-repair");
  assert.equal(sc.fundingRange, "$0");
});

test("BUG #1: missing scores (all null) must NOT qualify", () => {
  const r = baseReport();
  r.scores = { equifax: null, experian: null, transunion: null };

  const sc = computeScorecard(r);
  assert.equal(sc.verdict, "refer-credit-repair");
});

test("BUG #2: collection on a single bureau must NOT qualify", () => {
  const r = baseReport();
  // A collection reporting on Equifax only. The other two bureaus read 0
  // negatives; this previously softened to "mixed" and slipped past refer.
  r.accounts.push({
    creditor: "Portfolio Recovery",
    category: "collection",
    isNegative: true,
    bureaus: {
      equifax: { accountType: "COLLECTION", balance: 850 },
    },
  });

  const sc = computeScorecard(r);
  const negatives = sc.criteria.find((c) => c.id === "negatives");
  assert.equal(negatives?.status, "fail", "single-bureau collection is a criterion fail, not mixed");
  assert.equal(sc.verdict, "refer-credit-repair");
  assert.equal(sc.fundingRange, "$0");
});

test("BUG #2: a late on a single bureau must NOT qualify", () => {
  const r = baseReport();
  r.accounts.push({
    creditor: "Capital One",
    category: "late30",
    isNegative: true,
    bureaus: {
      transunion: { accountType: "REVOLVING", balance: 100 },
    },
  });

  const sc = computeScorecard(r);
  const lates = sc.criteria.find((c) => c.id === "no-lates-24mo");
  assert.equal(lates?.status, "fail");
  assert.equal(sc.verdict, "refer-credit-repair");
});

test("collection on all three bureaus refers (regression guard)", () => {
  const r = baseReport();
  const collectionDetail = { accountType: "COLLECTION", balance: 500 };
  r.accounts.push({
    creditor: "Midland Funding",
    category: "collection",
    isNegative: true,
    bureaus: {
      equifax: { ...collectionDetail },
      experian: { ...collectionDetail },
      transunion: { ...collectionDetail },
    },
  });

  const sc = computeScorecard(r);
  assert.equal(sc.verdict, "refer-credit-repair");
});

test("all gating criteria pass but non-gating inquiries flagged → qualified", () => {
  const r = baseReport();
  // 3 inquiries per bureau fails the informational inquiries criterion only.
  r.summary = {
    equifax: { ...goodSummary(), inquiries: 3 },
    experian: { ...goodSummary(), inquiries: 3 },
    transunion: { ...goodSummary(), inquiries: 3 },
  };

  const sc = computeScorecard(r);
  const inquiries = sc.criteria.find((c) => c.id === "inquiries-under-2");
  assert.equal(inquiries?.status, "fail");
  assert.equal(sc.verdict, "qualified");
  assert.equal(sc.fundingRange, "$30K-$75K");
});

test("split credit score (one bureau below 680) must NOT qualify", () => {
  const r = baseReport();
  // Lenders use the lowest score; a sub-680 bureau makes this mixed → refer.
  r.scores = { equifax: 720, experian: 640, transunion: 710 };

  const sc = computeScorecard(r);
  const score = sc.criteria.find((c) => c.id === "credit-score");
  assert.equal(score?.status, "mixed");
  assert.equal(sc.verdict, "refer-credit-repair");
});

test("low open-account count refers", () => {
  const r = baseReport();
  r.summary = {
    equifax: { ...goodSummary(), openAccounts: 1 },
    experian: { ...goodSummary(), openAccounts: 1 },
    transunion: { ...goodSummary(), openAccounts: 1 },
  };

  const sc = computeScorecard(r);
  assert.equal(sc.verdict, "refer-credit-repair");
});
