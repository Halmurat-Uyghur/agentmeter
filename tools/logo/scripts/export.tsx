// Writes the shipped logo files into ../../media: icon.svg (colour; the panel tab icon),
// activity.svg (one colour; the activity-bar icon) and icon.png (256 px; the extension icon,
// rendered by Remotion). Run: npm run export (inside tools/logo).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkSvg } from "../src/Mark";

const here = dirname(fileURLToPath(import.meta.url));
const media = resolve(here, "../../../media");
mkdirSync(media, { recursive: true });

const svg = (el: React.ReactElement) => `${renderToStaticMarkup(el)}\n`;
writeFileSync(resolve(media, "icon.svg"), svg(<MarkSvg variant="color" size={512} />));
writeFileSync(resolve(media, "activity.svg"), svg(<MarkSvg variant="mono" size={24} ink="#C5C5C5" />));

// 1024 px still at scale 0.25 = 256 px (the marketplace needs a PNG of at least 128 px).
execFileSync("npx", ["remotion", "still", "Logo", resolve(media, "icon.png"), "--scale=0.25"], { cwd: resolve(here, ".."), stdio: "inherit" });
console.log("wrote media/icon.svg, media/activity.svg, media/icon.png");
