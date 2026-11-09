# Tokens or estimated cost

- **Tokens:** input plus output tokens, as each tool logs them.
- **USD (est.):** Copilot's own logged AI credits × $0.01; Claude Code and Codex tokens at API list prices. It is an estimate, not an invoice.

**Currency:** USD needs no network. Any other currency (CAD, EUR, GBP and more) fetches the daily European Central Bank USD rate from api.frankfurter.dev; the request carries only the currency code.

**Status bar:** `copilotUsageMonitor.statusBar` shows today, this month or the current session.
