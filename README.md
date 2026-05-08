# Bank by Arvantis

**The funding intelligence agent for credit professionals.**

Bank logs into your client's credit monitoring (MyFreeScoreNow, IdentityIQ), pulls the full report, grades it against funding-underwriter criteria, and outputs a luxury PDF with a personalized funding verdict — Refer to Credit Repair · Qualified $30K–$75K · Ideal $75K+ Max.

## Two doors, same engine

- **Dashboard** — a local webpage. Open the form, drop in client creds, watch Bank work in a real browser, download the PDF. **No AI required.**
- **MCP server** — for Claude Code / Cursor / any MCP-compatible client. Your AI calls Bank's tools to pull and analyze reports autonomously.

Same install. Same engine. Pick the door that fits how you work.

## Quick start

```bash
git clone <this-repo> bank
cd bank
npm install            # also installs Playwright Chromium
npm start              # launches dashboard at http://localhost:7878
```

The dashboard auto-opens in your default browser. Pick a platform, drop in creds, hit Run.

### MCP usage (Claude Code, Cursor, etc.)

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "bank": {
      "command": "node",
      "args": ["/absolute/path/to/bank/apps/mcp-server/src/index.ts"]
    }
  }
}
```

Bank exposes 5 tools:

| Tool | What it does |
|---|---|
| `bank_capture` | Login + scrape FSN/IIQ → returns raw report text |
| `bank_parse` | Text → typed CreditReport (auto-detects FSN/IIQ/legacy) |
| `bank_score` | CreditReport → Scorecard (8-criterion verdict) |
| `bank_render` | Report + scorecard + client info → luxury PDF |
| `bank_run_full` | One call: capture → parse → score → render |

## What runs locally

Everything. Bank doesn't phone home, doesn't upload reports, doesn't store credentials. Captured text and rendered PDFs live in `~/.bank/` on the operator's machine. Delete that folder to wipe everything.

## Repo layout

```
bank/
├── apps/
│   ├── dashboard/         Express + vanilla JS local UI
│   └── mcp-server/        MCP stdio server for AI agents
├── packages/
│   ├── parsers/           FSN (new + legacy single-bureau) + IIQ parsers
│   ├── playwright-flows/  Login + capture flows (headed by default)
│   ├── funding-rules/     8-criterion scorecard engine
│   └── pdf-renderer/      Luxury Arvantis-branded PDF (Handlebars + Playwright)
└── docs/                  Build plan + architecture notes
```

## Funding criteria graded per bureau

1. Credit score 680+ (lowest of 3 bureaus)
2. No collections / charge-offs / bankruptcies
3. No late payments in last 24 months
4. 3+ open accounts in good standing
5. Average account age 3+ years
6. Per-card utilization under 30%
7. Has a credit card with $5K+ limit
8. Has a credit card with $10K+ limit (AU acceptable)

Any FAIL → Refer to Credit Repair. All PASS with stricter thresholds → Ideal Profile.

## License

Proprietary — Arvantis Tech. Distributed to members of the Arvantis mentorship community via Skool. Not for public redistribution.
