/**
 * Vector-quality orthographic silhouettes.
 *
 * Templates should be as crisp as the mesh allows, not as coarse as the analysis
 * voxel grid. This module rasterises the *projected 2-D triangles* of the placed
 * mesh at a high, independent resolution, then traces and simplifies the outline
 * — so the printed template outline is decoupled from voxel resolution.
 *
 * (Not a polygon-boolean union of the triangles — that is fragile on real scans.
 * A fine coverage raster + marching squares + Douglas–Peucker is robust and,
 * at ~0.1 mm/pixel, visually indistinguishable from exact.)
 */

import { Mesh } from './mesh';
import { Blank } from './blank';
import { ViewName } from './projection';
import { viewFrame } from './viewGeometry';
import { Grid2D, isoSegments, stitch } from './marchingSquares';

export interface SilhouetteResult {
  view: ViewName;
  widthMm: number;
  heightMm: number;
  /** Simplified outline polylines, mm, origin at face bottom-left. */
  polylines: number[][][];
  /** Fraction of the face covered. */
  coverage: number;
  /** Axis-aligned silhouette extent in mm: [x0,y0,x1,y1]. */
  extentMm: [number, number, number, number];
}

export interface SilhouetteOptions {
  /** Target pixels across the longer face axis. Default 420, capped at 900. */
  resolution?: number;
  /** Douglas–Peucker tolerance, mm. Default = 0.6 × pixel size. */
  simplifyMm?: number;
}

export function silhouette(mesh: Mesh, blank: Blank, view: ViewName, opts: SilhouetteOptions = {}): SilhouetteResult {
  const frame = viewFrame(view, blank);
  const res = Math.min(900, Math.max(64, Math.round(opts.resolution ?? 420)));
  const long = Math.max(frame.widthMm, frame.heightMm);
  const px = long / res; // mm per pixel
  const cols = Math.max(2, Math.round(frame.widthMm / px));
  const rows = Math.max(2, Math.round(frame.heightMm / px));
  const dx = frame.widthMm / cols;
  const dy = frame.heightMm / rows;

  const mask = new Uint8Array(cols * rows);
  const p = mesh.positions;

  for (let t = 0; t < p.length; t += 9) {
    const ax = frame.toU([p[t], p[t + 1], p[t + 2]]) / dx;
    const ay = frame.toV([p[t], p[t + 1], p[t + 2]]) / dy;
    const bx = frame.toU([p[t + 3], p[t + 4], p[t + 5]]) / dx;
    const by = frame.toV([p[t + 3], p[t + 4], p[t + 5]]) / dy;
    const cx = frame.toU([p[t + 6], p[t + 7], p[t + 8]]) / dx;
    const cy = frame.toV([p[t + 6], p[t + 7], p[t + 8]]) / dy;

    let minX = Math.floor(Math.min(ax, bx, cx));
    let maxX = Math.ceil(Math.max(ax, bx, cx));
    let minY = Math.floor(Math.min(ay, by, cy));
    let maxY = Math.ceil(Math.max(ay, by, cy));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > cols) maxX = cols;
    if (maxY > rows) maxY = rows;
    if (minX >= maxX || minY >= maxY) continue;

    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) {
      // Degenerate in projection: still stamp its bbox thinly so hairlines show.
      continue;
    }
    const inv = 1 / det;
    for (let iy = minY; iy < maxY; iy++) {
      const sy = iy + 0.5;
      for (let ix = minX; ix < maxX; ix++) {
        const sx = ix + 0.5;
        const l1 = ((by - cy) * (sx - cx) + (cx - bx) * (sy - cy)) * inv;
        const l2 = ((cy - ay) * (sx - cx) + (ax - cx) * (sy - cy)) * inv;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-7 && l2 >= -1e-7 && l3 >= -1e-7) mask[iy * cols + ix] = 1;
      }
    }
  }

  // Trace outline (pad by 1 so border-touching shapes close).
  const pc = cols + 2, pr = rows + 2;
  const values = new Float32Array(pc * pr);
  let covered = 0;
  let minC = cols, minR = rows, maxC = -1, maxR = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = mask[r * cols + c];
      values[(r + 1) * pc + (c + 1)] = v;
      if (v) {
        covered++;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }
    }
  }
  const grid: Grid2D = { cols: pc, rows: pr, values };
  const segs = isoSegments(grid, 0.5);
  const tol = opts.simplifyMm ?? px * 0.6;
  const polylines = stitch(segs)
    .map((line) =>
      simplifyPolyline(
        line.map(([gx, gy]) => [(gx - 0.5) * dx, (gy - 0.5) * dy] as [number, number]),
        tol,
      ),
    )
    .filter((line) => line.length >= 2);

  const extentMm: [number, number, number, number] =
    maxC < 0 ? [0, 0, 0, 0] : [minC * dx, minR * dy, (maxC + 1) * dx, (maxR + 1) * dy];

  return {
    view,
    widthMm: frame.widthMm,
    heightMm: frame.heightMm,
    polylines,
    coverage: covered / (cols * rows),
    extentMm,
  };
}

/** Douglas–Peucker on an open polyline segment [lo, hi] (inclusive). */
function dpOpen(pts: [number, number][], lo: number, hi: number, tol: number, keep: Uint8Array) {
  keep[lo] = 1;
  keep[hi] = 1;
  const stack: [number, number][] = [[lo, hi]];
  while (stack.length) {
    const [a, c] = stack.pop()!;
    if (c - a < 2) continue;
    const [x1, y1] = pts[a];
    const [x2, y2] = pts[c];
    const dxs = x2 - x1;
    const dys = y2 - y1;
    const len = Math.hypot(dxs, dys) || 1e-9;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < c; i++) {
      const [x0, y0] = pts[i];
      const d = Math.abs(dys * x0 - dxs * y0 + x2 * y1 - y2 * x1) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > a) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, c]);
    }
  }
}

/**
 * Douglas–Peucker polyline simplification (mm). Closed loops are split at their
 * two most distant vertices and each arc is simplified independently, so a loop
 * never collapses to a degenerate segment.
 */
export function simplifyPolyline(pts: [number, number][], tol: number): number[][] {
  if (pts.length < 4) return pts.map((p) => [p[0], p[1]]);
  const closed =
    Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-6 &&
    Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-6;

  const keep = new Uint8Array(pts.length);

  if (!closed) {
    dpOpen(pts, 0, pts.length - 1, tol, keep);
  } else {
    // Farthest vertex from pts[0], then split there.
    let far = 1;
    let farD = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    dpOpen(pts, 0, far, tol, keep);
    dpOpen(pts, far, pts.length - 1, tol, keep);
  }

  const out: number[][] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push([pts[i][0], pts[i][1]]);
  if (closed && (out.length < 2 || out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
    out.push([out[0][0], out[0][1]]);
  }
  return out;
}
