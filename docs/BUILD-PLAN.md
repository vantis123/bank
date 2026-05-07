# Bank — Build Plan

10 phases from scaffold to Skool launch. Estimated 3-4 weeks calendar time.

## Phase 0 — Scaffold ✅

- [x] npm workspaces monorepo at `/Users/Krownz/bank/`
- [x] Apps: `dashboard`, `mcp-server`, `landing`
- [x] Packages: `parsers`, `playwright-flows`, `pdf-renderer`, `funding-rules`
- [x] Root README + CLAUDE.md + .gitignore + this build plan
- [ ] Git init + initial commit
- [ ] Create private GitHub repo (Phillip says go)

## Phase 1 — Parsers (1 day)

Port from `arvantis-tech/apps/workers/src/services/extractors/gdrive-ocr.js`:
- `parseCreditReportText` (MFSN format)
- `parseIIQCreditReportText` (IIQ format)
- `parseDeletionReportText` (DF format — for future Skool integrations)

Strip dispute-fox business logic, keep credit report parsing only. Add Vitest tests with sample report fixtures.

**Output:** `@bank/parsers` package exporting `parseFSN`, `parseIIQ` returning typed JSON.

## Phase 2 — Playwright flows (3 days)

- IIQ login (port from `identityiq-checker.js`) + 2FA security-answer step (last-4 SSN)
- IIQ navigate to `/CreditReport.aspx` + scroll-trigger lazy content + `page.pdf()`
- FSN login (port from `freescorenow-checker.js`) for both old and new portals
- FSN navigate to report page + `page.pdf()`
- pdf-parse the captured PDF → text → pipe to Phase 1 parsers
- Headed by default, `--headless` flag for power users

**Output:** `@bank/playwright-flows` exporting `pullFSN(creds)`, `pullIIQ(creds)` returning parsed JSON.

## Phase 3 — Funding rules engine (1 day)

**Phillip teaches the algorithm.** Encode his rules:
- `estimatePersonalFunding(parsedReport) → { low, high, tier }`
- `estimateBusinessFunding(parsedReport) → { low, high, tier }`
- `recommendRoute(parsedReport) → "dispute-first" | "funding-now" | "parallel-track"`
- `splitNegativesPositives(accounts) → { negatives, positives }`

Pure functions, deterministic, fully unit-tested with edge cases.

**Output:** `@bank/funding-rules` exporting the four functions.

## Phase 4 — PDF template (2 days)

- HTML/Tailwind luxury template, Arvantis Tech branding
- Handlebars fields for parsed data
- Puppeteer renderer (single function: `renderPDF(clientReport) → Buffer`)
- Cover page, score card, negative items, positive accounts, funding estimate, recommended route
- Iterate on design in HTML — no code touch needed

**Output:** `@bank/pdf-renderer` exporting `renderPDF(clientReport) → Buffer`.

## Phase 5 — Dashboard (4 days)

Next.js app, served on `localhost:3000`:
- Tile home: FSN tile, IIQ tile (SmartCredit tile placeholder for v1.5)
- Click tile → creds form (username + password, plus last-4 SSN field on IIQ)
- "Upload CSV" alternative → bulk client list
- Run button → spawns Playwright flow → live status stream
- Per-client report view with Download PDF button
- Settings (output folder, headed/headless toggle)

**Output:** `@bank/dashboard` — full local UI.

## Phase 6 — MCP server (2 days)

TypeScript MCP SDK:
- Tool: `pull_fsn(username, password)` → parsed JSON
- Tool: `pull_iiq(username, password, last4ssn)` → parsed JSON
- Tool: `analyze_report(parsedJSON)` → funding estimate + route recommendation
- Tool: `generate_pdf(parsedJSON)` → PDF buffer + saved file path
- Same data layer as dashboard (shared functions from packages/)

**Output:** `@bank/mcp-server` — runs alongside dashboard.

## Phase 7 — Distribution zip (3 days)

Build `bank-mac.zip` and `bank-windows.zip`:
- `Run Bank.command` (Mac) / `Run Bank.bat` (Windows) wrapper script
- Bundled `node_modules/` with Playwright + Chromium pre-installed
- App code (apps/ + packages/ compiled)
- README with one-time first-run instructions

Member workflow: download zip → unzip → double-click → dashboard opens. **Zero code signing needed, zero recurring cost.**

**Output:** Two zips ready for Vercel upload.

## Phase 8 — Landing page (2 days)

`bank.arvantis.tech` on Vercel (free tier):
- High-conversion design
- Hero + demo GIF (headed Chromium pulling a report)
- Two-track download tabs ("Just want to use it" + "I use AI")
- Book-a-call CTA for Arvantis agency upsell
- FAQ + footer

**Output:** Live landing page hosting the zip downloads.

## Phase 9 — Skool launch (1 day)

- Skool lesson with embedded download link → landing page
- Lesson video covers: install, first-run bypass, dashboard tour, MCP setup for AI users
- README + troubleshooting docs in repo
- v1 ships

## Out of scope for v1

- SmartCredit support (v1.5 — UI placeholder ready)
- AI-powered PDF commentary (v1.1 paid upgrade — bring-your-own API key)
- Bank Pro hosted-LLM subscription (v2 monetization)
- Auto-updater (v1.5)
- Telemetry / usage analytics (out of scope by design)
