# Third-party software

| Component | Version | License | Shipped in app |
|---|---|---|---|
| Electron (includes Chromium, Node.js, and Chromium's media stack incl. its FFmpeg build) | 44.5.1 | MIT; Chromium components under BSD/LGPL etc. Notices ship as `LICENSES.chromium.html` inside the app bundle | yes |
| React, React DOM | 19.3.0 | MIT | yes (bundled) |
| zustand | 5.0.15 | MIT | yes (bundled) |
| lucide-react (icons) | 1.52.0 | ISC | yes (bundled, tree-shaken) |
| Vite, @vitejs/plugin-react, esbuild, TypeScript, Vitest | see package.json | MIT / Apache-2.0 (TypeScript) | no (build tools) |
| electron-builder | 26.17.0 | MIT | no (build tool) |

Native helpers use only Apple system frameworks (ScreenCaptureKit, AVFoundation,
Core Image, Core Graphics, VideoToolbox, Metal). **No FFmpeg binary and no GPL
codec (e.g. libx264) is bundled**. H.264/HEVC encoding is done by Apple's
hardware encoder through AVAssetWriter.

Backgrounds, cursor artwork and the app icon are original procedural designs
(`shared/backgrounds.ts`, `shared/cursorThemes.ts`, `scripts/make-icon.swift`).
