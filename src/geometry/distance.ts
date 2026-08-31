/**
 * 3-D distance transform + morphological dilation on a voxel grid.
 * Chamfer approximation of the Euclidean distance (weights 1 / √2 / √3), scaled
 * by the (near-cubic) voxel size. Adequate for carving safety margins.
 */

import { VoxelGrid } from './voxelize';
import { getKernel } from './wasm';

const A = 1;
const B = Math.SQRT2;
const C = Math.sqrt(3);

/** Distance in mm from every voxel to the nearest solid voxel (0 inside solid). */
export function distanceToSolid(g: VoxelGrid): Float32Array {
  const { nx, ny, nz, data, d } = g;
  const scale = (d[0] + d[1] + d[2]) / 3;
  const N = nx * ny * nz;

  const kernel = getKernel();
  if (kernel) {
    try {
      return kernel.distanceTransform(data, { nx, ny, nz }, scale);
    } catch {
      /* fall through */
    }
  }
  const dist = new Float32Array(N);
  const BIG = 1e9;
  for (let i = 0; i < N; i++) dist[i] = data[i] ? 0 : BIG;

  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const relax = (x: number, y: number, z: number, offs: [number, number, number, number][]) => {
    const here = idx(x, y, z);
    let best = dist[here];
    for (const [ox, oy, oz, w] of offs) {
      const xx = x + ox, yy = y + oy, zz = z + oz;
      if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
      const cand = dist[idx(xx, yy, zz)] + w;
      if (cand < best) best = cand;
    }
    dist[here] = best;
  };

  // Forward pass neighbour offsets (already-visited voxels).
  const fwd: [number, number, number, number][] = [];
  const bwd: [number, number, number, number][] = [];
  for (let oz = -1; oz <= 1; oz++)
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0 && oz === 0) continue;
        const man = Math.abs(ox) + Math.abs(oy) + Math.abs(oz);
        const w = man === 1 ? A : man === 2 ? B : C;
        const order = oz * 100 + oy * 10 + ox;
        if (order < 0) fwd.push([ox, oy, oz, w]);
        else bwd.push([ox, oy, oz, w]);
      }

  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) relax(x, y, z, fwd);
  for (let z = nz - 1; z >= 0; z--)
    for (let y = ny - 1; y >= 0; y--)
      for (let x = nx - 1; x >= 0; x--) relax(x, y, z, bwd);

  for (let i = 0; i < N; i++) dist[i] = dist[i] >= BIG ? Infinity : dist[i] * scale;
  return dist;
}

/** Dilate a solid mask by `radiusMm`: 1 where distance-to-solid <= radius. */
export function dilate(g: VoxelGrid, radiusMm: number, dist?: Float32Array): Uint8Array {
  const dd = dist ?? distanceToSolid(g);
  const out = new Uint8Array(dd.length);
  for (let i = 0; i < dd.length; i++) out[i] = dd[i] <= radiusMm + 1e-6 ? 1 : 0;
  return out;
}

/** Erode a solid mask by `radiusMm` (dilation of the complement). */
export function erode(g: VoxelGrid, radiusMm: number): Uint8Array {
  const inv: VoxelGrid = { ...g, data: new Uint8Array(g.data.length) };
  for (let i = 0; i < inv.data.length; i++) inv.data[i] = g.data[i] ? 0 : 1;
  const distOut = distanceToSolid(inv);
  const out = new Uint8Array(g.data.length);
  for (let i = 0; i < out.length; i++) out[i] = distOut[i] > radiusMm + 1e-6 ? 1 : 0;
  return out;
}
