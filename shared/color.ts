/** Colors are carried in draw ops as straight (non-premultiplied) sRGB floats. */
export type RGBA = [number, number, number, number];

export function parseColor(input: string, alphaMul = 1): RGBA {
  const s = input.trim().toLowerCase();
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 1;
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    r = parseInt(h.slice(0, 2), 16) / 255;
    g = parseInt(h.slice(2, 4), 16) / 255;
    b = parseInt(h.slice(4, 6), 16) / 255;
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
  } else {
    const m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const parts = m[1].split(',').map((x) => parseFloat(x));
      r = (parts[0] ?? 0) / 255;
      g = (parts[1] ?? 0) / 255;
      b = (parts[2] ?? 0) / 255;
      a = parts[3] ?? 1;
    }
  }
  const f = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  return [f(r), f(g), f(b), f(a * alphaMul)];
}

export function rgbaToCss(c: RGBA): string {
  const q = (v: number) => Math.round(v * 255);
  return `rgba(${q(c[0])},${q(c[1])},${q(c[2])},${Math.round(c[3] * 1000) / 1000})`;
}

export function withAlpha(c: RGBA, a: number): RGBA {
  return [c[0], c[1], c[2], Math.min(1, Math.max(0, c[3] * a))];
}

export function rgbaToHex(c: RGBA): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
