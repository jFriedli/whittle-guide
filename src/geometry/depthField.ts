/**
 * High-resolution orthographic depth maps, rasterised straight from the placed
 * triangles with a z-buffer — independent of the analysis voxel grid, so depth
 * maps and the contours derived from them are as crisp as the mesh allows.
 *
 * "Depth" is the distance from the viewed face of the blank inward to the first
 * surface. Values are quantised to a carving-friendly step to avoid false
 * precision.
 */

import { Mesh, Vec3 } from './mesh';
import { Blank } from './blank';
import { ViewName } from './projection';
import { viewFrame } from './viewGeometry';

/** The four faces we generate depth maps + contours for. */
export const FACE_DEPTH_VIEWS: ViewName[] = ['front', 'back', 'left', 'right'];

export interface DepthField {
  view: ViewName;
  widthMm: number;
  heightMm: number;
  cols: number;
  rows: number;
  /** Depth from the face, mm, row-major, origin bottom-left. -1 = no surface. */
  depth: Float32Array;
  maxDepthMm: number;
  stepMm: number;
}

export interface DepthFieldOptions {
  /** Pixels across the longer face axis. Default 300, capped 700. */
  resolution?: number;
  /** Quantise depth to this step, mm. 0 disables. Default 1. */
  quantiseMm?: number;
}

export function depthField(mesh: Mesh, blank: Blank, view: ViewName, opts: DepthFieldOptions = {}): DepthField {
  const frame = viewFrame(view, blank);
  const res = Math.min(700, Math.max(48, Math.round(opts.resolution ?? 300)));
  const long = Math.max(frame.widthMm, frame.heightMm);
  const pxmm = long / res;
  const cols = Math.max(2, Math.round(frame.widthMm / pxmm));
  const rows = Math.max(2, Math.round(frame.heightMm / pxmm));
  const dx = frame.widthMm / cols;
  const dy = frame.heightMm / rows;
  const step = opts.quantiseMm ?? 1;

  // z-buffer of nearest (smallest) depth
  const zbuf = new Float32Array(cols * rows).fill(Infinity);
  const p = mesh.positions;
  const va: Vec3 = [0, 0, 0];
  const vb: Vec3 = [0, 0, 0];
  const vc: Vec3 = [0, 0, 0];

  for (let t = 0; t < p.length; t += 9) {
    va[0] = p[t]; va[1] = p[t + 1]; va[2] = p[t + 2];
    vb[0] = p[t + 3]; vb[1] = p[t + 4]; vb[2] = p[t + 5];
    vc[0] = p[t + 6]; vc[1] = p[t + 7]; vc[2] = p[t + 8];

    const ax = frame.toU(va) / dx, ay = frame.toV(va) / dy, aw = frame.depth(va);
    const bx = frame.toU(vb) / dx, by = frame.toV(vb) / dy, bw = frame.depth(vb);
    const cx = frame.toU(vc) / dx, cy = frame.toV(vc) / dy, cw = frame.depth(vc);

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
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;

    for (let iy = minY; iy < maxY; iy++) {
      const sy = iy + 0.5;
      for (let ix = minX; ix < maxX; ix++) {
        const sx = ix + 0.5;
        const l1 = ((by - cy) * (sx - cx) + (cx - bx) * (sy - cy)) * inv;
        const l2 = ((cy - ay) * (sx - cx) + (ax - cx) * (sy - cy)) * inv;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
        const w = l1 * aw + l2 * bw + l3 * cw;
        const idx = iy * cols + ix;
        if (w < zbuf[idx]) zbuf[idx] = w;
      }
    }
  }

  const depth = new Float32Array(cols * rows);
  let maxDepthMm = 0;
  for (let i = 0; i < depth.length; i++) {
    let w = zbuf[i];
    if (!isFinite(w)) {
      depth[i] = -1;
      continue;
    }
    if (w < 0) w = 0;
    if (step > 0) w = Math.round(w / step) * step;
    depth[i] = w;
    if (w > maxDepthMm) maxDepthMm = w;
  }

  return { view, widthMm: frame.widthMm, heightMm: frame.heightMm, cols, rows, depth, maxDepthMm, stepMm: step };
}

/** Sample depth (mm) at a physical point on the face, or -1 if outside. */
export function sampleDepthFieldAt(df: DepthField, xMm: number, yMm: number): number {
  const c = Math.floor((xMm / df.widthMm) * df.cols);
  const r = Math.floor((yMm / df.heightMm) * df.rows);
  if (c < 0 || r < 0 || c >= df.cols || r >= df.rows) return -1;
  return df.depth[r * df.cols + c];
}
