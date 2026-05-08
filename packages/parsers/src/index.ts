/**
 * @bank/parsers — credit report text parsers.
 *
 * Two parsers covering all v1 platforms:
 *   - parseIIQ: IdentityIQ credit reports (PDF text via pdf-parse)
 *   - parseFSN: MyFreeScoreNow web-rendered reports (also handles SmartCredit
 *     since the new MFSN layout matches SC's)
 *
 * Both return the same typed CreditReport shape.
 */

export { parseIIQ } from "./iiq.ts";
export { parseFSN } from "./fsn.ts";
export type {
  Account,
  AccountCategory,
  Bureau,
  BureauAccountDetail,
  BureauScores,
  BureauSummary,
  CreditReport,
  Inquiry,
  PaymentCode,
  PaymentHistoryEntry,
  PersonalInfo,
  Platform,
  PublicRecord,
  ReportSummary,
} from "./types.ts";
export { BUREAUS } from "./types.ts";
