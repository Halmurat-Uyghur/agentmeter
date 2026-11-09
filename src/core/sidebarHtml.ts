// The side bar's HTML (A1): a no-script page with the panel's CSP. Small grey group
// headings, then label/value rows with right-aligned values; no icons. Every model
// string is escaped here; every link is a command from SIDEBAR_COMMANDS with
// JSON-encoded, URI-encoded arguments. Colours come from theme variables only.
import { escapeHtml, val } from "./panel/shared";
import { SIDEBAR_COMMANDS, type SidebarGroup, type SidebarLink, type SidebarModel, type SidebarRow } from "./sidebarModel";

/** command: URI for a side bar link; anything outside SIDEBAR_COMMANDS is refused. */
export function sidebarHref(link: SidebarLink): string {
  if (!(SIDEBAR_COMMANDS as readonly string[]).includes(link.command)) throw new Error("command not allowed");
  return link.args.length === 0 ? `command:${link.command}` : `command:${link.command}?${encodeURIComponent(JSON.stringify(link.args))}`;
}

export const SIDEBAR_CSS = `
body{margin:0;padding:2px 12px 12px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:transparent;line-height:1.4}
h2{margin:10px 0 1px;font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
ul{list-style:none;margin:0;padding:0}
.row{display:flex;align-items:baseline;gap:8px;padding:1px 4px;margin:0 -4px;color:inherit;text-decoration:none;border-radius:3px;border:1px solid transparent}
a.row:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-list-hoverForeground,inherit)}
a:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
a:not(.row):focus-visible{outline-offset:1px}
.btn:focus-visible{outline-offset:2px}
.l{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v{flex:none;white-space:nowrap;font-variant-numeric:tabular-nums}
.star{color:color-mix(in srgb,var(--vscode-editorWarning-foreground) 60%,var(--vscode-foreground))}
.mk{flex:none;font-size:10px;line-height:14px;padding:0 4px;border-radius:7px;border:1px solid currentColor;white-space:nowrap}
.mk.over{color:color-mix(in srgb,var(--vscode-editorWarning-foreground) 60%,var(--vscode-foreground))}
.mk.in{color:color-mix(in srgb,var(--vscode-charts-green,var(--vscode-foreground)) 70%,var(--vscode-foreground))}
.mk.under,.mk.filtered{color:var(--vscode-descriptionForeground)}
.muted,.empty,.note{color:var(--vscode-descriptionForeground)}
.empty{padding:1px 0}
.note{margin:8px 0 0;font-size:11px}
p{margin:8px 0}
a{color:var(--vscode-textLink-foreground);text-decoration:none}
a:hover{color:var(--vscode-textLink-activeForeground);text-decoration:underline}
a.row:hover,.btn:hover{text-decoration:none}
.ins{display:flex;align-items:baseline;gap:8px}
.ins .l{color:var(--vscode-foreground)}
.ins a{flex:none}
.cover{margin:8px 0 0;font-size:11px}
.cover a{color:var(--vscode-descriptionForeground)}
.cover a:hover{color:var(--vscode-textLink-activeForeground)}
.health a{color:color-mix(in srgb,var(--vscode-editorWarning-foreground) 60%,var(--vscode-foreground))}
.btn{display:inline-block;margin-top:14px;padding:3px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid var(--vscode-button-border,transparent);border-radius:2px;text-decoration:none}
.btn:hover{background:var(--vscode-button-hoverBackground);color:var(--vscode-button-foreground)}
.foot{margin-top:10px;font-size:11px;color:var(--vscode-descriptionForeground)}
body.vscode-high-contrast a.row:hover,body.vscode-high-contrast-light a.row:hover{border:1px dashed var(--vscode-contrastActiveBorder)}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
body.vscode-high-contrast .btn,body.vscode-high-contrast-light .btn{border-color:var(--vscode-contrastBorder)}
`;

function attrs(title: string, spoken?: string): string {
  return ` title="${escapeHtml(title)}"${spoken ? ` aria-label="${escapeHtml(spoken)}"` : ""}`;
}

function rowHtml(r: SidebarRow): string {
  const mark = r.marker ? `<span class="mk ${r.marker.kind}">${escapeHtml(r.marker.text)}</span>` : "";
  const inner = `<span class="l">${escapeHtml(r.label)}</span>${mark}<span class="v">${val(r.value)}</span>`;
  const a = attrs(r.title, r.spoken);
  return r.link ? `<li><a class="row" href="${escapeHtml(sidebarHref(r.link))}"${a}>${inner}</a></li>` : `<li><div class="row"${a}>${inner}</div></li>`;
}

function groupHtml(g: SidebarGroup): string {
  const id = `g-${g.id}`;
  const body = g.rows.length > 0 ? `<ul>${g.rows.map(rowHtml).join("")}</ul>` : `<div class="empty">${escapeHtml(g.empty ?? "")}</div>`;
  return `<section aria-labelledby="${id}"><h2 id="${id}"${attrs(g.title)}>${escapeHtml(g.heading)}</h2>${body}</section>`;
}

export function renderSidebarHtml(m: SidebarModel, cspSource: string): string {
  const parts: string[] = [];
  if (m.state !== "ready") {
    for (const p of m.notice) parts.push(`<p class="muted">${escapeHtml(p)}</p>`);
  } else {
    if (m.message) parts.push(`<p class="note">${escapeHtml(m.message)}</p>`);
    parts.push(...m.groups.map(groupHtml));
    if (m.insights) {
      const i = m.insights;
      parts.push(
        `<section aria-labelledby="g-insights"><h2 id="g-insights">Insights</h2><div class="ins"${attrs(i.title)}><span class="l">${escapeHtml(i.text)}</span><a href="${escapeHtml(sidebarHref(i.link))}" aria-label="${escapeHtml(i.spoken)}">Review</a></div></section>`,
      );
    }
    if (m.health) parts.push(`<p class="health"><a href="${escapeHtml(sidebarHref(m.health.link))}"${attrs(m.health.title)}>${escapeHtml(m.health.text)}</a></p>`);
    if (m.coverage) parts.push(`<p class="cover"><a href="${escapeHtml(sidebarHref(m.coverage.link))}"${attrs(m.coverage.title)}>${escapeHtml(m.coverage.text)}</a></p>`);
  }
  parts.push(`<a class="btn" href="${escapeHtml(sidebarHref({ command: "copilotUsageMonitor.showDetails", args: [] }))}" title="Opens the details panel.">Open dashboard</a>`);
  parts.push(
    `<div class="foot">${escapeHtml(m.footNote)} · <a href="${escapeHtml(sidebarHref(m.unitSwitch.link))}" title="Switches the side bar, status bar and panel unit.">${escapeHtml(m.unitSwitch.text)}</a> · <a href="${escapeHtml(sidebarHref(m.currencySwitch.link))}" title="${escapeHtml(m.currencySwitch.title)}">${escapeHtml(m.currencySwitch.text)}</a> · <a href="${escapeHtml(sidebarHref(m.settingsLink.link))}" title="${escapeHtml(m.settingsLink.title)}">${escapeHtml(m.settingsLink.text)}</a></div>`,
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)} 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Summary · AgentMeter (Local)</title>
<style>${SIDEBAR_CSS}</style>
</head>
<body>
<main aria-label="AgentMeter summary">
<h1 class="sr">AgentMeter summary</h1>
${parts.join("\n")}
</main>
</body>
</html>`;
}
