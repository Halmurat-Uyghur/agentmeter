// Styles for the details panel. Colours come from the VS Code theme variables
// that every webview receives, so the panel follows light, dark and
// high-contrast themes; the fallbacks only matter outside VS Code (tests,
// previews). A chosen palette (src/core/palettes.ts) appends overrides of --hot and
// the --c-* family variables on body.vscode-light / body.vscode-dark after this sheet.
// No fonts, images or URLs are loaded.
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
  /* Text-safe tones (M3): the raw theme colours stay for fills and borders only */
  --warn-text: color-mix(in srgb, var(--warn) 60%, var(--fg));
  --good-text: color-mix(in srgb, var(--good) 70%, var(--fg));
  --c-claude: var(--vscode-charts-orange, #d97706);
  --c-gpt: var(--vscode-charts-green, #15803d);
  --c-gemini: var(--vscode-charts-blue, #2563eb);
  --c-other: var(--vscode-charts-purple, #7c3aed);
  --heat: var(--vscode-charts-green, #2da44e);
  /* A2 accent: today, the active section, the heatmap and the ring */
  --hot: var(--vscode-charts-orange, var(--vscode-charts-yellow, #d9822b));
  --soft: color-mix(in srgb, var(--fg) 7%, transparent);
  --bar: color-mix(in srgb, var(--fg) 30%, transparent);
  --mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
* { box-sizing: border-box; }
/* --hot-text sits on body, not :root, so it follows a palette's --hot override (a custom property
   resolves its var() references where it is declared) */
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif); font-size: 13px; line-height: 1.45; --hot-text: color-mix(in srgb, var(--hot) 75%, var(--fg)); }
.page { max-width: 1240px; margin: 0 auto; padding: 18px 22px 30px; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.star { color: var(--warn-text); font-weight: 600; }

.top { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: flex-end; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.top h1 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.01em; }
.wordmark { display: flex; align-items: center; gap: 8px; }
.wordmark .wm { color: var(--fg); font-weight: 750; letter-spacing: -.02em; }
.logo { width: 22px; height: 22px; flex: none; }
.logo-bg { fill: var(--hot); }
.logo-fg { fill: none; stroke: var(--bg); stroke-width: 2.2; stroke-linecap: round; }
.pill { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; vertical-align: 3px; color: var(--muted); border: 1px solid currentColor; }
.when { color: var(--muted); font-size: 12px; margin-top: 2px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); font-size: 12px; }
.chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.chip.live i { background: var(--good); }
.chip.warn { color: var(--warn-text); border-color: var(--warn); }
.chip.warn i { background: var(--warn); }

.note { margin: 14px 0; padding: 10px 14px; border-left: 3px solid var(--line); background: var(--card); border-radius: 0 8px 8px 0; color: var(--muted); }
.note p { margin: 2px 0; }
.note.alert { border-left-color: var(--warn); color: var(--fg); }
.about { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 10px 0 0; font-size: 12px; }
.about details.more { margin-top: 0; }
.about .aboutbody { margin-top: 4px; padding: 8px 12px; border-left: 3px solid var(--line); background: var(--card); border-radius: 0 8px 8px 0; color: var(--muted); }
.about .aboutbody p { margin: 2px 0; }

.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 14px 0; }
.kpi { min-width: 0; }
.kpi .sub { color: var(--muted); font-size: 11.5px; margin-top: 6px; }
.kpi .big, .mtd .big { font-size: 26px; }

.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); gap: 14px; align-items: start; }
.box, .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; min-width: 0; }
.box h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 0 0 10px; font-size: 13.5px; font-weight: 650; }
.box h3 small { font-weight: 400; color: var(--muted); font-size: 11.5px; }
.box h3.sub { margin-top: 14px; }
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
tbody th { font-weight: 400; color: var(--fg); font-size: 12.5px; padding: 6px; }
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
.month .d.now { outline: 2px solid var(--hot); outline-offset: -1px; }
/* Calendar heat (M6, design #8): an orange bar under the figure, never a tint behind the text */
.month .d::after { content: ""; display: block; height: 4px; margin-top: 3px; border-radius: 2px; background: var(--lvl, transparent); }
.month .d.pad::after, .month .d.later::after { display: none; }
.h1 { --lvl: color-mix(in srgb, var(--hot) 35%, transparent); }
.h2 { --lvl: color-mix(in srgb, var(--hot) 55%, transparent); }
.h3 { --lvl: color-mix(in srgb, var(--hot) 78%, transparent); }
.h4 { --lvl: var(--hot); }
.scale .sw b { background: var(--lvl, transparent); }
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
.nav .tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.nav .months b { font-size: 14px; min-width: 128px; text-align: center; }
.btn, .seg { display: inline-block; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); text-decoration: none; font-size: 12px; }
a.btn:hover, a.seg:hover { border-color: var(--accent); color: var(--accent); }
.btn.off { opacity: .35; }
.unit .seg { border-radius: 0; margin-left: -1px; }
.unit .seg:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
.unit .seg:last-child { border-radius: 0 6px 6px 0; }
/* Selected unit (M4, design #9): orange underline like a tab; text stays the theme foreground */
.seg.on { background: var(--card); color: var(--fg); font-weight: 650; border-bottom: 2px solid var(--hot); }

