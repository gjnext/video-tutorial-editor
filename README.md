# Tutorial Studio

A macOS desktop app for producing polished SaaS tutorial videos: record your web
app **without the mouse pointer**, add an ElevenLabs voiceover, place a perfectly
smooth **synthetic cursor** by clicking targets in the preview, hold frames while
the narration catches up, style the recording on a background, and export a
YouTube-ready 1080p / 1440p / 4K MP4.

Everything runs locally and offline. No account, no server, no telemetry.

## Requirements

* Apple Silicon Mac, macOS 14 Sonoma or later (developed on macOS 26)
* Node.js 22+ and npm
* Swift 5.10+: the **Xcode Command Line Tools** are enough (`xcode-select --install`); full Xcode is not required
* No paid Apple Developer membership is needed

## Commands

```bash
npm install
```

```bash
npm run build:native      # Swift helpers → native/.build/release (ad-hoc signed)
```

```bash
npm run dev               # Vite + Electron with hot reload (run build:native first)
```

```bash
npm test                  # unit + native integration tests (real MP4 exports)
```

```bash
npm run test:e2e          # drives the real built app: import → cursor → freeze → save → reopen → export
```

```bash
npm run test:perf -- <video.mp4>   # preview smoothness benchmark (blank frames, scrub rate, playback stalls)
```

```bash
npm run package           # builds everything and creates release/mac-arm64/Tutorial Studio.app, then verifies it
```

```bash
npm run package:dmg       # optional .dmg of the same app
```

Copy `release/mac-arm64/Tutorial Studio.app` to `/Applications` and open it by
clicking its icon. No terminal or dev server is needed.

## Making a video

1. **Record**: click *Record* and choose your browser **window** (recommended), a display, or a region. The real cursor is excluded automatically. Stop with the floating control or ⌘⇧2. The recording opens in the editor.
   Or **Import** an existing MP4/MOV. Imported footage may contain a baked-in pointer; that cannot be removed reliably, and the app tells you so.
2. **Narration**: drop your ElevenLabs MP3/WAV/M4A onto the window. It lands on the Narration track with a real waveform. Drag it, trim its edges, split with **S**, set volume and fades in the inspector.
3. **Crop**: press **R** and drag the handles to remove browser tabs and the address bar.
4. **Style**: pick a backdrop (26 built-in designs, or a solid color, gradient, or image) and a layout preset. Fine-tune scale, padding, corners and shadow in the inspector.
5. **Cursor**: press **K**. Move the playhead to when the cursor should *arrive*, then click the target in the preview. Repeat for each target; motion between targets is generated (Smooth by default). Press **C** where the recorded UI reacts to add a click (⌥-click does both at once). Step frames with ← → to find the exact frame where the UI changes. Drag keyframes in the preview or on the timeline; edit easing, duration and optional curve in the inspector. Use show/hide markers and *Pause* as needed.
6. **Highlight**: press **H**, pick a shape (box, circle, underline, arrow, spotlight) and a style (outline, neon glow, soft fill, dashed, marker, hand-drawn), then drag over the element in the preview. It's fully drawn at the playhead, appears on the Highlights lane, and can be moved, resized and retimed. Right-click a click marker → *Highlight This Click* circles it automatically.
7. **Freeze**: when narration is longer than the footage, put the playhead on the frame to hold and press **F**. The video holds; the cursor and narration keep going. Later cursor events ripple with the freeze; audio does not (configurable in the timeline toolbar).
8. **Export** (⌘E): choose 1440p or 4K, 30/60 fps, H.264 or HEVC. Progress reflects real frames rendered; *Show in Finder* when done.

Save with ⌘S. A project is a `.tvproj` package that Finder shows as one document. It contains `project.json` plus copies of its media, so it is self-contained and can be moved. Unsaved work is recovered automatically after a crash. Press `?` for all shortcuts.

**Text sharpness.** Export resolution can't add detail the recording doesn't have. For crisp 1440p/4K output, record a large browser window on a Retina display (recordings keep full pixel resolution, e.g. 3456×2234 on a 16″ MacBook Pro). The app warns when the cropped recording is smaller than the export.

