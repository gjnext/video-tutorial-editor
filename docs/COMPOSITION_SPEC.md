# Composition Specification

This document defines how a project is turned into pixels and samples. The
preview (React, Canvas 2D) and the exporter (Swift, Core Image/Core Graphics,
AVFoundation) must agree on every rule here.

**How agreement is guaranteed.** All rules are implemented once, in TypeScript,
in `shared/`. The preview calls `composeFrame(project, t, canvasPixels)` every
animation frame. The exporter receives a *render plan*
(`shared/renderPlan.ts`): the same `composeFrame` evaluated at every output
frame, plus primitive draw ops for the background. The native renderer only
executes primitives (`native/Sources/studio-render/Draw.swift`,
`Compositor.swift`); it never re-derives timing, layout, easing or cursor motion.
The remaining renderer-specific code (gradient fill, rounded-rect clip,
Gaussian shadow, path fill/stroke) is verified by tests that compare exported
frames against the model and against the preview canvas.

## 1. Time

### 1.1 Units
All times are integer **flicks**: 1 s = 705,600,000 flicks (`shared/time.ts`).
Every common frame rate (24, 25, 30, 48, 50, 60, 120, NTSC ×1000/1001) and
sample rate (8–192 kHz incl. 44.1 and 48 kHz) divides this exactly, so frame and
sample boundaries are integers and never drift. Native code uses
`CMTime(value: flicks, timescale: 705_600_000)`.

### 1.2 Conversions
| From → to | Rule |
|---|---|
| output frame *i* → project time | `round(i · den · F / num)` — computed from the index, never accumulated |
| project time → frame index | `floor(t · num / (den · F))` |
| project time → 48 kHz sample | `floor(t / 14700)` |
| project time → source time | through the video time map (§1.4) |
| encoder PTS of frame *i* | `CMTime(value: i·den, timescale: num)` (exact rational) |

### 1.3 Source frame selection
For a source time *s*, the visible frame is **the latest decoded frame with
`pts ≤ s + 0.5 ms`**. The preview seeks `<video>` to `s + 0.5 ms`; the exporter
decodes sequentially with `AVAssetReader` and applies the same rule
(`FrameSource.swift`). This handles variable-frame-rate recordings (ScreenCaptureKit
only delivers frames when the screen changes) and non-zero start times
(the asset timeline as reported by AVFoundation/HTML media is used).

### 1.4 Video time map
The video track is a gap-free sequence of segments (`shared/timeline.ts`):

* `clip { sourceIn, sourceOut }` maps project `[start, end)` linearly to source `[sourceIn, sourceOut)`.
* `freeze { sourceTime, duration }` maps every project time in `[start, end)` to `sourceTime`.

Segment start = sum of previous durations; intervals are half-open. At/after the
end, the final frame of the last segment is held (`sourceOut − 1 flick`), so
there are never black frames. Example (spec Test 3): an 8 s clip with a 4 s
freeze inserted at 3 s → `[0,3)→0..3`, `[3,7)→3`, `[7,12)→3..8`.

**Ripple policy** (`project.ripple`): inserting/removing video time shifts
cursor events strictly after the edit point (default **on**, keeps cursor
aligned with the UI) and audio clips (default **off**, so narration keeps
playing through a freeze). On removal, cursor events inside the removed range
are deleted.

### 1.5 Project duration
Program length = video sequence duration. Audio past the end is cut on export;
the UI flags the overhang and offers a one-click end freeze.

## 2. Geometry

All spaces have origin at the top-left, +x right, +y down.

| Space | Definition |
|---|---|
| Source-normalized `(u,v)` | `[0,1]²` over the full recorded frame (after the track orientation transform) |
| Source pixels | `(u·srcW, v·srcH)` |
| Crop | `{left, top, right, bottom}` fractions removed; crop rect = `[l, t, 1−l−r, 1−t−b]` (source-normalized); ≥2 % kept per axis |
| Canvas-normalized | `[0,1]²` over the composition canvas |
| Canvas pixels | canvas-normalized × output size — export resolution **or** preview backing store |

**Video placement** (`videoRectNormalized`):
1. Available area = canvas minus padding (left/right as fractions of canvas **width**, top/bottom of canvas **height**).
2. Fit the cropped content (pixel aspect preserved, "contain") into the area.
3. Multiply width and height by `scale`.
4. Align inside the area (`left|center|right`, `top|center|bottom`).
5. Add `offsetX·W`, `offsetY·H`.

For rendering (`placementFor`), the destination rect is snapped to whole canvas
pixels (sharper resampling of UI text); the cursor uses the same snapped rect.
Corner radius = `cornerRadius · H`, clamped to half the short side.

