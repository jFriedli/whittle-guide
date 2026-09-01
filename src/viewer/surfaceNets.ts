/**
 * Naive Surface Nets (after Mikola Lysenko / S.F. Gibson) to turn a blocky voxel
 * occupancy grid into a smooth watertight mesh for the 3-D workspace. This is a
 * *rendering* aid only — templates, depth maps, contours and the carving-stage
 * volumes are all computed on the crisp voxel data, not on this mesh.
 *
 * Three things that bit the first version and are handled here:
 *  1. Surface Nets can only mesh a cell that *straddles* the isosurface, so a
 *     volume that reaches the grid boundary (stages 1–4) would lose its outer
 *     faces. Fix: pad the grid with a one-cell empty border.
 *  2. A field pre-blur can dissolve one-voxel-thick regions (mid stages) → holes.
 *     Fix: blur is off by default and, when on, never lets an originally-solid
 *     voxel fall below the iso level.
 *  3. Plain Laplacian smoothing shrinks the mesh (final stage looked undersized).
 *     Fix: shrink-free Taubin smoothing (λ / μ alternation).
 *
 * Plus a safety net: if the result has far fewer triangles than the surface-voxel
 * count implies, fall back to the exact per-face cube mesher.
 */

import * as THREE from 'three';
import { VoxelDims, buildVoxelGeometry } from './voxelMesh';

const CUBE_EDGES = new Int32Array(24);
const EDGE_TABLE = new Int32Array(256);
(() => {
  let k = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 1; j <= 4; j <<= 1) {
      const p = i ^ j;
      if (i <= p) {
        CUBE_EDGES[k++] = i;
        CUBE_EDGES[k++] = p;
      }
    }
  }
  for (let i = 0; i < 256; i++) {
    let em = 0;
    for (let j = 0; j < 24; j += 2) {
      const a = !!(i & (1 << CUBE_EDGES[j]));
      const b = !!(i & (1 << CUBE_EDGES[j + 1]));
      em |= a !== b ? 1 << (j >> 1) : 0;
    }
    EDGE_TABLE[i] = em;
  }
})();

/** Separable 3-tap box blur of a 0/1 field into a Float32 field. */
function blurField(data: Uint8Array, nx: number, ny: number, nz: number, passes: number): Float32Array {
  let src = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) src[i] = data[i];
  let dst = new Float32Array(data.length);
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  const blurAxis = (ax: 0 | 1 | 2) => {
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          let a: number, b: number, c: number;
          if (ax === 0) {
            a = src[idx(Math.max(0, x - 1), y, z)];
            b = src[idx(x, y, z)];
            c = src[idx(Math.min(nx - 1, x + 1), y, z)];
          } else if (ax === 1) {
            a = src[idx(x, Math.max(0, y - 1), z)];
            b = src[idx(x, y, z)];
            c = src[idx(x, Math.min(ny - 1, y + 1), z)];
          } else {
            a = src[idx(x, y, Math.max(0, z - 1))];
            b = src[idx(x, y, z)];
            c = src[idx(x, y, Math.min(nz - 1, z + 1))];
          }
          dst[idx(x, y, z)] = (a + 2 * b + c) * 0.25;
        }
    [src, dst] = [dst, src];
  };

  for (let p = 0; p < passes; p++) {
    blurAxis(0);
    blurAxis(1);
    blurAxis(2);
  }
  return src;
}

/** One weighted umbrella-operator step: v ← v + factor·(mean(neighbours) − v). */
function smoothStep(pos: Float32Array, nbr: Int32Array[], next: Float32Array, factor: number) {
  const vCount = pos.length / 3;
  for (let v = 0; v < vCount; v++) {
    const list = nbr[v];
    if (list.length === 0) {
      next[v * 3] = pos[v * 3];
      next[v * 3 + 1] = pos[v * 3 + 1];
      next[v * 3 + 2] = pos[v * 3 + 2];
      continue;
    }
    let sx = 0, sy = 0, sz = 0;
    for (const n of list) {
      sx += pos[n * 3];
      sy += pos[n * 3 + 1];
      sz += pos[n * 3 + 2];
    }
    const inv = 1 / list.length;
    next[v * 3] = pos[v * 3] + factor * (sx * inv - pos[v * 3]);
    next[v * 3 + 1] = pos[v * 3 + 1] + factor * (sy * inv - pos[v * 3 + 1]);
    next[v * 3 + 2] = pos[v * 3 + 2] + factor * (sz * inv - pos[v * 3 + 2]);
  }
  pos.set(next);
}

