/**
 * Undercut detection.
 *
 * A surface point is an "undercut" if a straight tool coming from any of the six
 * axis directions is blocked by the model itself before it can reach that point
 * — i.e. it sits behind an overhang. These are the spots a knife physically
 * cannot get to without bent tools or accepting some simplification, so it's
 * worth showing *where* they are, not just scoring how many.
 */

import { VoxelGrid } from './voxelize';
import { getKernel } from './wasm';

export interface UndercutResult {
  /** Grid-sized, 1 where a solid surface voxel is unreachable from every axis. */
  mask: Uint8Array;
  surfaceVoxels: number;
  undercutVoxels: number;
  fraction: number;
}

export function undercutMask(g: VoxelGrid): UndercutResult {
  const { nx, ny, nz, data } = g;

  const kernel = getKernel();
  if (kernel) {
    try {
      const r = kernel.undercutMask(data, { nx, ny, nz });
      return {
        mask: r.mask,
        surfaceVoxels: r.surfaceVoxels,
        undercutVoxels: r.undercutVoxels,
        fraction: r.surfaceVoxels === 0 ? 0 : r.undercutVoxels / r.surfaceVoxels,
      };
    } catch {
      /* fall through to JS */
    }
  }

  const at = (i: number, j: number, k: number) =>
    i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : data[i + nx * (j + ny * k)];
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);

  // Accessible from at least one of the 6 axis directions = the first solid voxel
  // encountered scanning inward along that axis for its column.
  const accessible = new Uint8Array(nx * ny * nz);

  // +Z / -Z
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      for (let k = nz - 1; k >= 0; k--) if (data[idx(i, j, k)]) { accessible[idx(i, j, k)] = 1; break; }
      for (let k = 0; k < nz; k++) if (data[idx(i, j, k)]) { accessible[idx(i, j, k)] = 1; break; }
    }
  // +X / -X
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      for (let i = nx - 1; i >= 0; i--) if (data[idx(i, j, k)]) { accessible[idx(i, j, k)] = 1; break; }
      for (let i = 0; i < nx; i++) if (data[idx(i, j, k)]) { accessible[idx(i, j, k)] = 1; break; }
    }
  // +Y / -Y
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) {
      for (let j = ny - 1; j >= 0; j--) if (data[idx(i, j, k)]) { accessible[idx(i, j, k)] = 1; break; }
      for (let j = 0; j < ny; j++) if (data[idx(i, j, k)]) { accessible[idx(i, j, k)] = 1; break; }
    }

  const mask = new Uint8Array(nx * ny * nz);
  let surfaceVoxels = 0;
  let undercutVoxels = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!data[idx(i, j, k)]) continue;
        const surface =
          !at(i + 1, j, k) || !at(i - 1, j, k) ||
          !at(i, j + 1, k) || !at(i, j - 1, k) ||
          !at(i, j, k + 1) || !at(i, j, k - 1);
        if (!surface) continue;
        surfaceVoxels++;
        if (!accessible[idx(i, j, k)]) {
          mask[idx(i, j, k)] = 1;
          undercutVoxels++;
        }
      }

  return {
    mask,
    surfaceVoxels,
    undercutVoxels,
    fraction: surfaceVoxels === 0 ? 0 : undercutVoxels / surfaceVoxels,
  };
}
