// Styles for the details panel. Colours come from the VS Code theme variables
// that every webview receives, so the panel follows light, dark and
// high-contrast themes; the fallbacks only matter outside VS Code (tests,
// previews). No fonts, images or URLs are loaded.
export const PANEL_CSS = `
:root {
  --bg: var(--vscode-editor-background, #fbfaf7);
  --fg: var(--vscode-editor-foreground, #24292f);
  --muted: var(--vscode-descriptionForeground, #6e7781);
  --card: var(--vscode-sideBar-background, var(--vscode-editorWidget-background, #ffffff));
  --line: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.28)));
  --accent: var(--vscode-textLink-foreground, #0969da);
  --good: var(--vscode-testing-iconPassed, #1a7f37);
  --warn: var(--vscode-editorWarning-foreground, #9a6700);
  --c-claude: var(--vscode-charts-orange, #d97706);
  --c-gpt: var(--vscode-charts-green, #15803d);
  --c-gemini: var(--vscode-charts-blue, #2563eb);
  --c-other: var(--vscode-charts-purple, #7c3aed);
  --heat: var(--vscode-charts-green, #2da44e);
  --mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif); font-size: 13px; line-height: 1.45; }
.page { max-width: 1240px; margin: 0 auto; padding: 18px 22px 30px; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.star { color: var(--warn); font-weight: 600; }

.top { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: flex-end; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.top h1 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.01em; }
.pill { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; vertical-align: 3px; color: var(--accent); border: 1px solid currentColor; }
.when { color: var(--muted); font-size: 12px; margin-top: 2px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); font-size: 12px; }
.chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.chip.live i { background: var(--good); }
.chip.warn { color: var(--warn); border-color: var(--warn); }
.chip.warn i { background: var(--warn); }

.note { margin: 14px 0; padding: 10px 14px; border-left: 3px solid var(--accent); background: var(--card); border-radius: 0 8px 8px 0; color: var(--muted); }
.note p { margin: 2px 0; }
.note.alert { border-left-color: var(--warn); color: var(--fg); }

.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 14px 0; }
.kpi { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 14px 16px; background: var(--card); border: 1px solid var(--line); border-top: 3px solid var(--edge, var(--accent)); border-radius: 10px; min-width: 0; }
.kpi .name { font-weight: 600; }
.kpi .sub { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
.kpi .big { font-family: var(--mono); font-size: 24px; font-weight: 650; white-space: nowrap; }
.kpi.k1 { --edge: var(--accent); } .kpi.k2 { --edge: var(--good); } .kpi.k3 { --edge: var(--c-gemini); } .kpi.k4 { --edge: var(--c-other); }

.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); gap: 14px; align-items: start; }
.box { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; min-width: 0; }
.box h2 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 0 0 10px; font-size: 13.5px; font-weight: 650; }
.box h2 small { font-weight: 400; color: var(--muted); font-size: 11.5px; }
.fine { margin-top: 10px; color: var(--muted); font-size: 11.5px; }
.fine p { margin: 2px 0; }

.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.tile { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.tile .k { display: block; color: var(--muted); font-size: 11px; }
.tile .v { display: block; font-family: var(--mono); font-size: 15px; font-weight: 600; white-space: nowrap; }

.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: right; font-weight: 600; color: var(--muted); font-size: 11px; padding: 4px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { text-align: right; padding: 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
td.sum { font-weight: 650; }
.chipm { display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; padding: 1px 8px; border-radius: 6px; font-family: var(--mono); font-size: 11.5px; border: 1px solid var(--fam); color: var(--fam); }
.f-claude { --fam: var(--c-claude); } .f-gpt { --fam: var(--c-gpt); } .f-gemini { --fam: var(--c-gemini); } .f-other { --fam: var(--c-other); }
.bar { display: block; height: 3px; margin-top: 4px; border-radius: 2px; background: var(--fam); opacity: .7; }

.month { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.month .dow { text-align: center; color: var(--muted); font-size: 10.5px; padding-bottom: 2px; }
.month .d { min-height: 46px; padding: 4px 5px; border-radius: 6px; border: 1px solid var(--line); font-size: 11px; display: flex; flex-direction: column; justify-content: space-between; }
.month .d small { font-family: var(--mono); font-size: 10.5px; text-align: right; }
.month .d.pad { border: 0; }
.month .d.later { border-style: dashed; color: var(--muted); }
.month .d.now { outline: 2px solid var(--accent); outline-offset: -1px; }
.h1 { background: color-mix(in srgb, var(--heat) 18%, transparent); }
.h2 { background: color-mix(in srgb, var(--heat) 31%, transparent); }
.h3 { background: color-mix(in srgb, var(--heat) 46%, transparent); }
.h4 { background: color-mix(in srgb, var(--heat) 62%, transparent); }
.scale { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-top: 10px; color: var(--muted); font-size: 11.5px; }
.scale .sw { display: inline-flex; gap: 3px; margin: 0 6px; vertical-align: -2px; }
.scale .sw b { width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--line); }

.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
.fact { display: flex; justify-content: space-between; gap: 8px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; }
.fact span:first-child { color: var(--muted); }
ul.plain { margin: 6px 0 0; padding-left: 18px; color: var(--muted); }
ul.plain li { margin: 3px 0; }

@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .kpis, .tiles { grid-template-columns: minmax(0, 1fr); } }
`;
