/**
 * Contour maps derived from depth maps — a topographic map of the sculpture as
 * seen from each side, to be printed and transferred to the wood.
 */

import { Grid2D, isoSegments, stitch } from './marchingSquares';
import { ViewName } from './projection';
import { simplifyPolyline } from './silhouette';

/** Anything with a per-pixel depth field: the voxel DepthMap or the raster DepthField. */
export interface DepthSource {
  view: ViewName;
  widthMm: number;
  heightMm: number;
  cols: number;
  rows: number;
  depth: Float32Array;
  maxDepthMm: number;
}

export interface ContourLevel {
  depthMm: number;
  /** Polylines in millimetres, origin at face bottom-left. */
  polylines: number[][][];
}

export interface ContourMap {
  view: ViewName;
  widthMm: number;
  heightMm: number;
  intervalMm: number;
  levels: ContourLevel[];
}

export const CONTOUR_INTERVALS = [2, 5, 10] as const;
export type ContourInterval = (typeof CONTOUR_INTERVALS)[number];

export function contourMap(dm: DepthSource, intervalMm: number): ContourMap {
  const values = new Float32Array(dm.cols * dm.rows);
  for (let i = 0; i < values.length; i++) {
    const v = dm.depth[i];
    values[i] = v < 0 ? NaN : v;
  }
  const grid: Grid2D = { cols: dm.cols, rows: dm.rows, values };

  const dx = dm.widthMm / dm.cols;
  const dy = dm.heightMm / dm.rows;
  const toMm = (gx: number, gy: number): [number, number] => [(gx + 0.5) * dx, (gy + 0.5) * dy];
  const tol = Math.min(dx, dy) * 0.75;

  const levels: ContourLevel[] = [];
  for (let depth = intervalMm; depth <= dm.maxDepthMm + 1e-6; depth += intervalMm) {
    const segs = isoSegments(grid, depth);
    if (segs.length === 0) continue;
    const polylines = stitch(segs)
      .map((line) => simplifyPolyline(line.map(([x, y]) => toMm(x, y)), tol))
      .filter((line) => line.length >= 2);
    levels.push({ depthMm: Math.round(depth * 100) / 100, polylines });
  }
  return { view: dm.view, widthMm: dm.widthMm, heightMm: dm.heightMm, intervalMm, levels };
}
