/**
 * Orthographic depth maps.
 *
 * For each pixel of a face projection, the depth is the distance from that face
 * of the wooden blank to the first solid voxel of the model along the inward
 * normal — i.e. how deep you must carve at that spot before you reach wood that
 * stays. Values are quantised to a carving-friendly increment to avoid implying
 * false precision.
 */

import { VoxelGrid } from './voxelize';
import { ViewName } from './projection';

export interface DepthMap {
  view: ViewName;
  widthMm: number;
  heightMm: number;
  cols: number;
  rows: number;
  /** Depth from the face in mm, row-major, origin bottom-left. -1 = no model along this ray. */
  depth: Float32Array;
  /** Largest finite depth present, mm. */
  maxDepthMm: number;
  /** Quantisation step used, mm. */
  stepMm: number;
}

export interface DepthOptions {
  /** Quantise depths to this increment (mm). 0 disables. Default 1. */
  quantiseMm?: number;
}

const FACE_DEPTH_VIEWS: ViewName[] = ['front', 'back', 'left', 'right'];
export { FACE_DEPTH_VIEWS };

export function depthMap(grid: VoxelGrid, view: ViewName, opts: DepthOptions = {}): DepthMap {
  const step = opts.quantiseMm ?? 1;
  const { nx, ny, nz, d, data } = grid;
  const solid = (i: number, j: number, k: number) => data[i + nx * (j + ny * k)] === 1;

  let cols: number, rows: number, widthMm: number, heightMm: number;
  let firstHit: (c: number, r: number) => number;

  switch (view) {
    case 'front':
      cols = nx; rows = ny; widthMm = grid.blank.width; heightMm = grid.blank.height;
      firstHit = (c, r) => { for (let k = 0; k < nz; k++) if (solid(c, r, k)) return (k + 0.5) * d[2]; return -1; };
      break;
    case 'back':
      cols = nx; rows = ny; widthMm = grid.blank.width; heightMm = grid.blank.height;
      firstHit = (c, r) => { const i = nx - 1 - c; for (let k = nz - 1; k >= 0; k--) if (solid(i, r, k)) return (nz - k - 0.5) * d[2]; return -1; };
      break;
    case 'left':
      cols = nz; rows = ny; widthMm = grid.blank.depth; heightMm = grid.blank.height;
      firstHit = (c, r) => { for (let i = 0; i < nx; i++) if (solid(i, r, c)) return (i + 0.5) * d[0]; return -1; };
      break;
    case 'right':
      cols = nz; rows = ny; widthMm = grid.blank.depth; heightMm = grid.blank.height;
      firstHit = (c, r) => { const k = nz - 1 - c; for (let i = nx - 1; i >= 0; i--) if (solid(i, r, k)) return (nx - i - 0.5) * d[0]; return -1; };
      break;
    case 'top':
      cols = nx; rows = nz; widthMm = grid.blank.width; heightMm = grid.blank.depth;
      firstHit = (c, r) => { const k = nz - 1 - r; for (let j = ny - 1; j >= 0; j--) if (solid(c, j, k)) return (ny - j - 0.5) * d[1]; return -1; };
      break;
    case 'bottom':
      cols = nx; rows = nz; widthMm = grid.blank.width; heightMm = grid.blank.depth;
      firstHit = (c, r) => { for (let j = 0; j < ny; j++) if (solid(c, j, r)) return (j + 0.5) * d[1]; return -1; };
      break;
    default:
      throw new Error(`unknown view: ${view as string}`);
  }

  const depth = new Float32Array(cols * rows);
  let maxDepthMm = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let v = firstHit(c, r);
      if (v >= 0) {
        if (step > 0) v = Math.round(v / step) * step;
        if (v > maxDepthMm) maxDepthMm = v;
      }
      depth[r * cols + c] = v;
    }
  }
  return { view, widthMm, heightMm, cols, rows, depth, maxDepthMm, stepMm: step };
}

/** Sample depth (mm) at a physical point on the face, or -1 if outside the silhouette. */
export function sampleDepthAt(dm: DepthMap, xMm: number, yMm: number): number {
  const c = Math.floor((xMm / dm.widthMm) * dm.cols);
  const r = Math.floor((yMm / dm.heightMm) * dm.rows);
  if (c < 0 || r < 0 || c >= dm.cols || r >= dm.rows) return -1;
  return dm.depth[r * dm.cols + c];
}
