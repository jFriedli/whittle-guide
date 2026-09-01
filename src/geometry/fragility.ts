/**
 * Thin-feature / fragility analysis.
 *
 * A carving breaks at its thinnest cross-grain features — a projecting arm, a
 * narrow neck, a raised fingertip. This computes a local-thickness field on the
 * voxel model (Hildebrand–Rüegsegger opening: the diameter of the largest
 * solid-fitting ball through each point), flags where it drops below a carving
 * threshold, and — given a grain direction — weights features that project
 * *across* the grain, which are the ones that actually snap.
 */

import { VoxelGrid, countSolid } from './voxelize';
import { distanceToSolid } from './distance';

export type GrainAxis = 0 | 1 | 2; // X / Y / Z of the blank

export interface FragilityResult {
  /** Grid-sized, 1 = solid voxel whose local thickness is below the threshold. */
  mask: Uint8Array;
  /** Smallest sustained local thickness, mm (low percentile, ignores end-taper noise). */
  minThicknessMm: number;
  /** Thin voxels / solid voxels. */
  fraction: number;
  /** Of the thin voxels, the fraction that project predominantly across the grain. */
  crossGrainFraction: number;
  thinThresholdMm: number;
}

/**
 * Local-thickness field (mm) capped at `capMm`: for each solid voxel, the
 * diameter of the largest empty-free ball that both fits in the solid and
 * contains that voxel. Painted from every solid voxel's own maximal ball.
 */
function localThickness(g: VoxelGrid): { field: Float32Array; wall: Float32Array; step: number } {
  const { nx, ny, nz, data, d } = g;
  const step = (d[0] + d[1] + d[2]) / 3;
  const inv: VoxelGrid = { ...g, data: new Uint8Array(data.length) };
  for (let i = 0; i < data.length; i++) inv.data[i] = data[i] ? 0 : 1;
  const wall = distanceToSolid(inv); // mm to nearest empty

  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  // Distance ridge: solid voxels with no strictly-deeper 6-neighbour.
  const ridge: number[] = [];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const c = idx(x, y, z);
        if (!data[c] || !isFinite(wall[c])) continue;
        const w = wall[c];
        if (
          (x + 1 < nx && wall[c + 1] > w) || (x > 0 && wall[c - 1] > w) ||
          (y + 1 < ny && wall[c + nx] > w) || (y > 0 && wall[c - nx] > w) ||
          (z + 1 < nz && wall[c + nx * ny] > w) || (z > 0 && wall[c - nx * ny] > w)
        ) continue;
        ridge.push(c);
      }
  ridge.sort((a, b) => wall[b] - wall[a]);

  const field = new Float32Array(data.length);
  for (const c of ridge) {
    const w = wall[c];
    const t = 2 * w;
    const x = c % nx;
    const y = ((c - x) / nx) % ny;
    const z = Math.floor(c / (nx * ny));
    // Cap the ball radius: thickness beyond ~30 mm is "thick" for carving anyway.
    const rv = Math.min(24, Math.max(1, Math.round(w / step)));
    const r2 = rv * rv;
    for (let dz = -rv; dz <= rv; dz++) {
      const zz = z + dz;
      if (zz < 0 || zz >= nz) continue;
      for (let dy = -rv; dy <= rv; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ny) continue;
        const rowRem = r2 - dz * dz - dy * dy;
        if (rowRem < 0) continue;
        const xr = Math.floor(Math.sqrt(rowRem));
        const base = idx(0, yy, zz);
        for (let xx = Math.max(0, x - xr); xx <= Math.min(nx - 1, x + xr); xx++) {
          const n = base + xx;
          if (data[n] && t > field[n]) field[n] = t;
        }
      }
    }
  }
  return { field, wall, step };
}

export function estimateMinFeatureMm(g: VoxelGrid): number {
  if (countSolid(g) === 0) return 0;
  const { field, wall, step } = localThickness(g);
  // Sub-surface voxels only (≥ ~1.5 voxels deep): excludes the ever-thin
  // skin/edges/corners of a chunky solid and the last-mm tip of any feature.
  const vals: number[] = [];
  for (let i = 0; i < field.length; i++) if (g.data[i] && wall[i] > step * 1.5) vals.push(field[i]);
  if (vals.length === 0) return Math.max(step, 3 * step);
  vals.sort((a, b) => a - b);

  // If there's a distinguishable body of thin material (a feature, not just a
  // sharp edge), report its thickness; otherwise report the model's 10th
  // percentile — a solid block's edges are "locally thin" but that's not a
  // fragile feature.
  const thinBody = vals.filter((v) => v < 5).length;
  const ix = thinBody >= 25
    ? Math.min(vals.length - 1, Math.max(10, Math.floor(vals.length * 0.01)))
    : Math.floor(vals.length * 0.1);
  return Math.max(step, vals[Math.min(vals.length - 1, ix)]);
}

export function analyseFragility(
  g: VoxelGrid,
  grainAxis: GrainAxis = 1,
  thinThresholdMm = 4,
): FragilityResult {
  const { nx, ny, data, d } = g;
  const { field } = localThickness(g);

  const mask = new Uint8Array(data.length);
  let solid = 0, thin = 0;
  // For the cross-grain measure: PCA of the thin-voxel cloud. A thin region
  // whose spread is mostly perpendicular to the grain (a cantilevered arm) is
  // the one that snaps; a thin region that runs with the grain (a tall neck) is
  // relatively safe.
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    solid++;
    if (field[i] >= thinThresholdMm) continue;
    mask[i] = 1;
    thin++;
    const x = i % nx;
    const y = ((i - x) / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    sx += x; sy += y; sz += z;
  }

  let crossGrainFraction = 0;
  if (thin >= 8) {
    const mxc = sx / thin, myc = sy / thin, mzc = sz / thin;
    let vAlong = 0, vAcross = 0;
    for (let i = 0; i < data.length; i++) {
      if (!mask[i]) continue;
      const x = i % nx;
      const y = ((i - x) / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      const dv = [(x - mxc) * d[0], (y - myc) * d[1], (z - mzc) * d[2]];
      vAlong += dv[grainAxis] * dv[grainAxis];
      vAcross += dv[(grainAxis + 1) % 3] ** 2 + dv[(grainAxis + 2) % 3] ** 2;
    }
    // vAcross covers 2 axes; halve it for a fair per-axis comparison.
    const across = vAcross / 2;
    crossGrainFraction = across + vAlong > 0 ? across / (across + vAlong) : 0;
  }

  return {
    mask,
    minThicknessMm: Math.round(estimateMinFeatureMm(g) * 10) / 10,
    fraction: solid ? thin / solid : 0,
    crossGrainFraction,
    thinThresholdMm,
  };
}
