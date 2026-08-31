/**
 * Orthographic projections (silhouettes) of the placed model.
 *
 * These are true parallel projections onto each face of the wooden blank — NOT a
 * UV unwrap. They carry real millimetre dimensions so the outline can be traced
 * straight onto the wood.
 */

import { VoxelGrid } from './voxelize';
import { Grid2D, isoSegments, stitch } from './marchingSquares';

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export const ALL_VIEWS: ViewName[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

export interface Projection {
  view: ViewName;
  /** Width / height of the projection plane, mm — equals the corresponding blank face. */
  widthMm: number;
  heightMm: number;
  cols: number;
  rows: number;
  /** Occupancy mask, row-major, origin at bottom-left of the drawn face, 1 = model present. */
  mask: Uint8Array;
  /** Human labels for the two in-plane axes, e.g. "X →", "Y ↑". */
  axisLabels: [string, string];
}

/**
 * Build a projection by flattening the voxel grid along the view direction.
 *
 * Plane axes are chosen so the drawing reads naturally when you hold that face of
 * the blank towards you:
 *   front  : +X right, +Y up   (look along -Z)
 *   back   : -X right, +Y up   (look along +Z)
 *   left   : +Z right, +Y up   (look along -X)  [note: +Z points at original viewer]
 *   right  : -Z right, +Y up   (look along +X)
 *   top    : +X right, -Z up   (look along -Y)  ("up" in drawing = towards back)
 *   bottom : +X right, +Z up   (look along +Y)
 */
export function project(grid: VoxelGrid, view: ViewName): Projection {
  const { nx, ny, nz, d, data } = grid;
  const solid = (i: number, j: number, k: number) => data[i + nx * (j + ny * k)] === 1;

  let cols: number, rows: number, widthMm: number, heightMm: number;
  let axisLabels: [string, string];
  let sample: (c: number, r: number) => boolean;

  switch (view) {
    case 'front':
      cols = nx; rows = ny; widthMm = grid.blank.width; heightMm = grid.blank.height;
      axisLabels = ['X →', 'Y ↑'];
      sample = (c, r) => { for (let k = 0; k < nz; k++) if (solid(c, r, k)) return true; return false; };
      break;
    case 'back':
      cols = nx; rows = ny; widthMm = grid.blank.width; heightMm = grid.blank.height;
      axisLabels = ['X ←', 'Y ↑'];
      sample = (c, r) => { const i = nx - 1 - c; for (let k = 0; k < nz; k++) if (solid(i, r, k)) return true; return false; };
      break;
    case 'left':
      cols = nz; rows = ny; widthMm = grid.blank.depth; heightMm = grid.blank.height;
      axisLabels = ['Z →', 'Y ↑'];
      sample = (c, r) => { for (let i = 0; i < nx; i++) if (solid(i, r, c)) return true; return false; };
      break;
    case 'right':
      cols = nz; rows = ny; widthMm = grid.blank.depth; heightMm = grid.blank.height;
      axisLabels = ['Z ←', 'Y ↑'];
      sample = (c, r) => { const k = nz - 1 - c; for (let i = 0; i < nx; i++) if (solid(i, r, k)) return true; return false; };
      break;
    case 'top':
      cols = nx; rows = nz; widthMm = grid.blank.width; heightMm = grid.blank.depth;
      axisLabels = ['X →', 'Z ↓ (back)'];
      sample = (c, r) => { const k = nz - 1 - r; for (let j = 0; j < ny; j++) if (solid(c, j, k)) return true; return false; };
      break;
    case 'bottom':
      cols = nx; rows = nz; widthMm = grid.blank.width; heightMm = grid.blank.depth;
      axisLabels = ['X →', 'Z ↑ (back)'];
      sample = (c, r) => { for (let j = 0; j < ny; j++) if (solid(c, j, r)) return true; return false; };
      break;
    default:
      throw new Error(`unknown view: ${view as string}`);
  }

  const mask = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      mask[r * cols + c] = sample(c, r) ? 1 : 0;
    }
  }
  // d is per axis [dx,dy,dz]; the plane spacing is implied by widthMm/cols etc.
  void d;
  return { view, widthMm, heightMm, cols, rows, mask, axisLabels };
}

/** Fraction of the blank face covered by the silhouette. */
export function coverage(p: Projection): number {
  let s = 0;
  for (let i = 0; i < p.mask.length; i++) s += p.mask[i];
  return s / p.mask.length;
}

/** Axis-aligned extent of the silhouette within the face, mm: [x0,y0,x1,y1]. */
export function silhouetteExtent(p: Projection): [number, number, number, number] {
  let minC = p.cols, minR = p.rows, maxC = -1, maxR = -1;
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      if (p.mask[r * p.cols + c]) {
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }
    }
  }
  if (maxC < 0) return [0, 0, 0, 0];
  const dx = p.widthMm / p.cols;
  const dy = p.heightMm / p.rows;
  return [minC * dx, minR * dy, (maxC + 1) * dx, (maxR + 1) * dy];
}

/** Outline polylines of the silhouette, in millimetres, origin at face bottom-left. */
export function outlinePolylines(p: Projection): number[][][] {
  // Pad the mask by one cell so edges that touch the border still close.
  const padCols = p.cols + 2;
  const padRows = p.rows + 2;
  const values = new Float32Array(padCols * padRows);
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      values[(r + 1) * padCols + (c + 1)] = p.mask[r * p.cols + c];
    }
  }
  const grid: Grid2D = { cols: padCols, rows: padRows, values };
  const segs = isoSegments(grid, 0.5);
  const dx = p.widthMm / p.cols;
  const dy = p.heightMm / p.rows;
  // grid coords: cell centre (c+1) maps to mm (c+0.5)*dx  => mm = (gx-1+0.5)*dx = (gx-0.5)*dx
  const toMm = (gx: number, gy: number): [number, number] => [
    (gx - 0.5) * dx,
    (gy - 0.5) * dy,
  ];
  return stitch(segs).map((line) => line.map(([x, y]) => {
    const [mx, my] = toMm(x, y);
    return [mx, my];
  }));
}
