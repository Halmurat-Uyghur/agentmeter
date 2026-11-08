// Colour palettes for the details panel (v0.8): the registry matches the manifest, the CSS
// only addresses the light and dark body classes, and every named palette passes the
// colour checks it promises: the four model-family colours stay apart under protan and
// deutan simulation (Machado, Oliveira & Fernandes 2009, severity 1.0, OKLab ΔE×100 ≥ 6 on
// every pair, ≥ 15 unsimulated) and read as text on a light or dark surface (WCAG ≥ 4.5:1
// light, ≥ 4.3:1 dark); the accent, used for fills and one bold label through --hot-text,
// is ≥ 3:1. The maths here is the same as the data-viz validator the values were chosen with.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanPaletteId, DEFAULT_PALETTE, isPaletteId, PALETTE_IDS, PALETTES, palette, paletteCss, palettePickItems, type PaletteShades } from "../../src/core/palettes";
import { renderPanelHtml } from "../../src/core/panelHtml";

const ROOT = join(__dirname, "..", "..");
const pkg = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const SURFACE = { light: "#fcfcfb", dark: "#1e1e1e" };
const HEX = /^#[0-9a-f]{6}$/;

type Lin = [number, number, number];
const lin = (h: string): Lin =>
  [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Lin;
const relLum = (h: string) => {
  const [r, g, b] = lin(h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const oklab = ([r, g, b]: Lin): Lin => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
} as const;
const simulate = (c: Lin, kind: keyof typeof MACHADO): Lin =>
  MACHADO[kind].map((row) => Math.max(0, Math.min(1, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))) as Lin;
const deltaE = (h1: string, h2: string, kind?: keyof typeof MACHADO) => {
  const a = oklab(kind ? simulate(lin(h1), kind) : lin(h1));
  const b = oklab(kind ? simulate(lin(h2), kind) : lin(h2));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};
const families = (s: PaletteShades) => [s.claude, s.gpt, s.gemini, s.other];
const pairs = <T>(xs: T[]) => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b] as const));
const named = PALETTES.filter((p) => p.id !== "theme");

describe("palettes: registry and manifest", () => {
  it("ids, default, descriptions and scope match package.json", () => {
    const p = pkg().contributes.configuration.properties["copilotUsageMonitor.palette"];
    expect(p.enum).toEqual([...PALETTE_IDS]);
    expect(p.default).toBe(DEFAULT_PALETTE);
    expect(DEFAULT_PALETTE).toBe("theme");
    expect(p.scope).toBe("application");
    expect(p.enumDescriptions).toEqual(PALETTES.map((x) => x.description));
    expect(PALETTES.map((x) => x.id)).toEqual([...PALETTE_IDS]);
    expect(new Set(PALETTES.map((x) => x.name)).size).toBe(PALETTES.length);
  });

  it("theme has no shades; every other palette has five hex colours for light and for dark", () => {
    expect(palette("theme").light).toBeUndefined();
    expect(palette("theme").dark).toBeUndefined();
    expect(named.length).toBeGreaterThanOrEqual(5);
    for (const p of named) {
      for (const mode of ["light", "dark"] as const) {
        const s = p[mode]!;
        expect(Object.keys(s).sort()).toEqual(["claude", "gemini", "gpt", "hot", "other"]);
        for (const v of Object.values(s)) expect(v, `${p.id} ${mode}`).toMatch(HEX);
      }
    }
  });

  it("isPaletteId and cleanPaletteId: unknown values fall back to theme", () => {
    for (const id of PALETTE_IDS) {
      expect(isPaletteId(id)).toBe(true);
      expect(cleanPaletteId(id)).toBe(id);
    }
    for (const bad of ["Ocean", "", 3, null, undefined, ["ocean"], { id: "ocean" }]) {
      expect(isPaletteId(bad), String(bad)).toBe(false);
      expect(cleanPaletteId(bad), String(bad)).toBe("theme");
    }
    expect(palette("nope" as never).id).toBe("theme");
  });

  it("pick items: one per palette, in order, the current one marked", () => {
    const items = palettePickItems("ocean");
    expect(items.map((i) => i.id)).toEqual([...PALETTE_IDS]);
    expect(items.map((i) => i.label)).toEqual(PALETTES.map((p) => p.name));
    expect(items.filter((i) => i.description.endsWith(" · current")).map((i) => i.id)).toEqual(["ocean"]);
    expect(items[0]!.description).toBe(PALETTES[0]!.description);
  });
});

describe("palettes: CSS", () => {
  it("theme adds nothing; a named palette sets --hot and the four family variables on the light and dark body classes only", () => {
    expect(paletteCss("theme")).toBe("");
    for (const p of named) {
      const css = paletteCss(p.id);
      expect(css).toContain(`/* palette: ${p.id} */`);
      expect(css).toContain(`body.vscode-light{--hot:${p.light!.hot};--c-claude:${p.light!.claude};--c-gpt:${p.light!.gpt};--c-gemini:${p.light!.gemini};--c-other:${p.light!.other};}`);
      expect(css).toContain(`body.vscode-dark{--hot:${p.dark!.hot};--c-claude:${p.dark!.claude};--c-gpt:${p.dark!.gpt};--c-gemini:${p.dark!.gemini};--c-other:${p.dark!.other};}`);
      expect(css).not.toMatch(/high-contrast|:root|url\(|@import|<|>/);
      expect(css.match(/body\./g)).toHaveLength(2);
    }
  });

  it("renderPanelHtml appends the palette after the panel sheet, in the loading state too; the default appends nothing", () => {
    const plain = renderPanelHtml(undefined, "x");
    expect(plain).not.toContain("body.vscode-light");
    expect(plain).not.toContain("/* palette:");
    const html = renderPanelHtml(undefined, "x", undefined, undefined, false, "ocean");
    expect(html).toContain(`${paletteCss("ocean")}</style>`);
    expect(html.split("<style>")).toHaveLength(2);
    expect(html).toContain("--hot:#0969da;");
    expect(html).toContain("--hot:#388bfd;");
  });
});

describe("palettes: colour checks", () => {
  for (const p of named) {
    for (const mode of ["light", "dark"] as const) {
      const s = p[mode]!;
      const surface = SURFACE[mode];
      it(`${p.id} (${mode}): families read as text and the accent as a fill on a ${mode} surface`, () => {
        const min = mode === "light" ? 4.5 : 4.3;
        for (const c of families(s)) expect(contrast(c, surface), c).toBeGreaterThanOrEqual(min);
        expect(contrast(s.hot, surface), s.hot).toBeGreaterThanOrEqual(3);
      });
      it(`${p.id} (${mode}): every pair of families stays apart under protan and deutan simulation, and plainly`, () => {
        for (const [a, b] of pairs(families(s))) {
          expect(Math.min(deltaE(a, b, "protan"), deltaE(a, b, "deutan")), `${a} vs ${b}`).toBeGreaterThanOrEqual(6);
          expect(deltaE(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(15);
        }
      });
    }
  }

  it("the checks bite: the theme fallbacks' blue and purple collapse under deutan simulation", () => {
    // src/core/panelCss.ts fallbacks for --c-gemini and --c-other (theme colours, not a palette)
    expect(deltaE("#2563eb", "#7c3aed", "deutan")).toBeLessThan(6);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });
});
