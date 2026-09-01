/**
 * Solid voxelisation of a triangle soup inside the wooden blank.
 *
 * Method: parity / ray-stabbing fill. For each grid column along an axis we find
 * every triangle the column pierces, sort the hit coordinates, and fill the
 * spans between successive crossings (even-odd rule). We do this along all three
 * axes and keep a voxel solid when at least 2 of the 3 axes agree — this makes
 * the result robust to the small holes and non-manifold edges common in museum
 * scans, which would otherwise leak an axis-aligned flood fill.
 *
 * The same primitive yields orthographic depth maps for free (the first crossing
 * from each face), so voxelisation is the backbone of the whole analysis stage.
 */

import { Mesh, Vec3 } from './mesh';
import { Blank } from './blank';
import { getKernel } from './wasm';

export interface VoxelGrid {
  nx: number;
  ny: number;
  nz: number;
  /** Cell size per axis, mm. */
  d: Vec3;
  /** Origin (min corner) in blank space, mm. */
  origin: Vec3;
  blank: Blank;
  /** Occupancy, 1 = solid. Index = i + nx*(j + ny*k). */
  data: Uint8Array;
}

export const voxelIndex = (g: VoxelGrid, i: number, j: number, k: number): number =>
  i + g.nx * (j + g.ny * k);

export function gridForBlank(blank: Blank, approxCells: number): { nx: number; ny: number; nz: number; d: Vec3; origin: Vec3 } {
  // Aim for cubic voxels with ~approxCells along the largest blank axis.
  const maxDim = Math.max(blank.width, blank.height, blank.depth);
  const cell = maxDim / approxCells;
  const nx = Math.max(2, Math.round(blank.width / cell));
  const ny = Math.max(2, Math.round(blank.height / cell));
  const nz = Math.max(2, Math.round(blank.depth / cell));
  const d: Vec3 = [blank.width / nx, blank.height / ny, blank.depth / nz];
  // Sub-voxel, per-axis irrational jitter of the grid origin. Keeps the sample
  // points off exact triangle vertices/edges (a perfectly axis-aligned CAD
  // cylinder would otherwise leave its centre column unfilled), without any
  // visible effect on the result.
  const J: Vec3 = [0.000713, 0.000531, 0.000374];
  return {
    nx,
    ny,
    nz,
    d,
    origin: [
      -blank.width / 2 + d[0] * J[0],
      -blank.height / 2 + d[1] * J[1],
      -blank.depth / 2 + d[2] * J[2],
    ],
  };
}

const AXES: Record<0 | 1 | 2, [number, number, number]> = {
  0: [1, 2, 0], // fill along X; plane = (Y,Z)
  1: [0, 2, 1], // fill along Y; plane = (X,Z)
  2: [0, 1, 2], // fill along Z; plane = (X,Y)
};

