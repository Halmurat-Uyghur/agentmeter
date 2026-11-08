// Renders the details panel as one static HTML string: no scripts, no remote
// resources, every dynamic string HTML-escaped. Missing values render "—",
// incomplete ones carry "*" plus a reason; a 0 appears only when logged.
// The panel shows one section at a time (D30): shared chrome, a section nav
// and the selected section. Navigation uses command: links limited to an
// allowlist by the webview (D20); the panel itself never runs code.
// This file is the façade: the renderers live in ./panel/.
import { DEFAULT_VIEW, LOADING_NOTE } from "./format";
import { DEFAULT_PALETTE, paletteCss, type PaletteId } from "./palettes";
import { page, shell, skipLink, stateNote, toolbar, topBar } from "./panel/chrome";
import { renderDaily } from "./panel/daily";
import { renderHealth } from "./panel/health";
import { renderInsights } from "./panel/insights";
import { renderModels } from "./panel/models";
import { renderOverview } from "./panel/overview";
import { renderProjects } from "./panel/projects";
import { DEFAULT_SECTION, isSectionId, sectionDef, type SectionId } from "./panel/sections";
import { renderSessions } from "./panel/sessions";
import { viewedName } from "./panel/shared";
import { renderTools } from "./panel/tools";
import type { Snapshot, ViewOptions } from "./types";

export { GROWTH_FLAG } from "./insights";
export { PANEL_COMMANDS, sectionHref } from "./panel/links";
export { DEFAULT_SECTION, isSectionId, SECTION_DEFS, SECTIONS, sectionPickItems, type SectionId } from "./panel/sections";
export { escapeHtml, monthKey, TABLE_LIMIT } from "./panel/shared";
export { DEFAULT_PALETTE, PALETTE_IDS, paletteCss, type PaletteId } from "./palettes";
export { toolGroup } from "./panel/tools";
export { renderSourcesCard, sourceChips, sourcesHealthBox } from "./panel/sources";
export { filterHref } from "./panel/links";

const RENDER: Record<SectionId, (s: Snapshot, view: ViewOptions) => string> = {
  overview: renderOverview,
  daily: renderDaily,
  sessions: renderSessions,
  models: renderModels,
  projects: renderProjects,
  tools: renderTools,
  insights: renderInsights,
  health: renderHealth,
};

/** The whole panel document for a snapshot (or the loading state), showing one section, in the
 * chosen colour palette ("theme": the colour theme's own chart colours). */
export function renderPanelHtml(
  s: Snapshot | undefined,
  cspSource: string,
  view: ViewOptions = DEFAULT_VIEW,
  section: SectionId = DEFAULT_SECTION,
  navCollapsed = false,
  palette: PaletteId = DEFAULT_PALETTE,
): string {
  const def = sectionDef(isSectionId(section) ? section : DEFAULT_SECTION);
  const css = paletteCss(palette);
  if (!s) {
    const body = `${skipLink(def)}
${topBar(undefined, view)}
${shell(undefined, def, LOADING_NOTE, `<p class="muted">Loading…</p>`, navCollapsed)}`;
    return page(body, cspSource, def.label, css);
  }
  const description = def.describe(viewedName(s), s.month?.isCurrent !== false);
  const body = `${skipLink(def)}
${topBar(s, view)}
${stateNote(s.health)}
${toolbar(s, view)}
${shell(s, def, description, RENDER[def.id](s, view), navCollapsed)}`;
  return page(body, cspSource, def.label, css);
}
