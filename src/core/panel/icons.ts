// Inline SVG icons for the panel (A2): drawn here, no files, no URLs. They are
// decoration only (aria-hidden); every icon sits next to a text label.

const PATHS = {
  overview: `<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>`,
  sessions: `<path d="M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5"/><path d="M2 4h.5M2 8h.5M2 12h.5"/>`,
  daily: `<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>`,
  models: `<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6"/>`,
  projects: `<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>`,
  tools: `<path d="M10.5 2.2a3.2 3.2 0 0 0-3.9 4.2l-4.2 4.2a1.4 1.4 0 0 0 2 2l4.2-4.2a3.2 3.2 0 0 0 4.2-3.9l-2 2-1.8-.4-.4-1.8z"/>`,
  insights: `<path d="M6 12.5h4M6.5 14.5h3"/><path d="M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.8.6 1.3v.5h4V11c0-.5.2-1 .6-1.3A4.5 4.5 0 0 0 8 1.5z"/>`,
  health: `<path d="M1.5 8.5h3l1.5-4 2.5 7 1.5-3h4.5"/>`,
  today: `<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>`,
  month: `<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3M5 9.5h2M9 9.5h2M5 12h2"/>`,
  week: `<path d="M2 12.5l4-4 3 3 5-6"/><path d="M10.5 5.5H14V9"/>`,
  session: `<path d="M3 3.5h10v7H3z"/><path d="M5.5 13.5h5M8 10.5v3"/>`,
  bars: `<path d="M2.5 14V9.5M6.5 14V5M10.5 14V8M14 14V2.5"/>`,
  navCollapse: `<rect x="1.5" y="2" width="13" height="12" rx="2"/><path d="M10.5 2v12M7 6 5 8l2 2"/>`,
  navExpand: `<rect x="1.5" y="2" width="13" height="12" rx="2"/><path d="M5.5 2v12M9 6l2 2-2 2"/>`,
  trend: `<path d="M2 14h12"/><path d="M3.5 11.5V9M6.5 11.5V6.5M9.5 11.5V8M12.5 11.5V4"/>`,
  settings: `<circle cx="8" cy="8" r="2.3"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4l1.4-1.4M11 5l1.4-1.4"/>`,
} as const;

export type IconName = keyof typeof PATHS;

/** A 16 px line icon in the current text colour, hidden from screen readers. */
export function icon(name: IconName): string {
  return `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}

/** The product mark next to the wordmark: an original bar glyph, not a borrowed logo. */
export function logo(): string {
  return `<svg class="logo" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect class="logo-bg" x="1" y="1" width="18" height="18" rx="5"/><path class="logo-fg" d="M6 14.5v-4M10 14.5v-9M14 14.5v-6"/></svg>`;
}
