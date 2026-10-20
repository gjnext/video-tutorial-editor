# Implementation Status

_Last updated: 2026-10-20 · macOS 26.6 (Apple M5 Pro) · Node 25 / Electron 44.5.1 (Chromium 152, Node 24) · Swift 6.4 (Command Line Tools, no Xcode)_

Legend: ✅ implemented **and verified** (test or observed run) · 🟡 implemented, not verified on real hardware/flow · ⛔ blocked · ⬜ not implemented

## Build & test status

| Check | Result |
|---|---|
| `tsc` (renderer + node configs) | ✅ passes |
| `npm run build:native` (Swift helpers, SwiftPM, CLT only) | ✅ builds; helpers ad-hoc signed |
| Unit tests (`vitest`: cursor, cursor style, highlights, geometry, timeline, audio) | ✅ 70/70 |
| Integration (real native exports: 1440p H.264+AAC, 4K HEVC 60 fps, custom outline, idle hiding, highlights) | ✅ 9/9 |
| E2E on dev build (`tests/e2e/scenario.mjs`) | ✅ 23/23 |
| E2E on **packaged `.app`** (no dev server) | ✅ 23/23 |
| Preview smoothness (`tests/e2e/perf.mjs`, real 3024×1964 recording, packaged app) | ✅ 0 % blank frames in playback/scrub/step, ~120 picture updates/s while scrubbing (avg seek 3 ms), no stall seeks, settles on the exact full-res frame |
| `scripts/verify-package.mjs` (bundle contents, helpers run, `codesign --verify --deep --strict`) | ✅ |
| Real screen recording via packaged app (`tests/e2e/record.mjs`) | ✅ 3024×1964 @ display Retina resolution, finalized + auto-imported, system cursor absent (self-test conclusive) |
| Edit + export of a real recording (cursor, click, freeze → 1440p) | ✅ 2560×1440 H.264, 4.2 s = 2.7 s + 1.5 s freeze |

## Milestones

| # | Milestone | Status | Evidence |
|---|---|---|---|
| 1 | Electron foundation: secure window, preload API, menus, import, playback | ✅ | e2e: import, thumbnails, waveform, playback advances on audio clock |
| 2 | Synthetic cursor MVP | ✅ | e2e: 3 keyframes placed by real clicks on the preview; unit golden vectors |
| 3 | Export pipeline | ✅ | integration: cursor hotspot in exported frame within tolerance of the model |
| 4 | Audio editing | ✅ | unit trim/split/move; export beeps at 1.5/4.5/10.5 s ±0.1 ms |
| 5 | Freeze frames | ✅ | 8 s + 4 s freeze → 12 s; every sampled output frame decoded (barcode) = expected source frame |
| 6 | Visual composition | ✅ | crop, 26 backgrounds, corners, shadow, padding, presets; preview ≈ export (Chromium decode, mean Δ≈2.6/255) |
| 7 | Native recording | ✅ | real display recording through the packaged app (LaunchServices launch, app-attributed permission); cursor-exclusion self-test passed; recording edited + exported |
| 8 | Projects, packaging, polish | ✅ | save → reopen restores every edit; packaged app passes the full e2e |

## Capabilities

**Synthetic cursor**: ✅ click-to-place keyframes (upsert per frame, drag while placing), drag points in preview, drag on timeline (multi-select, snapping), precise time/position fields, easing presets (smooth/gentle/quick/linear) + custom Bézier editor (overshoot-proof), auto/manual move duration with clamping warnings, optional curved path with drag handle (loop-free), show/hide events with fades, pauses, left/right/double clicks with ripple/pulse/press effects, 4 vector themes, size/opacity/shadow/halo, custom outline color + thickness (any theme), hide when idle with adjustable delay (fades out after the cursor stops, back in before the next move or click; idle ranges shaded on the cursor lane), hotspot-exact placement, clip-to-video, outside-crop warnings, path overlay (editing only, never exported), independent of freezes.

