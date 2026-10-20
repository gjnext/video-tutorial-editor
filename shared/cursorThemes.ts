/**
 * Vector cursor artwork. Shared by the React preview (Path2D) and the native
 * exporter (parsed into CGPath), so the cursor is resolution independent and
 * identical in both.
 *
 * Path syntax subset: absolute M, L, C, Z only. Units: "cursor units"; the
 * arrow tip — the hotspot — is at (0, 0). A cursor is UNIT_HEIGHT units tall.
 */
import type { CursorThemeId } from './schema';

export interface CursorLayer {
  d: string;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
}

export interface CursorTheme {
  id: CursorThemeId;
  label: string;
  description: string;
  /** Drawn in order: first layer is at the bottom. */
  layers: CursorLayer[];
  /** Drop shadow in cursor units; color includes alpha. */
  shadow: { blur: number; offsetX: number; offsetY: number; color: string };
  /** Relative size multiplier on top of the user's size setting. */
  sizeFactor: number;
  /** Default halo for this theme. */
  highlight: boolean;
}

export const CURSOR_UNIT_HEIGHT = 20;
/** Cursor height as a fraction of canvas height at size = 1. */
export const CURSOR_BASE_HEIGHT = 0.03;

const ARROW = 'M 0 0 L 0 17.2 L 4.1 13.3 L 6.8 19.6 L 9.6 18.4 L 6.95 12.3 L 12.4 12.3 Z';

export const CURSOR_THEMES: Record<CursorThemeId, CursorTheme> = {
  macos: {
    id: 'macos',
    label: 'macOS Arrow',
    description: 'Familiar black arrow with a white outline.',
    layers: [
      { d: ARROW, stroke: '#ffffff', lineWidth: 2.4 },
      { d: ARROW, fill: '#111111' },
    ],
    shadow: { blur: 2.4, offsetX: 0, offsetY: 1.1, color: 'rgba(0,0,0,0.38)' },
    sizeFactor: 1,
    highlight: false,
  },
  white: {
    id: 'white',
    label: 'Minimal White',
    description: 'White arrow with a thin dark outline.',
    layers: [
      { d: ARROW, stroke: '#1b1d24', lineWidth: 1.6 },
      { d: ARROW, fill: '#ffffff' },
    ],
    shadow: { blur: 2.6, offsetX: 0, offsetY: 1.2, color: 'rgba(0,0,0,0.30)' },
    sizeFactor: 1,
    highlight: false,
  },
  dark: {
    id: 'dark',
    label: 'Minimal Dark',
    description: 'Graphite arrow with a light outline.',
    layers: [
      { d: ARROW, stroke: '#f4f5f7', lineWidth: 1.6 },
      { d: ARROW, fill: '#26282f' },
    ],
    shadow: { blur: 2.2, offsetX: 0, offsetY: 1, color: 'rgba(0,0,0,0.28)' },
    sizeFactor: 1,
    highlight: false,
  },
  tutorial: {
    id: 'tutorial',
    label: 'High Visibility',
    description: 'Larger arrow with a bold outline, made to be followed.',
    layers: [
      { d: ARROW, stroke: '#111111', lineWidth: 3.2 },
      { d: ARROW, fill: '#ffffff' },
    ],
    shadow: { blur: 3, offsetX: 0, offsetY: 1.4, color: 'rgba(0,0,0,0.35)' },
    sizeFactor: 1.25,
    highlight: true,
  },
};

export const CURSOR_THEME_LIST = Object.values(CURSOR_THEMES);

/** Canvas pixels per cursor unit for a canvas height and size setting. */
export function cursorPixelsPerUnit(theme: CursorTheme, size: number, canvasHeight: number): number {
  return (CURSOR_BASE_HEIGHT * canvasHeight * size * theme.sizeFactor) / CURSOR_UNIT_HEIGHT;
}

/** Bounding box of the arrow in cursor units (including stroke and shadow margin). */
export const CURSOR_BOUNDS = { x: -4, y: -4, w: 22, h: 30 };