/** Shrink-free Taubin smoothing: a positive (shrinking) step then a negative one. */
function taubinSmooth(pos: Float32Array, indices: Uint32Array, iterations: number) {
  if (iterations <= 0) return;
  const vCount = pos.length / 3;
  const sets: Set<number>[] = Array.from({ length: vCount }, () => new Set<number>());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }
  const nbr = sets.map((s) => Int32Array.from(s));
  const next = new Float32Array(pos.length);
  const lambda = 0.5;
  const mu = -0.53;
  for (let it = 0; it < iterations; it++) {
    smoothStep(pos, nbr, next, lambda);
    smoothStep(pos, nbr, next, mu);
  }
}

export interface SurfaceOptions {
  /** Field blur passes before meshing. Default 0 (blur can dissolve thin regions). */
  blurPasses?: number;
  /** Taubin smoothing iterations. Default 3. */
  smoothIterations?: number;
  /** Iso level (0..1). < 0.5 biases the surface slightly outward. Default 0.5. */
  isoLevel?: number;
}

export function buildSurfaceNetsGeometry(
  data: Uint8Array,
  dims: VoxelDims,
  opts: SurfaceOptions = {},
): THREE.BufferGeometry {
  const { nx, ny, nz, d, origin } = dims;
  const iso = opts.isoLevel ?? 0.5;

  // --- pad with a one-cell empty border so boundary faces get meshed ---
  const pnx = nx + 2, pny = ny + 2, pnz = nz + 2;
  const solid = new Uint8Array(pnx * pny * pnz);
  const pIdx = (x: number, y: number, z: number) => x + pnx * (y + pny * z);
  let solidCount = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        if (data[x + nx * (y + ny * z)]) {
          solid[pIdx(x + 1, y + 1, z + 1)] = 1;
          solidCount++;
        }
  if (solidCount === 0) return new THREE.BufferGeometry();

  let surfaceCount = 0;
  for (let z = 1; z <= nz; z++)
    for (let y = 1; y <= ny; y++)
      for (let x = 1; x <= nx; x++) {
        if (!solid[pIdx(x, y, z)]) continue;
        if (
          !solid[pIdx(x + 1, y, z)] || !solid[pIdx(x - 1, y, z)] ||
          !solid[pIdx(x, y + 1, z)] || !solid[pIdx(x, y - 1, z)] ||
          !solid[pIdx(x, y, z + 1)] || !solid[pIdx(x, y, z - 1)]
        ) surfaceCount++;
      }

  // --- field (optionally blurred, but never below iso where originally solid) ---
  const blurPasses = Math.max(0, opts.blurPasses ?? 0);
  let field: Float32Array;
  if (blurPasses > 0) {
    field = blurField(solid, pnx, pny, pnz, blurPasses);
    for (let i = 0; i < field.length; i++) if (solid[i]) field[i] = Math.max(field[i], iso + 0.06);
  } else {
    field = new Float32Array(solid.length);
    for (let i = 0; i < solid.length; i++) field[i] = solid[i];
  }

  // Padded-grid origin is shifted by -d so a solid voxel at original index i keeps
  // its world position (origin - d) + (i + 1 + frac)·d = origin + (i + frac)·d.
  const ox = origin[0] - d[0], oy = origin[1] - d[1], oz = origin[2] - d[2];
  const val = (x: number, y: number, z: number) => field[pIdx(x, y, z)];
  const ncx = pnx - 1, ncy = pny - 1, ncz = pnz - 1;
  const cellVert = new Int32Array(ncx * ncy * ncz).fill(-1);
  const cIdx = (x: number, y: number, z: number) => x + ncx * (y + ncy * z);

  const positions: number[] = [];
  for (let z = 0; z < ncz; z++) {
    for (let y = 0; y < ncy; y++) {
      for (let x = 0; x < ncx; x++) {
        const g = [
          val(x, y, z), val(x + 1, y, z), val(x, y + 1, z), val(x + 1, y + 1, z),
          val(x, y, z + 1), val(x + 1, y, z + 1), val(x, y + 1, z + 1), val(x + 1, y + 1, z + 1),
        ];
        let mask = 0;
        for (let i = 0; i < 8; i++) if (g[i] > iso) mask |= 1 << i;
        if (mask === 0 || mask === 255) continue;
        const em = EDGE_TABLE[mask];

        let vx = 0, vy = 0, vz = 0, count = 0;
        for (let e = 0; e < 12; e++) {
          if (!(em & (1 << e))) continue;
          const c0 = CUBE_EDGES[2 * e];
          const c1 = CUBE_EDGES[2 * e + 1];
          const a = g[c0];
          const b = g[c1];
          const denom = b - a;
          const t = Math.abs(denom) < 1e-9 ? 0.5 : (iso - a) / denom;
          const o0x = c0 & 1, o0y = (c0 >> 1) & 1, o0z = (c0 >> 2) & 1;
          const o1x = c1 & 1, o1y = (c1 >> 1) & 1, o1z = (c1 >> 2) & 1;
          vx += o0x + t * (o1x - o0x);
          vy += o0y + t * (o1y - o0y);
          vz += o0z + t * (o1z - o0z);
          count++;
        }
        const inv = 1 / count;
        cellVert[cIdx(x, y, z)] = positions.length / 3;
        positions.push(
          ox + (x + vx * inv) * d[0],
          oy + (y + vy * inv) * d[1],
          oz + (z + vz * inv) * d[2],
        );
      }
    }
  }

  const indices: number[] = [];
  const du = 1, dv = ncx, dw = ncx * ncy;
  for (let z = 0; z < ncz; z++) {
    for (let y = 0; y < ncy; y++) {
      for (let x = 0; x < ncx; x++) {
        const m = cIdx(x, y, z);
        if (cellVert[m] < 0) continue;
        const g0 = val(x, y, z) > iso ? 1 : 0;
        if (y > 0 && z > 0) {
          const g1 = val(x + 1, y, z) > iso ? 1 : 0;
          if (g0 !== g1) quad(indices, cellVert, m, m - dv, m - dv - dw, m - dw, g0 === 1);
        }
        if (x > 0 && z > 0) {
          const g2 = val(x, y + 1, z) > iso ? 1 : 0;
          if (g0 !== g2) quad(indices, cellVert, m, m - dw, m - dw - du, m - du, g0 === 1);
        }
        if (x > 0 && y > 0) {
          const g4 = val(x, y, z + 1) > iso ? 1 : 0;
          if (g0 !== g4) quad(indices, cellVert, m, m - du, m - du - dv, m - dv, g0 === 1);
        }
      }
    }
  }

  // Safety net: a healthy Surface Nets mesh has roughly one vertex per surface
  // voxel. Far fewer means something went wrong — use the exact cube mesher.
  if (positions.length / 3 < surfaceCount * 0.25 || indices.length < 6) {
    return buildVoxelGeometry(data, dims);
  }

  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  taubinSmooth(pos, idx, Math.max(0, opts.smoothIterations ?? 3));

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeVertexNormals();
  return geom;
}

function quad(
  out: number[],
  cellVert: Int32Array,
  a: number, b: number, c: number, dd: number,
  flip: boolean,
) {
  const va = cellVert[a], vb = cellVert[b], vc = cellVert[c], vd = cellVert[dd];
  if (va < 0 || vb < 0 || vc < 0 || vd < 0) return;
  if (flip) out.push(va, vb, vc, va, vc, vd);
  else out.push(va, vd, vc, va, vc, vb);
}
