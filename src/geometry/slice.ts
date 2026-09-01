/**
 * Horizontal cross-sections of the model, the way carvers think about a piece:
 * "at this height, the profile is this wide and this deep."
 */

import { isoSegments, stitch, Grid2D } from './marchingSquares';
import { simplifyPolyline } from './silhouette';

export interface SliceDims {
  nx: number;
  ny: number;
  nz: number;
  d: [number, number, number];
  origin: [number, number, number];
}

export interface Slice {
  /** Height of this slice as a fraction of the blank, 0 (bottom) … 1 (top). */
  atFraction: number;
  /** Height above the blank base, mm. */
  heightMm: number;
  widthMm: number; // blank X
  depthMm: number; // blank Z
  /** Outline polylines in mm, origin at the section's front-left (x, z). */
  polylines: number[][][];
  /** Axis-aligned extent of the section, mm: [x0, z0, x1, z1]. */
  extentMm: [number, number, number, number];
  /** Section area, mm². */
  areaMm2: number;
}

/** A horizontal (XZ) cross-section of the occupancy at `atFraction` of the height. */
export function horizontalSlice(data: Uint8Array, dims: SliceDims, atFraction: number): Slice {
  const { nx, ny, nz, d } = dims;
  const j = Math.max(0, Math.min(ny - 1, Math.round(atFraction * (ny - 1))));

  const pc = nx + 2;
  const pr = nz + 2;
  const values = new Float32Array(pc * pr);
  let filled = 0;
  let minC = nx, maxC = -1, minR = nz, maxR = -1;
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const v = data[i + nx * (j + ny * k)];
      values[(k + 1) * pc + (i + 1)] = v;
      if (v) {
        filled++;
        if (i < minC) minC = i;
        if (i > maxC) maxC = i;
        if (k < minR) minR = k;
        if (k > maxR) maxR = k;
      }
    }
  }

  const grid: Grid2D = { cols: pc, rows: pr, values };
  const segs = isoSegments(grid, 0.5);
  const tol = Math.min(d[0], d[2]) * 0.6;
  const toMm = (gx: number, gy: number): [number, number] => [(gx - 0.5) * d[0], (gy - 0.5) * d[2]];
  const polylines = stitch(segs)
    .map((line) => simplifyPolyline(line.map(([x, y]) => toMm(x, y)), tol))
    .filter((line) => line.length >= 2);

  const widthMm = nx * d[0];
  const depthMm = nz * d[2];
  const extentMm: [number, number, number, number] =
    maxC < 0 ? [0, 0, 0, 0] : [minC * d[0], minR * d[2], (maxC + 1) * d[0], (maxR + 1) * d[2]];

  return {
    atFraction,
    heightMm: (j + 0.5) * d[1],
    widthMm,
    depthMm,
    polylines,
    extentMm,
    areaMm2: filled * d[0] * d[2],
  };
}
