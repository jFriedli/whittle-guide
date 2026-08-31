/**
 * Contour maps derived from depth maps — a topographic map of the sculpture as
 * seen from each side, to be printed and transferred to the wood.
 */

import { DepthMap } from './depthMap';
import { Grid2D, isoSegments, stitch } from './marchingSquares';

export interface ContourLevel {
  depthMm: number;
  /** Polylines in millimetres, origin at face bottom-left. */
  polylines: number[][][];
}

export interface ContourMap {
  view: DepthMap['view'];
  widthMm: number;
  heightMm: number;
  intervalMm: number;
  levels: ContourLevel[];
}

export const CONTOUR_INTERVALS = [2, 5, 10] as const;
export type ContourInterval = (typeof CONTOUR_INTERVALS)[number];

export function contourMap(dm: DepthMap, intervalMm: number): ContourMap {
  const values = new Float32Array(dm.cols * dm.rows);
  for (let i = 0; i < values.length; i++) {
    const v = dm.depth[i];
    values[i] = v < 0 ? NaN : v;
  }
  const grid: Grid2D = { cols: dm.cols, rows: dm.rows, values };

  const dx = dm.widthMm / dm.cols;
  const dy = dm.heightMm / dm.rows;
  const toMm = (gx: number, gy: number): [number, number] => [(gx + 0.5) * dx, (gy + 0.5) * dy];

  const levels: ContourLevel[] = [];
  for (let depth = intervalMm; depth <= dm.maxDepthMm + 1e-6; depth += intervalMm) {
    const segs = isoSegments(grid, depth);
    if (segs.length === 0) continue;
    const polylines = stitch(segs).map((line) =>
      line.map(([x, y]) => {
        const [mx, my] = toMm(x, y);
        return [mx, my];
      }),
    );
    levels.push({ depthMm: Math.round(depth * 100) / 100, polylines });
  }
  return { view: dm.view, widthMm: dm.widthMm, heightMm: dm.heightMm, intervalMm, levels };
}
