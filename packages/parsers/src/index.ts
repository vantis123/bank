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

import type { CreditReport } from "./types.ts";
import { parseFSN } from "./fsn.ts";
import { parseFSNLegacy, looksLikeFSNLegacy } from "./fsn-legacy.ts";

export { parseIIQ } from "./iiq.ts";
export { parseFSN } from "./fsn.ts";
export { parseFSNLegacy, looksLikeFSNLegacy } from "./fsn-legacy.ts";

/**
 * Auto-pick FSN parser variant. Reports from member.myfreescorenow.com
 * (legacy ConsumerDirect platform) use a different layout from the
 * new app.myfreescorenow.com / SmartCredit-style report.
 */
export function parseFSNAny(text: string): CreditReport {
  if (looksLikeFSNLegacy(text)) return parseFSNLegacy(text);
  return parseFSN(text);
}
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
