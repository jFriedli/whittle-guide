/** Render a depth Float32Array to a colour heat-map data URL (main thread). */

export interface DepthLike {
  cols: number;
  rows: number;
  depth: Float32Array;
  maxDepthMm: number;
}

// Perceptual-ish ramp: shallow = pale sand, deep = teal→indigo.
function color(t: number): [number, number, number] {
  const stops: [number, number[]][] = [
    [0.0, [247, 240, 225]],
    [0.25, [232, 197, 138]],
    [0.5, [199, 148, 91]],
    [0.7, [120, 150, 140]],
    [0.85, [58, 110, 140]],
    [1.0, [40, 54, 100]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f)) as [number, number, number];
    }
  }
  return [40, 54, 100];
}

export function depthToDataUrl(dm: DepthLike, scale = 4): string {
  const canvas = document.createElement('canvas');
  canvas.width = dm.cols * scale;
  canvas.height = dm.rows * scale;
  const ctx = canvas.getContext('2d')!;
  const max = Math.max(1e-3, dm.maxDepthMm);
  for (let r = 0; r < dm.rows; r++) {
    for (let c = 0; c < dm.cols; c++) {
      const v = dm.depth[r * dm.cols + c];
      if (v < 0) {
        ctx.fillStyle = 'rgba(0,0,0,0)';
      } else {
        const [rr, gg, bb] = color(v / max);
        ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      }
      // flip vertically: face origin is bottom-left
      ctx.fillRect(c * scale, (dm.rows - 1 - r) * scale, scale, scale);
    }
  }
  return canvas.toDataURL('image/png');
}

export function depthLegend(maxDepthMm: number, stepMm: number): { mm: number; css: string }[] {
  const out: { mm: number; css: string }[] = [];
  const step = Math.max(stepMm, Math.round(maxDepthMm / 5) || 1);
  for (let d = 0; d <= maxDepthMm + 1e-6; d += step) {
    const [r, g, b] = color(d / Math.max(1e-3, maxDepthMm));
    out.push({ mm: Math.round(d), css: `rgb(${r},${g},${b})` });
  }
  return out;
}
