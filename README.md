# Bank by Arvantis

**The funding intelligence agent for credit professionals.**

Bank logs into your client's credit monitoring (Free Score Now, IdentityIQ), pulls the full report, breaks it down into actionable insights — negative items, positive accounts, scores, AAoA, utilization — and outputs a luxury PDF report with a personalized funding estimate.

## Two doors, same engine

- **Dashboard** — a local webpage. Click tiles, paste creds, watch the agent work, download PDFs. **No AI required.**
- **MCP server** — for Claude / Codex / Cursor / any MCP-compatible agent. Your AI calls Bank's tools to pull and analyze reports autonomously.

Same install. Same data. Pick the door that fits how you work.

## Status

**Phase 0 — Scaffold complete.** See [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md) for the 10-phase roadmap and current status.

## Repo structure

```
bank/
├── apps/
│   ├── dashboard/        # Next.js dashboard (Phase 5)
│   ├── mcp-server/       # MCP server for AI agents (Phase 6)
│   └── landing/          # bank.arvantis.tech marketing page (Phase 8)
├── packages/
│   ├── parsers/          # FSN + IIQ credit report parsers (Phase 1)
│   ├── playwright-flows/ # Login + report-pull automation (Phase 2)
│   ├── pdf-renderer/     # Luxury PDF generator (Phase 4)
│   └── funding-rules/    # Phillip's funding estimation rules (Phase 3)
├── scripts/              # Build + distribution scripts (Phase 7)
└── docs/                 # Build plan, architecture notes
```

## Distribution (Phase 7)

Free zip download from `bank.arvantis.tech`. Member unzips, double-clicks `Run Bank.command` (Mac) or `Run Bank.bat` (Windows), browser opens to the dashboard. Zero infrastructure cost, zero code-signing fees.

## License

Proprietary — Arvantis Tech. Distributed to members of the Arvantis mentorship community via Skool. Not for public redistribution.
