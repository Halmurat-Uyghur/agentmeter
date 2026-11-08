// Premade colour palettes for the details panel. "theme" (the default) keeps the look the
// panel always had: the VS Code colour theme's chart colours set the accent and the model
// colours. A named palette fixes the accent (today, the active section, the heatmap, the
// cache ring, the spark line, the logo) and the four model-family colours, with its own
// shades for light and dark themes, addressed through the body classes VS Code sets on
// every webview (vscode-light, vscode-dark). High-contrast themes carry neither class, so
// they always keep the theme's colours. Every value is a hex colour checked by
// test/core/palettes.test.ts: the four family colours stay apart under protan and deutan
// simulation and read as text on a light or dark surface. Nothing here reads settings,
// touches the DOM or loads anything.
export const PALETTE_IDS = ["theme", "ember", "ocean", "forest", "violet", "rose", "graphite"] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];
export const DEFAULT_PALETTE: PaletteId = "theme";

/** The CSS variables a palette sets; src/core/panelCss.ts says what each one colours. */
export interface PaletteShades {
  /** `--hot`: the accent */
  hot: string;
  /** `--c-claude` … `--c-other`: the model families */
  claude: string;
  gpt: string;
  gemini: string;
  other: string;
}

export interface Palette {
  id: PaletteId;
  /** the name in the picker */
  name: string;
  /** one line for the picker and the setting's enumDescriptions (kept equal by the tests) */
  description: string;
  /** absent for "theme": the theme's chart colours stay */
  light?: PaletteShades;
  dark?: PaletteShades;
}

export const PALETTES: readonly Palette[] = [
  { id: "theme", name: "Theme", description: "Follow the colour theme: its chart colours set the accent and the model colours." },
  {
    id: "ember",
    name: "Ember",
    description: "Orange accent: the panel's classic look, the same on every theme.",
    light: { hot: "#ea580c", claude: "#c2410c", gpt: "#15803d", gemini: "#2563eb", other: "#a21caf" },
    dark: { hot: "#f97316", claude: "#ea580c", gpt: "#16a34a", gemini: "#3b82f6", other: "#ec4899" },
  },
  {
    id: "ocean",
    name: "Ocean",
    description: "Blue accent.",
    light: { hot: "#0969da", claude: "#b45309", gpt: "#047857", gemini: "#2563eb", other: "#a21caf" },
    dark: { hot: "#388bfd", claude: "#d97706", gpt: "#0d9488", gemini: "#3b82f6", other: "#ec4899" },
  },
  {
    id: "forest",
    name: "Forest",
    description: "Green accent.",
    light: { hot: "#15803d", claude: "#c2410c", gpt: "#15803d", gemini: "#0369a1", other: "#7e22ce" },
    dark: { hot: "#22c55e", claude: "#ea580c", gpt: "#059669", gemini: "#3b82f6", other: "#ec4899" },
  },
  {
    id: "violet",
    name: "Violet",
    description: "Purple accent.",
    light: { hot: "#7c3aed", claude: "#c2410c", gpt: "#15803d", gemini: "#0369a1", other: "#c026d3" },
    dark: { hot: "#a78bfa", claude: "#ea580c", gpt: "#16a34a", gemini: "#0891b2", other: "#ec4899" },
  },
  {
    id: "rose",
    name: "Rose",
    description: "Rose accent.",
    light: { hot: "#e11d48", claude: "#b45309", gpt: "#15803d", gemini: "#0369a1", other: "#7c3aed" },
    dark: { hot: "#fb7185", claude: "#ea580c", gpt: "#16a34a", gemini: "#0891b2", other: "#d946ef" },
  },
  {
    id: "graphite",
    name: "Graphite",
    description: "Slate-grey accent, for a quieter panel.",
    light: { hot: "#475569", claude: "#c2410c", gpt: "#15803d", gemini: "#0369a1", other: "#7c3aed" },
    dark: { hot: "#94a3b8", claude: "#d97706", gpt: "#059669", gemini: "#3b82f6", other: "#ec4899" },
  },
];

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === "string" && (PALETTE_IDS as readonly string[]).includes(v);
}

/** The setting's value as a palette id; anything unknown (a typo, a number, unset) is "theme". */
export function cleanPaletteId(v: unknown): PaletteId {
  return isPaletteId(v) ? v : DEFAULT_PALETTE;
}

export function palette(id: PaletteId): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0]!;
}

const vars = (s: PaletteShades) => `--hot:${s.hot};--c-claude:${s.claude};--c-gpt:${s.gpt};--c-gemini:${s.gemini};--c-other:${s.other};`;

/** CSS appended to the panel stylesheet: the palette's shades on the light and dark body
 * classes (so a high-contrast theme keeps its own colours); "" for "theme". */
export function paletteCss(id: PaletteId): string {
  const p = palette(id);
  if (!p.light || !p.dark) return "";
  return `\n/* palette: ${p.id} */\nbody.vscode-light{${vars(p.light)}}\nbody.vscode-dark{${vars(p.dark)}}\n`;
}

/** Quick pick items for the palette picker; the current one is marked. */
export function palettePickItems(current: PaletteId): { label: string; description: string; id: PaletteId }[] {
  return PALETTES.map((p) => ({ label: p.name, description: p.description + (p.id === current ? " · current" : ""), id: p.id }));
}
