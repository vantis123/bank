# Bank — Project Operating Rules (for Claude)

This is a standalone product repo, separate from the Arvantis Tech main repo. Built for distribution to credit pros via Phillip's Skool mentorship community.

## What Bank is

A local-first tool that:
1. Logs into a client's credit monitoring portal (FSN + IIQ in v1, SmartCredit in v1.5)
2. Pulls the full credit report
3. Parses it into structured JSON (scores, summary, accounts, inquiries)
4. Applies Phillip's funding rules to estimate personal + business funding ranges
5. Generates a luxury Arvantis-branded PDF report
6. Exposes both a local dashboard (for non-AI users) and an MCP server (for AI agents)

## What Bank is NOT

- Not cloud-hosted — runs entirely on the member's machine
- Not LLM-dependent — v1 ships rules-based PDF, no API keys needed
- Not licensed/DRM'd — gated only by Skool membership
- Not a credit-pulling service — only reads what the member's clients have authorized

## Architecture

- **npm workspaces** monorepo (universal Node, no Bun/pnpm install required)
- **TypeScript** throughout, ESM modules
- **Next.js** for dashboard
- **MCP TypeScript SDK** for the agent server
- **Playwright** (headed by default) for browser automation
- **Puppeteer + Handlebars** for PDF generation

## Code conventions

- TypeScript everywhere except where porting legacy JS (the existing parsers in arvantis-tech/apps/workers/src/services/extractors/gdrive-ocr.js — port carefully, preserve battle-tested logic)
- ESM imports only
- No telemetry, no analytics, no phone-home
- No external dependencies that require API keys (this is a hard constraint for v1)

## Source files to port (Phase 1)

From the parent Arvantis Tech repo:
- `apps/workers/src/services/extractors/gdrive-ocr.js` → `parseCreditReportText`, `parseIIQCreditReportText`, `parseDeletionReportText`
- `scripts/extraction/freescorenow-checker.js` → login flow + selectors
- `scripts/extraction/identityiq-checker.js` → login flow + selectors + 2FA security-answer step
- `scripts/extraction/identityiq-api-pull-v2.js` → reference for /CreditReport.aspx scroll-to-load pattern

## Build plan

See [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md) for the 10-phase plan. Always check current phase status before starting work.

## Phillip's communication style

- Casual, fast, action-oriented
- Hates over-explanation and walls of text
- Hates unsolicited additions (deliver what was asked, stop)
- Hates dashes in copy (use periods or commas)
- Wants the dumb-simple fix first, not the engineering rewrite
- Speaks via voice-to-text often — interpret loose punctuation generously

## Hard rules from prior conversations

- No backwards-compatibility shims, no half-finished implementations
- No comments unless the WHY is non-obvious
- No documentation files unless explicitly requested
- Investigate WITH Phillip before editing — don't rapid-fire guess-edits during debug
- Verify each fix takes effect before layering more