**Source → canvas**: `x = dest.x + (u − crop.x)/crop.w · dest.w` (same for y).
Cursor keyframes are stored in source-normalized coordinates, so changing crop,
scale, padding, canvas size, preview size or export resolution never moves the
cursor off its target. Keyframes outside the crop are flagged (red in the
overlay, warning in the inspector).

## 3. Synthetic cursor

* **Keyframe** `k = { time, x, y, easing, moveDuration|null, curve }` — the cursor
  *arrives* at `(x,y)` exactly at `time`.
* **Movement into k** lasts `d = moveDuration ?? auto(distance)`, clamped to the gap
  since the previous keyframe (timestamps always win; clamping is reported).
  `auto = clamp(0.18 s, 2 s, (0.32 + 0.52·√dist) · presetFactor)`, distance in units
  of source height, aspect-corrected. The cursor rests at the previous keyframe
  until `time − d`.
* **Easing**: CSS cubic-Bézier with `0 ≤ y1 ≤ y2 ≤ 1` (monotonic → no overshoot,
  no backtracking). Presets: smooth `(0.42,0,0.18,1)`, gentle `(0.5,0,0.3,1)` ×1.35,
  quick `(0.3,0,0.08,1)` ×0.7, linear. Custom values are sanitized into the same domain.
  Evaluation: 8 Newton steps, bisection fallback (deterministic).
* **Path**: straight by default. Optional `curve ∈ [−0.5, 0.5]` = quadratic Bézier
  whose control point is offset perpendicular to the segment by `curve · length`
  (aspect-corrected). Quadratic Béziers cannot self-intersect (no loops); motion
  is arc-length parameterized (48-sample LUT) so easing controls speed.
* **Before the first / after the last keyframe** the cursor holds that position.
* **Visibility**: show/hide events; the state before the first event is its
  opposite; 160 ms linear fade.
* **Segments**: every show that follows a hidden state starts a new segment.
  Keyframes interpolate only within their segment; before its first keyframe
  the cursor holds there. So a reappearing cursor starts at the new segment's
  first point and never travels across hidden time. No show/hide events → one
  continuous segment. Clicks, idle-hide activity and warnings are per segment.
* **Hide when idle** (`style.autoHide`, `autoHideDelay`): activity = each movement
  interval plus each click (`time − 60 ms` … last press `+ 520 ms`). The cursor is fully
  visible from 150 ms before an activity until `autoHideDelay` after it, with 250 ms linear
  fades; windows closer than two fades merge (no flicker). The factor multiplies the
  show/hide-event visibility, so explicit hide markers still win. Fully hidden → no cursor op.
* **Outline override** (`style.customOutline`, `outlineColor`, `outlineWidth` in cursor units,
  clamped 0–6): replaces the stroke color/width of the theme's outline layers; 0 removes it.
  Carried on the cursor op as `stroke`/`lineWidth`; fills are unchanged.
* **Clicks** `{ time, button }` happen wherever the cursor is at that time.
  Press animation: scale `1 − 0.14·sin(π·p)` over 240 ms starting 60 ms before the
  click. Double click = two presses 150 ms apart.
* **Hotspot**: cursor art (`shared/cursorThemes.ts`, absolute M/L/C/Z vector
  paths) has the arrow tip at `(0,0)`; that point is placed exactly on the
  mapped canvas position. Size: `0.03 · H · size · themeFactor` for a 20-unit arrow.
* Golden vectors: `tests/unit/cursor.test.ts` (e.g. `(0.1,0.2)@1s → (0.7,0.6)@2s`,
  smooth, at 1.5 s → `(0.569085, 0.512723)`).

## 4. Layers and draw ops

Order: (1) background ops, (2) video drop shadow, (3) cropped/scaled/rounded
video, (4) highlight halo, (5) cursor, (6) click effects. Layers 4–6 are clipped
to the video's rounded rect when `clipToVideo` is on (default).

Primitive semantics (`shared/drawOps.ts`):
* Colors: straight-alpha sRGB floats. Blending in non-linear sRGB (browser canvas semantics; the
  Core Image working space is set to sRGB to match).
* `linear`: gradient from (x0,y0) to (x1,y1), padded. CSS angle convention: 0° = to top,
  line length `|W·sinθ| + |H·cosθ|`.
* `radial`: radius r from center, padded with the last stop.
* Shadows: Gaussian, σ = blur/2 (HTML canvas `shadowBlur` semantics). The video shadow is
  the rounded rect in the shadow color, offset, blurred (`CIGaussianBlur` σ).
