/** One-click layout presets for the video layer. */
import type { VideoLayout } from './schema';
import { DEFAULT_LAYOUT } from './schema';

export interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  layout: VideoLayout;
}

const base = DEFAULT_LAYOUT;
const pad = (x: number, y: number) => ({ left: x, right: x, top: y, bottom: y });

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: 'spacious', name: 'Centered, spacious', description: 'Generous margins, soft shadow.', layout: { ...base, padding: pad(0.1, 0.12), cornerRadius: 0.016 } },
  { id: 'compact', name: 'Centered, compact', description: 'Balanced margins for most tutorials.', layout: { ...base, padding: pad(0.06, 0.07), cornerRadius: 0.013 } },
  { id: 'large', name: 'Large screen', description: 'Maximizes legibility of UI text.', layout: { ...base, padding: pad(0.03, 0.035), cornerRadius: 0.01, shadow: { ...base.shadow, blur: 0.03, opacity: 0.32 } } },
  { id: 'floating', name: 'Floating panel', description: 'Pronounced depth, rounded corners.', layout: { ...base, padding: pad(0.09, 0.11), cornerRadius: 0.024, shadow: { ...base.shadow, blur: 0.07, opacity: 0.5, offsetY: 0.03 } } },
  { id: 'minimal', name: 'Minimal demo', description: 'Thin frame, subtle shadow.', layout: { ...base, padding: pad(0.045, 0.05), cornerRadius: 0.008, shadow: { ...base.shadow, blur: 0.02, opacity: 0.22, offsetY: 0.006 } } },
  { id: 'full', name: 'Full bleed', description: 'Recording fills the canvas.', layout: { ...base, padding: pad(0, 0), cornerRadius: 0, shadow: { ...base.shadow, enabled: false } } },
];