## Architecture

```
electron/main     Electron main process: window, menus, studio-media:// protocol (Range support),
                  validated IPC, project storage, helper supervision, export jobs (plan built in a worker thread)
electron/preload  the only privileged surface: a narrow typed API (shared/ipc.ts → window.studio)
src/              React + TypeScript editor (zustand state, Canvas 2D preview, timeline, inspector)
shared/           platform-neutral core used by BOTH preview and export:
                  time (flicks), schema, timeline time map, geometry, easing, cursor, audio, backgrounds,
                  draw ops, compose (frame evaluation), renderPlan
native/           Swift package (no Xcode project needed)
  studio-recorder ScreenCaptureKit capture (showsCursor = false) → AVAssetWriter H.264/HEVC
  studio-render   probe, thumbnails, export: AVAssetReader → Core Image (Metal) → VideoToolbox → MP4 + AAC
  studio-fixtures dev-only deterministic test media and analysis tools (not packaged)
tests/            unit (vitest), integration (real native exports), e2e (CDP driver for the real app)
docs/             COMPOSITION_SPEC.md: coordinate systems, timing rules, layer order, verification
```

* **Preview/export consistency.** The preview and exporter evaluate the same `composeFrame()` from `shared/`. The native renderer executes a precomputed plan and contains no timing, layout or animation logic. See `docs/COMPOSITION_SPEC.md`.
* **Processes.** The renderer is sandboxed (`contextIsolation`, `sandbox`, no Node, restrictive CSP, navigation blocked). Recording and encoding run in separate native processes that speak NDJSON over stdio, are launched with argv arrays (never a shell), and are killed on quit or cancel.
* **Media access.** The renderer can only load files the user imported or opened, plus app caches, through `studio-media://`.

## Signing, Gatekeeper and permissions (no paid developer account)

| Situation | What happens |
|---|---|
| `npm run dev` | Runs the Electron binary from `node_modules`. macOS attributes screen-recording permission to the app that launched it (your terminal/IDE). |
| Locally built `.app` (`npm run package`) | Ad-hoc signed (`codesign -s -`, configured via electron-builder `mac.identity: "-"`; helpers are ad-hoc signed too). Built on this Mac, it has no quarantine flag and opens normally. |
| Copying the `.app` to another Mac (AirDrop, download, zip) | The copy gets a quarantine flag and Gatekeeper blocks it ("cannot be verified"). The recipient can allow it once: right-click the app → **Open** → **Open**. On macOS 15+, use **System Settings → Privacy & Security → Open Anyway** after the first attempt. Don't disable Gatekeeper globally. |
| Public distribution | Requires an Apple Developer ID certificate and notarization (`notarize` options in electron-builder). Not needed for local use. |

**Screen Recording permission.** On first recording, macOS asks for permission for **Tutorial Studio**; the helper inherits the app's identity. If it's denied, open System Settings → Privacy & Security → **Screen & System Audio Recording**, enable Tutorial Studio, and reopen the app. Troubleshooting:

* **Permission is enabled but recording still fails after rebuilding the app.** Ad-hoc signatures change on every build, so macOS treats each build as a new app. Remove Tutorial Studio from the list with **−**, then add the new build or re-approve it.
* **Recording from `npm run dev`.** Grant permission to your terminal or IDE, since it is the "responsible" app in that case.
* **Reset all grants for the app:**

  ```bash
  tccutil reset ScreenCapture com.tutorialstudio.editor
  ```

* **Automated recording tests** launch the app through LaunchServices (`open`, like Finder) so macOS attributes the permission to Tutorial Studio rather than the terminal: `node tests/e2e/record.mjs "release/mac-arm64/Tutorial Studio.app"`.
* Accessibility and Input Monitoring permissions are not requested. The app never monitors global input.

## Licenses

See `docs/LICENSES.md`. All bundled dependencies are MIT/ISC; video encoding uses Apple's system frameworks (no FFmpeg binary is bundled).
