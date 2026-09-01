/**
 * Symmetry enforcement.
 *
 * Museum scans of symmetric subjects (figures, tools, vessels) are never quite
 * symmetric — the scan is noisy and the object has warped. Carving from a
 * lopsided template just bakes that error into the wood.
 *
 * We enforce symmetry on the *voxel grid*, not the mesh: OR the occupancy with
 * its mirror image across the solid's mid-plane on one axis. Union (not
 * intersection) is deliberate — it can only add material, never tell you to cut
 * away something that is really there. Doing it on the grid also sidesteps the
 * parity-fill breakage you'd get from merging two closed triangle soups.
 */

import { VoxelGrid } from './voxelize';
import { Mesh, computeBounds, mergeMeshes } from './mesh';

/** 0 = X (width), 1 = Y (height), 2 = Z (depth). */
export type Axis = 0 | 1 | 2;

/**
 * Mesh + its mirror across the bounding-box mid-plane of `axis`, merged.
 *
 * Safe for *rasterisation* (silhouettes, depth maps) which just unions projected
 * triangles — NOT for parity voxelisation, which needs `symmetrizeGrid`.
 */
export function mirrorMesh(mesh: Mesh, axis: Axis): Mesh {
  const b = computeBounds(mesh);
  const mid = (b.min[axis] + b.max[axis]) / 2;
  const src = mesh.positions;
  const mirrored = new Float32Array(src.length);
  for (let t = 0; t < src.length; t += 9) {
    for (let v = 0; v < 3; v++) {
      const dst = v === 1 ? 2 : v === 2 ? 1 : 0; // reverse winding
      for (let c = 0; c < 3; c++) {
        const value = src[t + v * 3 + c];
        mirrored[t + dst * 3 + c] = c === axis ? 2 * mid - value : value;
      }
    }
  }
  return mergeMeshes([mesh, { positions: mirrored }]);
}

/**
 * Return a copy of `grid.data` mirrored across the solid's bounding-box centre
 * on `axis` and unioned with the original.
 */
export function symmetrizeGrid(grid: VoxelGrid, axis: Axis): Uint8Array {
  const { nx, ny, nz, data } = grid;
  const dim = [nx, ny, nz][axis];
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);

  // Solid extent along the mirror axis → mirror about its centre so an
  // off-centre placement doesn't shear the shape.
  let lo = dim;
  let hi = -1;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!data[idx(i, j, k)]) continue;
        const a = axis === 0 ? i : axis === 1 ? j : k;
        if (a < lo) lo = a;
        if (a > hi) hi = a;
      }
  if (hi < 0) return data.slice();

  const twoC = lo + hi; // mirror(a) = lo + hi - a
  const out = data.slice();
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!data[idx(i, j, k)]) continue;
        const mi = axis === 0 ? twoC - i : i;
        const mj = axis === 1 ? twoC - j : j;
        const mk = axis === 2 ? twoC - k : k;
        if (mi < 0 || mi >= nx || mj < 0 || mj >= ny || mk < 0 || mk >= nz) continue;
        out[idx(mi, mj, mk)] = 1;
      }
  return out;
}