**Highlights**: ✅ Highlight mode (H): drag on the preview to add a box, circle, underline, arrow or spotlight at the playhead (a click places a default size); one-click styles (Outline, Neon, Soft fill, Dashed, Marker, Sketch) and colors from a bar under the toolbar; move/resize handles; Highlights timeline lane (move, trim, duplicate, delete); inspector for line style, thickness, fill, glow, corners, spotlight dim, Draw/Fade/Pop intro and timing; "Highlight this click" on click markers; sticks to the recording through crop/layout; ripples with freezes.

**Timeline**: ✅ ruler (frame ticks at high zoom), playhead scrub, frame stepping, edit-point jumps, zoom (pinch, ⌘±, slider, fit), horizontal scroll, thumbnails, real waveforms, select / multi-select, move/reorder video segments, trim (clip and freeze), split, delete, duplicate, freeze insert/extend, audio move between tracks with collision avoidance, audio trim, snapping to playhead/edges/events, ripple toggles, undo/redo (single step per gesture), context menus, keyboard shortcuts. Freeze segments hatched; audio overhang highlighted with a one-click fix.

**Preview**: ✅ exact composition via shared `composeFrame`; never blank (last decoded frame held during seeks); fast scrubbing through a cached short-GOP 1280 px proxy that settles on the full-resolution frame 140 ms after you stop; playback drift corrected by ±6 % rate nudging instead of seeks; fit + 150/200/300 % zoom, crop mode with handles, drag-to-position with center snapping guides, freeze badge.

**Audio**: ✅ MP3/WAV/M4A/AAC/AIFF import (drag-and-drop or dialog), narration + music tracks, volume 0–200 %, mute, linear fades, optional recording audio; 48 kHz AAC export.

**Recording**: ✅ ScreenCaptureKit window/display/region capture, `showsCursor = false`, app excluded from display capture, Retina pixel dimensions, 30/60 fps, H.264 (HEVC above 4096×2304), complete-frame filtering, countdown + floating HUD + ⌘⇧2 stop, success only after the file is finalized and probes as playable, permission detection/guidance, built-in cursor-exclusion self-test (`tests/e2e/record.mjs`). Verified: display mode; window and region modes share the same capture/writer path but were not separately exercised with a real capture.

**Projects**: ✅ `.tvproj` package (media copied in, atomic `project.json` writes, `.bak` of last good version, recent projects, Finder document type), recovery autosave every 15 s, missing-media detection + relink, unsaved-changes prompt on close.

**Export**: ✅ 1080p/1440p/4K, 30/60 fps, H.264/HEVC, quality presets, size estimate, real progress + ETA, cancel, partial-file safety, reveal in Finder, upscaling warning.

## Known limitations

* Imported footage with a baked-in cursor cannot be cleaned (communicated in the UI; recording in-app is the supported path).
* Ad-hoc signed builds: macOS ties Screen Recording permission to the code signature, so **each rebuild requires re-approving** the permission. A stable self-signed certificate could avoid this (not set up).
* Click metadata capture (spec 4.9) is not implemented. Cursor keyframes are placed manually by design; no global input monitoring.
* Preview playback uses `<video>` slaved to the audio clock with smooth rate correction; paused frames are exact, live playback can be ~1 frame off while converging. While scrubbing, the image is the 1280 px proxy (sharp full-resolution frame follows on release). Export is always exact.
* Crop and layout apply to all clips in the project (no per-clip crop yet).
* QuickTime shows exported dark tones slightly lifted (Apple's BT.709 gamma); browsers/YouTube match the editor.
* Intel Macs not targeted (arm64 build only).

## Next actionable task

Optional refinements: real-capture runs of window and region modes, per-clip crop, recorded click metadata (spec 4.9). Re-run `node tests/e2e/record.mjs` after any rebuild (re-approve the permission first — ad-hoc signatures change per build).