.trend .plot { position: relative; display: flex; align-items: stretch; gap: 6px; height: 170px; padding-top: 4px; }
.trend ol.tcols { flex: 1 1 auto; display: flex; align-items: stretch; gap: 6px; list-style: none; margin: 0; padding: 0; min-width: 0; }
.trend ol.tcols > li { flex: 1 1 0; min-width: 0; display: flex; }
.trend .col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: stretch; text-decoration: none; color: var(--fg); border-radius: 6px; padding: 0 2px; position: relative; z-index: 1; }
.trend .col:hover { z-index: 2; background: color-mix(in srgb, var(--accent) 8%, transparent); }
.trend .col.sel { outline: 1px solid var(--hot); outline-offset: -1px; }
.trend .col .v { font-family: var(--mono); font-size: 10.5px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; height: 16px; }
.trend .col .track { flex: 1 1 auto; display: flex; align-items: flex-end; justify-content: center; border-bottom: 1px solid var(--line); }
.trend .col .fill { display: block; width: 70%; min-height: 2px; border-radius: 4px 4px 0 0; background: var(--bar); }
.trend .col.sel .fill { background: var(--hot); }
.trend .col:focus-visible .v { overflow: visible; }
.trend .col .m { font-size: 10.5px; color: var(--muted); text-align: center; padding-top: 3px; height: 18px; white-space: nowrap; }
.trend .band { position: absolute; left: 0; right: 0; margin-bottom: 21px; background: color-mix(in srgb, var(--good) 13%, transparent); border-top: 1px dashed var(--good); border-bottom: 1px dashed var(--good); z-index: 0; }
.trend .col .fill.st-under, .lg b.st-under { background: var(--c-gemini); }
.trend .col .fill.st-in, .lg b.st-in { background: var(--good); }
.trend .col .fill.st-over, .lg b.st-over { background: var(--warn); }
.lg b { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 10px; vertical-align: -1px; }
.lg b:first-child { margin-left: 0; }
.trend.daily .plot { gap: 2px; height: 130px; }
.trend.daily .col { padding: 0; }
.trend.daily .col .fill { width: 80%; border-radius: 2px 2px 0 0; }
.trend.daily .col .fill.peak { background: var(--hot); }
.trend.daily .col.later .track { border-bottom-style: dashed; }
.trend.daily .col.sel { outline-offset: 0; }
.trend.daily .avgwrap { position: absolute; left: 0; right: 0; top: 4px; bottom: 18px; z-index: 2; pointer-events: none; }
.trend.daily .avg { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed var(--fg); opacity: .55; }
.lg b.avgsw { width: 14px; height: 0; border-top: 1px dashed var(--fg); border-radius: 0; opacity: .7; vertical-align: 3px; }
.lg b.bandsw { background: color-mix(in srgb, var(--good) 13%, transparent); border: 1px dashed var(--good); }
.mtd.st-over .big { color: var(--warn-text); } .mtd.st-in .big { color: var(--good-text); }
td.flag { color: var(--warn-text); font-weight: 650; }
.cols.even { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 10px 0 0; font-size: 12px; }
.fchip { display: inline-block; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--accent); color: var(--accent); text-decoration: none; }
.fchip:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
a.rowlink { color: var(--fg); text-decoration: none; border-bottom: 1px dotted var(--muted); }
a.rowlink:hover { color: var(--accent); border-bottom-color: var(--accent); }
tr.on td, tr.on th { background: color-mix(in srgb, var(--hot) 10%, transparent); }
tr.on th { box-shadow: inset 3px 0 0 var(--hot); }
.tag { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 10.5px; border: 1px solid var(--line); color: var(--muted); }
.tag.add { border-color: var(--c-other); color: var(--c-other); }
.tag.on { border-color: var(--hot); color: var(--fg); }
details.more { margin-top: 6px; }
details.more > summary { cursor: pointer; color: var(--accent); font-size: 12px; padding: 4px 0; list-style: none; }
details.more > summary::-webkit-details-marker { display: none; }
details.more > summary::before { content: "▸ "; }
details.more[open] > summary::before { content: "▾ "; }


