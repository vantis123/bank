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
import { parseFSNPDF, isFSNPdfFormat } from "./fsn-pdf.ts";

export { parseIIQ } from "./iiq.ts";
export { parseFSN } from "./fsn.ts";
export { parseFSNLegacy, looksLikeFSNLegacy } from "./fsn-legacy.ts";
export { parseFSNPDF, isFSNPdfFormat } from "./fsn-pdf.ts";

/**
 * Auto-pick FSN parser variant. Bank handles three FSN formats:
 *   - Print-button downloaded PDF ("Three Bureau Credit Report")
 *   - Legacy ConsumerDirect single-bureau page (member.myfreescorenow.com/credit-report)
 *   - New SmartCredit-style web layout (app.myfreescorenow.com)
 */
export function parseFSNAny(text: string): CreditReport {
  if (isFSNPdfFormat(text)) return parseFSNPDF(text);
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
