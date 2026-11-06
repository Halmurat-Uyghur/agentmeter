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

.nav { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 16px; margin: 4px 0 0; }
.nav .months, .nav .unit { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.nav .months b { font-size: 14px; min-width: 128px; text-align: center; }
.btn, .seg { display: inline-block; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); text-decoration: none; font-size: 12px; }
a.btn:hover, a.seg:hover { border-color: var(--accent); color: var(--accent); }
.btn.off { opacity: .35; }
.unit .seg { border-radius: 0; margin-left: -1px; }
.unit .seg:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
.unit .seg:last-child { border-radius: 0 6px 6px 0; }
.seg.on { background: var(--accent); border-color: var(--accent); color: var(--vscode-button-foreground, #fff); font-weight: 600; }

.trend .plot { position: relative; display: flex; align-items: stretch; gap: 6px; height: 170px; padding-top: 4px; }
.trend .col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: stretch; text-decoration: none; color: var(--fg); border-radius: 6px; padding: 0 2px; position: relative; z-index: 1; }
.trend .col:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.trend .col.sel { outline: 2px solid var(--accent); outline-offset: -1px; }
.trend .col .v { font-family: var(--mono); font-size: 10.5px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; height: 16px; }
.trend .col .track { flex: 1 1 auto; display: flex; align-items: flex-end; justify-content: center; border-bottom: 1px solid var(--line); }
.trend .col .fill { display: block; width: 70%; min-height: 2px; border-radius: 4px 4px 0 0; background: var(--accent); }
.trend .col .m { font-size: 10.5px; color: var(--muted); text-align: center; padding-top: 3px; height: 18px; white-space: nowrap; }
.trend .band { position: absolute; left: 0; right: 0; margin-bottom: 21px; background: color-mix(in srgb, var(--good) 13%, transparent); border-top: 1px dashed var(--good); border-bottom: 1px dashed var(--good); z-index: 0; }
.trend .col .fill.st-under, .lg b.st-under { background: var(--c-gemini); }
.trend .col .fill.st-in, .lg b.st-in { background: var(--good); }
.trend .col .fill.st-over, .lg b.st-over { background: var(--warn); }
.lg b { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 10px; vertical-align: -1px; }
.lg b:first-child { margin-left: 0; }
.lg b.bandsw { background: color-mix(in srgb, var(--good) 13%, transparent); border: 1px dashed var(--good); }
.kpi.k4.st-under { --edge: var(--c-gemini); } .kpi.k4.st-in { --edge: var(--good); } .kpi.k4.st-over { --edge: var(--warn); }
.kpi.k4.st-over .big { color: var(--warn); } .kpi.k4.st-in .big { color: var(--good); }
td.flag { color: var(--warn); font-weight: 650; }
.cols.even { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 10px 0 0; font-size: 12px; }
.fchip { display: inline-block; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--accent); color: var(--accent); text-decoration: none; }
.fchip:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
a.rowlink { color: var(--fg); text-decoration: none; border-bottom: 1px dotted var(--muted); }
a.rowlink:hover { color: var(--accent); border-bottom-color: var(--accent); }
tr.on td { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.tag { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 10.5px; border: 1px solid var(--line); color: var(--muted); }
.tag.add { border-color: var(--c-other); color: var(--c-other); }
details.more { margin-top: 6px; }
details.more > summary { cursor: pointer; color: var(--accent); font-size: 12px; padding: 4px 0; list-style: none; }
details.more > summary::-webkit-details-marker { display: none; }
details.more > summary::before { content: "▸ "; }
details.more[open] > summary::before { content: "▾ "; }

@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .kpis, .tiles { grid-template-columns: minmax(0, 1fr); } }
`;
