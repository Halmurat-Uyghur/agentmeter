import React from "react";

/**
 * The logo: a usage gauge (an arc open at the bottom, filled to about 70%) over three rising
 * bars. One component, three renderings, so the Remotion stills and the SVG files in media/
 * cannot drift apart:
 *   "color"  - rounded dark tile, gradient arc: media/icon.svg, media/icon.png (extension icon)
 *   "tab"    - same artwork; the details panel's editor-tab icon
 *   "mono"   - no tile, one color, track at reduced opacity: the activity-bar icon
 */
export type MarkVariant = "color" | "mono";

const CX = 256;
const CY = 262;
const R = 150;
const STROKE = 36;
const START = 135; // degrees clockwise from east: bottom left
const SWEEP = 270;
const LEVEL = 0.7;

const pt = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)] as const;
};
const f = (n: number) => n.toFixed(2);
const arc = (from: number, sweep: number) => {
  const [x0, y0] = pt(from);
  const [x1, y1] = pt(from + sweep);
  return `M${f(x0)} ${f(y0)}A${R} ${R} 0 ${sweep > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
};

const BARS: ReadonlyArray<readonly [number, number]> = [
  [208, 48],
  [244, 84],
  [280, 124],
];
const BASE = 330;

export const MARK_VIEWBOX_COLOR = "0 0 512 512";
/** tight crop for the one-color icon, so it fills the activity bar's small slot */
export const MARK_VIEWBOX_MONO = "64 48 384 384";

export const Mark: React.FC<{ variant: MarkVariant; ink?: string; idSuffix?: string }> = ({ variant, ink = "#C5C5C5", idSuffix = "" }) => {
  const [tipX, tipY] = pt(START + SWEEP * LEVEL);
  if (variant === "mono") {
    return (
      <g fill="none" stroke={ink} strokeLinecap="round">
        <path d={arc(START, SWEEP)} strokeWidth={STROKE} opacity={0.35} />
        <path d={arc(START, SWEEP * LEVEL)} strokeWidth={STROKE} />
        <g stroke="none" fill={ink}>
          {BARS.map(([x, h]) => (
            <rect key={x} x={x - 2} y={BASE - h} width={28} height={h} rx={9} />
          ))}
        </g>
      </g>
    );
  }
  const bg = `bg${idSuffix}`;
  const gauge = `gauge${idSuffix}`;
  const bar = `bar${idSuffix}`;
  return (
    <g>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#222850" />
          <stop offset="1" stopColor="#0E1127" />
        </linearGradient>
        <linearGradient id={gauge} gradientUnits="userSpaceOnUse" x1="120" y1="380" x2="400" y2="150">
          <stop offset="0" stopColor="#2DD4BF" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
        <linearGradient id={bar} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F4F6FF" />
          <stop offset="1" stopColor="#B9C2F0" />
        </linearGradient>
      </defs>
      <rect width={512} height={512} rx={112} fill={`url(#${bg})`} />
      {/* the artwork is scaled up inside the tile so it still reads at 16 px */}
      <g transform="translate(256 256) scale(1.12) translate(-256 -240)">
        <g fill="none" strokeLinecap="round" strokeWidth={STROKE}>
          <path d={arc(START, SWEEP)} stroke="#FFFFFF" opacity={0.13} />
          <path d={arc(START, SWEEP * LEVEL)} stroke={`url(#${gauge})`} />
        </g>
        <circle cx={Math.round(tipX * 100) / 100} cy={Math.round(tipY * 100) / 100} r={11} fill="#FFFFFF" />
        {BARS.map(([x, h]) => (
          <rect key={x} x={x - 2} y={BASE - h} width={28} height={h} rx={9} fill={`url(#${bar})`} />
        ))}
      </g>
    </g>
  );
};

export const MarkSvg: React.FC<{ variant: MarkVariant; size?: number; ink?: string; idSuffix?: string }> = ({ variant, size, ink, idSuffix }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox={variant === "mono" ? MARK_VIEWBOX_MONO : MARK_VIEWBOX_COLOR} width={size} height={size}>
    <Mark variant={variant} ink={ink} idSuffix={idSuffix} />
  </svg>
);