function fillAxis(
  positions: Float32Array,
  n: [number, number, number],
  d: Vec3,
  origin: Vec3,
  axis: 0 | 1 | 2,
  out: Uint8Array,
) {
  const [u, v, w] = AXES[axis];
  const nu = n[u];
  const nv = n[v];
  const nw = n[w];
  const ou = origin[u];
  const ov = origin[v];
  const ow = origin[w];
  const du = d[u];
  const dv = d[v];
  const dw = d[w];

  // Per-column list of crossing coordinates along axis w.
  const cols: number[][] = new Array(nu * nv);

  for (let t = 0; t < positions.length; t += 9) {
    const au = positions[t + u], av = positions[t + v], aw = positions[t + w];
    const bu = positions[t + 3 + u], bv = positions[t + 3 + v], bw = positions[t + 3 + w];
    const cu = positions[t + 6 + u], cv = positions[t + 6 + v], cw = positions[t + 6 + w];

    const minU = Math.min(au, bu, cu);
    const maxU = Math.max(au, bu, cu);
    const minV = Math.min(av, bv, cv);
    const maxV = Math.max(av, bv, cv);

    let i0 = Math.ceil((minU - ou) / du - 0.5);
    let i1 = Math.floor((maxU - ou) / du - 0.5);
    let j0 = Math.ceil((minV - ov) / dv - 0.5);
    let j1 = Math.floor((maxV - ov) / dv - 0.5);
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 > nu - 1) i1 = nu - 1;
    if (j1 > nv - 1) j1 = nv - 1;
    if (i0 > i1 || j0 > j1) continue;

    const detT = (bv - cv) * (au - cu) + (cu - bu) * (av - cv);
    if (Math.abs(detT) < 1e-12) continue;
    const invDet = 1 / detT;

    for (let i = i0; i <= i1; i++) {
      const pu = ou + (i + 0.5) * du;
      for (let j = j0; j <= j1; j++) {
        const pv = ov + (j + 0.5) * dv;
        const l1 = ((bv - cv) * (pu - cu) + (cu - bu) * (pv - cv)) * invDet;
        const l2 = ((cv - av) * (pu - cu) + (au - cu) * (pv - cv)) * invDet;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const hitW = l1 * aw + l2 * bw + l3 * cw;
        const key = i + nu * j;
        (cols[key] || (cols[key] = [])).push(hitW);
      }
    }
  }

  const strideOf = [1, n[0], n[0] * n[1]];
  const su = strideOf[u];
  const sv = strideOf[v];
  const sw = strideOf[w];

  for (let key = 0; key < cols.length; key++) {
    const list = cols[key];
    if (!list || list.length < 2) continue;
    list.sort((a, b) => a - b);
    const i = key % nu;
    const j = (key - i) / nu;
    const baseIdx = i * su + j * sv;
    for (let s = 0; s + 1 < list.length; s += 2) {
      const wa = list[s];
      const wb = list[s + 1];
      let k0 = Math.ceil((wa - ow) / dw - 0.5);
      let k1 = Math.floor((wb - ow) / dw - 0.5);
      if (k0 < 0) k0 = 0;
      if (k1 > nw - 1) k1 = nw - 1;
      for (let k = k0; k <= k1; k++) out[baseIdx + k * sw]++;
    }
  }
}

export interface VoxelizeOptions {
  approxCells?: number;
  /** 1 = fast (Z only), 3 = robust majority vote. Default 3. */
  axes?: 1 | 3;
}

export function voxelize(mesh: Mesh, blank: Blank, opts: VoxelizeOptions = {}): VoxelGrid {
  const approxCells = opts.approxCells ?? 64;
  const axes = opts.axes ?? 3;
  const { nx, ny, nz, d, origin } = gridForBlank(blank, approxCells);

  const kernel = getKernel();
  if (kernel) {
    try {
      const data = kernel.voxelize(mesh.positions, { nx, ny, nz }, d, origin, axes);
      return { nx, ny, nz, d, origin, blank, data };
    } catch {
      /* fall through to the JS path */
    }
  }

  const n: [number, number, number] = [nx, ny, nz];
  const votes = new Uint8Array(nx * ny * nz);
  const axisList: (0 | 1 | 2)[] = axes === 1 ? [2] : [0, 1, 2];
  for (const ax of axisList) {
    const partial = new Uint8Array(nx * ny * nz);
    fillAxis(mesh.positions, n, d, origin, ax, partial);
    for (let i = 0; i < votes.length; i++) if (partial[i] > 0) votes[i]++;
  }

  const threshold = axes === 1 ? 1 : 2;
  const data = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < data.length; i++) data[i] = votes[i] >= threshold ? 1 : 0;

  return { nx, ny, nz, d, origin, blank, data };
}

export function countSolid(g: { data: Uint8Array }): number {
  let c = 0;
  for (let i = 0; i < g.data.length; i++) c += g.data[i];
  return c;
}

export const voxelVolume = (g: VoxelGrid): number => g.d[0] * g.d[1] * g.d[2];

/** Solid volume in mm^3. */
export const solidVolume = (g: VoxelGrid): number => countSolid(g) * voxelVolume(g);

/** Voxel centre position in blank space. */
export function voxelCenter(g: VoxelGrid, i: number, j: number, k: number): Vec3 {
  return [
    g.origin[0] + (i + 0.5) * g.d[0],
    g.origin[1] + (j + 0.5) * g.d[1],
    g.origin[2] + (k + 0.5) * g.d[2],
  ];
}

export function makeGridLike(g: VoxelGrid, data?: Uint8Array): VoxelGrid {
  return { ...g, data: data ?? new Uint8Array(g.data.length) };
}