/* v0.4 sections (D30): skip link, section nav, one section per render */
.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip { position: absolute; left: 8px; top: -40px; z-index: 10; padding: 6px 10px; background: var(--card); color: var(--fg); border: 1px solid var(--vscode-focusBorder, var(--accent)); border-radius: 6px; }
.skip:focus { top: 8px; }
.toolbar { margin-top: 10px; }
.shell { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 16px; align-items: start; margin-top: 14px; }
.sidenav { position: sticky; top: 8px; }
.sidenav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.sidenav .grp { margin: 16px 10px 6px; color: var(--muted); font-size: 10.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
.sidenav a { display: flex; align-items: center; gap: 9px; min-height: 28px; padding: 5px 10px; border-radius: 8px; color: var(--vscode-sideBar-foreground, var(--fg)); text-decoration: none; border: 1px solid transparent; border-left-width: 3px; }
.sidenav a .ic { color: var(--muted); }
.sidenav a:hover { background: var(--vscode-list-hoverBackground, var(--soft)); }
.sidenav a[aria-current="page"] { font-weight: 650; background: var(--vscode-list-inactiveSelectionBackground, var(--soft)); border-left-color: var(--hot); }
.sidenav a[aria-current="page"] .ic { color: var(--hot); }
.sidenav .cnt { color: var(--muted); font-size: 11.5px; }
.sidenav .cnt.warn { color: var(--warn-text); font-weight: 650; }
/* Collapse / expand toggle: the nav shrinks to an icon rail (labels kept for screen readers) */
.sidenav .navtop { display: flex; justify-content: flex-end; margin-bottom: 6px; }
.sidenav a.navtoggle { min-height: 0; padding: 4px; border: 1px solid transparent; border-radius: 6px; color: var(--muted); }
.sidenav a.navtoggle:hover { color: var(--fg); }
.shell.navcollapsed { grid-template-columns: 44px minmax(0, 1fr); }
.sidenav.collapsed .navtop { justify-content: center; }
.sidenav.collapsed a:not(.navtoggle) { justify-content: center; padding: 5px 0; gap: 0; }
.sidenav.collapsed .lbl, .sidenav.collapsed .cnt.num, .sidenav.collapsed .grp { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.sidenav.collapsed a { position: relative; }
.sidenav.collapsed .cnt.warn { position: absolute; top: 1px; right: 4px; font-size: 10px; line-height: 1; }
.sidenav.collapsed ul + .grp + ul { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.content { container-type: inline-size; min-width: 0; }
.sec { margin: 0; font-size: 16px; font-weight: 650; }
.secdesc { margin: 2px 0 12px; color: var(--muted); font-size: 12px; }
.slabel { font-weight: 600; }
.ins { padding: 10px 0; border-bottom: 1px solid var(--line); }
.ins:first-child { padding-top: 0; }
.ins h3 { margin: 0 0 4px; }
.ins p { margin: 3px 0; }
.ins .ev { font-size: 11.5px; }
/* A2 dashboard */
.ic { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; vertical-align: -3px; }
.card .ch { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 13.5px; font-weight: 650; }
.card .ch .ic { color: var(--muted); }
.card .ch small { margin-left: auto; font-weight: 400; color: var(--muted); font-size: 11.5px; }
.card .big { font-family: var(--mono); font-variant-numeric: tabular-nums; font-weight: 650; white-space: nowrap; }
.card .sub { color: var(--muted); font-size: 11.5px; margin-top: 4px; }
.small { font-size: 11px; }
.hot { color: var(--hot-text); }
.lbl { margin: 0 0 6px; color: var(--muted); font-size: 12px; }
.lbl b { margin-left: 4px; font-weight: 600; }
.hero-grid { display: grid; grid-template-columns: minmax(220px, 1.1fr) minmax(0, 1.2fr) auto; gap: 14px 22px; align-items: start; }
.hero-main { padding-right: 18px; border-right: 1px solid var(--line); min-width: 0; }
.hero .big { font-size: 40px; line-height: 1.1; letter-spacing: -.02em; }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin: 16px 0 0; padding-top: 12px; border-top: 1px solid var(--line); }
.stats div { padding: 0 10px; border-left: 1px solid var(--line); min-width: 0; }
.stats div:first-child { padding-left: 0; border-left: 0; }
.stats div.span2 { grid-column: span 2; }
.stats dt { color: var(--muted); font-size: 11px; }
.stats dd { margin: 2px 0 0; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.up { color: var(--warn-text); } .down { color: var(--good-text); }
.hero-heat { min-width: 0; overflow-x: auto; }
.heat { display: block; width: auto; max-width: 100%; height: auto; }
.heat .ax { fill: var(--muted); font-size: 10.5px; font-family: var(--vscode-font-family, system-ui, sans-serif); }
.hm { fill: var(--hot); stroke: none; }
.hm.h0 { fill: var(--soft); }
.hm.h1 { fill-opacity: .28; } .hm.h2 { fill-opacity: .5; } .hm.h3 { fill-opacity: .74; } .hm.h4 { fill-opacity: 1; }
.hm.h0 { fill-opacity: 1; }
.hm.now { stroke: var(--fg); stroke-width: 1.2; }
.hero-ring { text-align: center; min-width: 110px; }
.ring { display: block; margin: 0 auto; }
.ring-bg { fill: none; stroke: var(--soft); stroke-width: 9; }
.ring-fg { fill: none; stroke: var(--hot); stroke-width: 9; stroke-linecap: round; }
.ring-num { fill: var(--fg); font-family: var(--mono); font-size: 24px; font-weight: 650; text-anchor: middle; }
.ring-sub { fill: var(--muted); font-size: 10px; text-anchor: middle; font-family: var(--vscode-font-family, system-ui, sans-serif); }
.hero-ring p { margin: 4px 0 0; }
.row2 { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
.row2 > .card { margin-bottom: 14px; }
.mtd-body { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; }
.mtd-main { flex: 0 1 auto; min-width: 0; }
.mtd .big { font-size: 26px; }
.cmp { margin-top: 6px; font-size: 12px; }
.delta { display: inline-block; padding: 1px 8px; border-radius: 999px; font-family: var(--mono); font-size: 11.5px; font-weight: 600; background: var(--soft); }
.delta.up { color: var(--warn-text); } .delta.down { color: var(--good-text); } .delta.same { color: var(--muted); }
.spark { flex: 1 1 120px; max-width: 220px; height: 56px; min-width: 70px; }
.spark-line { fill: none; stroke: var(--hot); stroke-width: 1.8; }
.spark-area { fill: color-mix(in srgb, var(--hot) 14%, transparent); stroke: none; }
.chrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 0 0 12px; }
.chrow .ch { margin: 0; }
.chrow .ch small { margin-left: 4px; }
.kchips { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.kchip { display: inline-flex; gap: 6px; align-items: baseline; padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 11.5px; }
.kchip b { color: var(--fg); font-weight: 600; }
.plotgrid { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; }
.barplot { display: block; width: 100%; height: 150px; }
.yaxis { display: flex; flex-direction: column; justify-content: space-between; height: 150px; color: var(--muted); font-size: 10.5px; text-align: left; }
.yaxis span { line-height: 1; }
.dbar { fill: var(--bar); }
.dbar-today { fill: var(--hot); }
.plotwrap { position: relative; }
.hits { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(30, minmax(0, 1fr)); }
.hits .hit:hover { background: var(--soft); }
/* Instant hover readouts: the webview runs no scripts and native tooltips are slow or missing there */
[data-tip] { position: relative; }
[data-tip]:hover::after { content: attr(data-tip); position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); z-index: 5; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--vscode-editorHoverWidget-border, var(--line)); background: var(--vscode-editorHoverWidget-background, var(--card)); color: var(--vscode-editorHoverWidget-foreground, var(--fg)); font: 11.5px/1.4 var(--vscode-font-family, system-ui, sans-serif); white-space: nowrap; pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
[data-tip].tip-l:hover::after { left: 0; transform: none; }
[data-tip].tip-r:hover::after { left: auto; right: 0; transform: none; }
.heat .hint { fill: var(--muted); font-size: 10.5px; font-style: italic; font-family: var(--vscode-font-family, system-ui, sans-serif); }
.heat .tip { visibility: hidden; fill: var(--fg); font-size: 11px; font-weight: 600; font-family: var(--vscode-font-family, system-ui, sans-serif); }
.heat .hc:hover .tip { visibility: visible; }
.heat:has(.hc:hover) .hint { visibility: hidden; }
.heat .hc:hover .hm { stroke: var(--fg); stroke-width: 1.5; }
.heat { overflow: visible; }
.bar-avg { stroke: var(--hot); stroke-width: 1; stroke-dasharray: 4 3; opacity: .85; }
.xaxis { grid-column: 1; display: grid; grid-template-columns: repeat(30, minmax(0, 1fr)); margin-top: 4px; color: var(--muted); font-size: 10.5px; }
details.daytable table { max-width: 520px; }
.xaxis span { white-space: nowrap; overflow: visible; }
.lg b.todaysw { background: var(--hot); }
.bars .lg b.avgsw { border-top-color: var(--hot); }

a:focus-visible, summary:focus-visible, .tablewrap:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 2px; }
.sidenav a:focus-visible { outline-offset: -1px; }

/* High contrast: borders, not fills, carry state */
body.vscode-high-contrast .sidenav a, body.vscode-high-contrast-light .sidenav a { border-color: var(--vscode-contrastBorder, var(--line)); }
body.vscode-high-contrast .sidenav a[aria-current="page"], body.vscode-high-contrast-light .sidenav a[aria-current="page"] { background: transparent; border-color: var(--vscode-contrastActiveBorder, var(--accent)); border-width: 2px; border-left-width: 4px; }
body.vscode-high-contrast .kpi, body.vscode-high-contrast .tile, body.vscode-high-contrast .chip, body.vscode-high-contrast .box, body.vscode-high-contrast .card, body.vscode-high-contrast .kchip,
body.vscode-high-contrast-light .kpi, body.vscode-high-contrast-light .tile, body.vscode-high-contrast-light .chip, body.vscode-high-contrast-light .box, body.vscode-high-contrast-light .card, body.vscode-high-contrast-light .kchip { border-color: var(--vscode-contrastBorder, var(--line)); }
body.vscode-high-contrast .hm, body.vscode-high-contrast .dbar, body.vscode-high-contrast .dbar-today, body.vscode-high-contrast-light .hm, body.vscode-high-contrast-light .dbar, body.vscode-high-contrast-light .dbar-today { stroke: var(--vscode-contrastBorder, var(--fg)); stroke-width: 1; }
body.vscode-high-contrast .dbar-today, body.vscode-high-contrast-light .dbar-today { stroke: var(--vscode-contrastActiveBorder, var(--hot)); stroke-width: 2; }
body.vscode-high-contrast .hm.now, body.vscode-high-contrast-light .hm.now { stroke: var(--vscode-contrastActiveBorder, var(--fg)); stroke-width: 2; }
body.vscode-high-contrast .seg.on, body.vscode-high-contrast-light .seg.on { border-color: var(--vscode-contrastActiveBorder, var(--fg)); border-width: 2px; }
body.vscode-high-contrast .fill, body.vscode-high-contrast .bar, body.vscode-high-contrast-light .fill, body.vscode-high-contrast-light .bar { outline: 1px solid var(--vscode-contrastBorder, var(--fg)); }
@media (forced-colors: active) {
  .sidenav a[aria-current="page"] { forced-color-adjust: none; background: Highlight; color: HighlightText; }
  .fill, .bar { forced-color-adjust: none; background: CanvasText; }
  .hm, .dbar, .ring-fg, .spark-line { forced-color-adjust: none; fill: CanvasText; stroke: CanvasText; }
  .hm.h0, .ring-bg, .spark-area { forced-color-adjust: none; fill: Canvas; stroke: GrayText; }
  .dbar-today, .ring-fg { forced-color-adjust: none; fill: Highlight; stroke: Highlight; }
  .ring-fg { fill: none; }
  .hm.now { stroke: Highlight; stroke-width: 2; }
  .seg.on { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; }
  .month .d::after { forced-color-adjust: none; background: var(--lvl, transparent); }
  .h1, .h2, .h3, .h4 { --lvl: CanvasText; }
}

/* Layout follows the content width (the nav takes a column), not the viewport */
@container (max-width: 900px) {
  .cols { grid-template-columns: minmax(0, 1fr); } .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hero-grid { grid-template-columns: minmax(0, 1fr) auto; } .hero-main { grid-column: 1 / -1; padding-right: 0; border-right: 0; }
  .row2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } .row2 .mtd { grid-column: 1 / -1; }
}
@container (max-width: 480px) {
  .kpis, .tiles, .row2, .hero-grid { grid-template-columns: minmax(0, 1fr); }
  .hero .big { font-size: 32px; } .stats { grid-template-columns: minmax(0, 1fr); gap: 6px; } .stats div { padding: 0; border-left: 0; }
  .xaxis { font-size: 9px; }
}

/* Narrow panel: the nav wraps into a row above the content */
@media (max-width: 720px) {
  .page { padding: 12px 14px 24px; }
  .shell { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .sidenav { position: static; }
  .sidenav { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  .sidenav ul { flex-direction: row; flex-wrap: wrap; gap: 4px; }
  .sidenav .grp { display: none; }
  .sidenav a { gap: 6px; }
  .sidenav a { border-left-width: 1px; border-bottom-width: 3px; white-space: nowrap; }
  .sidenav a[aria-current="page"] { border-left-color: transparent; border-bottom-color: var(--accent); }
  /* the row layout has room for labels, so the collapse toggle does not apply here */
  .sidenav .navtop { display: none; }
  .shell.navcollapsed { grid-template-columns: minmax(0, 1fr); }
  .sidenav.collapsed a:not(.navtoggle) { padding: 5px 10px; gap: 6px; }
  .sidenav.collapsed .cnt.warn { position: static; font-size: 11.5px; }
  .sidenav.collapsed .lbl, .sidenav.collapsed .cnt.num { position: static; width: auto; height: auto; margin: 0; overflow: visible; clip: auto; }
  .sidenav.collapsed ul + .grp + ul { margin-top: 0; padding-top: 0; border-top: 0; }
}
`;
