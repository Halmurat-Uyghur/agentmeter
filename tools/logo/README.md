# Logo (Remotion)

Development tooling only: this folder is its own npm package and is never part of the .vsix (`.vscodeignore` allows only the files it names).

`src/Mark.tsx` draws the logo once; the Remotion stills and the exported files share it.

```bash
cd tools/logo && npm install
npm run studio   # preview: Logo, MonoPreview (dark and light activity bar), Reveal (3 s animation)
npm run export   # rewrites media/icon.svg, media/activity.svg and media/icon.png
```
