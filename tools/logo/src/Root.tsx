import React from "react";
import { AbsoluteFill, Composition, Still, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { MarkSvg } from "./Mark";

/** Stills render the artwork flat. */
const ColorStill: React.FC = () => (
  <AbsoluteFill>
    <MarkSvg variant="color" size={1024} />
  </AbsoluteFill>
);

/** The one-color icon, shown on VS Code's dark and light activity-bar greys for a legibility check. */
const MonoPreview: React.FC = () => (
  <AbsoluteFill style={{ flexDirection: "row" }}>
    <div style={{ flex: 1, background: "#333333", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <MarkSvg variant="mono" size={384} ink="#C5C5C5" />
    </div>
    <div style={{ flex: 1, background: "#F3F3F3", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <MarkSvg variant="mono" size={384} ink="#616161" />
    </div>
  </AbsoluteFill>
);

/** Optional 3 s reveal for a README or social card: the tile springs in. */
const Reveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 14, stiffness: 120 } });
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#0A0C1C", alignItems: "center", justifyContent: "center" }}>
      <div style={{ transform: `scale(${0.6 + 0.4 * s}) rotate(${(1 - s) * -8}deg)`, opacity }}>
        <MarkSvg variant="color" size={560} />
      </div>
    </AbsoluteFill>
  );
};

export const Root: React.FC = () => (
  <>
    <Still id="Logo" component={ColorStill} width={1024} height={1024} />
    <Still id="MonoPreview" component={MonoPreview} width={1024} height={512} />
    <Composition id="Reveal" component={Reveal} durationInFrames={90} fps={30} width={1080} height={1080} />
  </>
);