* Cursor: layers composited as a group, then shadow and alpha applied once.
* Ripple: ring radius `R·(0.25+0.75·easeOutCubic(p))`, R = `2.1·0.03·H·size`, 520 ms;
  right clicks use amber.

### 4.1 Highlights

A highlight `{start, end, shape, x, y, w, h, color, line, thickness, fill, glow, cornerRadius, dim, intro}`
(`shared/highlights.ts`) is stored in source-normalized coordinates — a box for
rect/ellipse/spotlight, a line (x,y)→(x+w,y+h) for underline/arrow (tip at the end) — so it
stays on the element through crop/layout/resolution changes. It is visible on `[start, end)`,
drawn above the video and below the cursor, clipped to the video's rounded rect, and ripples
with the cursor setting.

All shapes are converted in TypeScript into `poly` ops (polylines/polygons with optional
even-odd holes, dash, cap/join, glow), so renderers only stroke and fill points:
* rect: rounded-rect polygon (8 samples per corner); ellipse: 96 samples; start top-left/top, clockwise.
* thickness = `thickness/1000 · H`; line styles: dashed `[3w, 2w]`, dotted `[ε, 2.2w]` round caps,
  marker = 2.6× width at 45 % alpha, sketch = deterministic low-frequency wobble seeded by the id
  (two passes, slight overshoot), resolution independent.
* glow = halo stroke (3.4× width, 22 % alpha) beneath + shadow blur `max(6, 4w)` in the color.
* spotlights (box or circle) share ONE dim fill over the video (alpha = strongest active dim);
  each spotlight then ERASES its area (destination-out): core fully, plus 5 rings growing to
  `0.018 · H` with strength `1/(k+1)` so the dim rises to `k/6` in ring k. Erasures multiply,
  so several spotlights merge into one bright area with no seam. Highlights are drawn into
  their own transparent layer (preview offscreen canvas / native layer bitmap) before
  compositing, so erasing never touches the video.
* intro: draw = arc-length trim over 450 ms (ease-out cubic; arrow shaft 75 %, then head),
  fade 250 ms, pop = scale 0.85→1 + fade over 300 ms; outro: linear fade over the last 250 ms.

## 5. Audio

Audio lives in project time and is never time-stretched. A placement
`{start, sourceIn, sourceOut, gain, fadeIn, fadeOut}` plays source
`[sourceIn, sourceOut)` starting at `start`; gain envelope is linear
(`gainAt`). Export mixes all placements at 48 kHz stereo float (sample `k` of a
placement lands at project sample `floor(start/14700) + k`, using decoder PTS to
align), clamps to ±1, encodes AAC 192/256 kbps. Preview schedules
`AudioBufferSourceNode`s on the Web Audio clock (which is also the preview's
master clock) with identical envelopes. Optional recording audio follows the
video segments (silent during freezes).

## 6. Export

`buildRenderPlan` (run in a worker thread) → JSON plan → `studio-render export`:
decode (AVAssetReader, BGRA), compose (Core Image on Metal, Lanczos scaling),
encode (AVAssetWriter → VideoToolbox H.264 High/CABAC or HEVC Main, BT.709 tags,
`moov` first), mux AAC. Output is written to a hidden `.partial.mp4` and renamed
on success, so a failed/cancelled export never leaves a truncated file.
Progress lines report real frame counts.

**Color note.** Pixels are sRGB-encoded and tagged BT.709. Chromium (and thus
YouTube in Chrome and the editor preview) decodes them to the same values as the
preview canvas (verified: Δ ≈ 1–2/255). Apple's AVFoundation/QuickTime applies its
own BT.709 display gamma and shows dark tones slightly lifted — a known platform
behaviour, not a rendering difference.

## 7. Verification

| Property | Test |
|---|---|
| interpolation, overshoot, determinism, durations | `tests/unit/cursor.test.ts` |
| crop/scale/padding/resolution coordinate mapping | `tests/unit/geometry.test.ts` |
| freeze time map, ripple, split/trim/move/delete | `tests/unit/timeline.test.ts` |
| audio trim/split/move/fades/sample positions | `tests/unit/audio.test.ts` |
| exported dimensions, codecs, duration; per-frame source mapping via a frame-index barcode in the fixture; cursor hotspot vs model; narration sync ±5 ms; 4K HEVC 60 fps | `tests/integration/export.test.ts` |
| preview canvas vs exported MP4 decoded by Chromium; save/reopen round-trip; UI flows | `tests/e2e/scenario.mjs` |
