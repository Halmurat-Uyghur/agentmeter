# Targets

Say how much you mean to use, in your currency, for example 20 to 60 a month. The panel's **Settings** section sets each one with an input box, or edit the settings directly.

- `copilotUsageMonitor.monthlyTargetMin`: the least you mean to use this month.
- `copilotUsageMonitor.monthlyTargetMax`: the most this month.
- `copilotUsageMonitor.dailyTargetMax`: the most today.
- `copilotUsageMonitor.weeklyTargetMax`: the most over today and the 6 days before it.

The status bar icon shows the month as under (↓), in range (✓) or over (🔥, amber). The Overview's Today and Last 7 days cards and the side bar's rows mark the daily and weekly targets the same way. A target never stops Copilot.

**Optional alert:** turn on `copilotUsageMonitor.targetAlert` (also **Turn on** in Settings) for one notification when this month first goes over the monthly most, at most once a month per window. It is off by default.
