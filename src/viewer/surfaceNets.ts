/**
 * Naive Surface Nets (after Mikola Lysenko / S.F. Gibson) + a field pre-blur, to
 * turn a blocky voxel occupancy grid into a smooth watertight mesh for the 3-D
 * workspace. Only the *preview* is smoothed — templates, depth maps and the
 * carving-stage volumes are still computed on the crisp voxel data.
 */

import * as THREE from 'three';
import { VoxelDims } from './voxelMesh';

// Edges of the unit cube, as pairs of corner indices. Corner i has offset
// (i&1, (i>>1)&1, (i>>2)&1). Generated once, matches Lysenko's ordering so that
// edges 0/1/2 are the +x / +y / +z edges leaving corner 0.
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

/** Separable 3-tap box blur of a 0/1 field into a Float32 field. `passes` ≥ 1. */
function blurField(data: Uint8Array, nx: number, ny: number, nz: number, passes: number): Float32Array {
  let src = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) src[i] = data[i];
  let dst = new Float32Array(data.length);
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  const blurAxis = (ax: 0 | 1 | 2) => {
    const [n0, n1, n2] = [nx, ny, nz];
    for (let z = 0; z < n2; z++) {
      for (let y = 0; y < n1; y++) {
        for (let x = 0; x < n0; x++) {
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
      }
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

/** Laplacian (umbrella) smoothing over an indexed triangle mesh, in place. */
function laplacianSmooth(pos: Float32Array, indices: Uint32Array, iterations: number, lambda: number) {
  const vCount = pos.length / 3;
  const neighbours: Set<number>[] = Array.from({ length: vCount }, () => new Set<number>());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    neighbours[a].add(b); neighbours[a].add(c);
    neighbours[b].add(a); neighbours[b].add(c);
    neighbours[c].add(a); neighbours[c].add(b);
  }
  const next = new Float32Array(pos.length);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < vCount; v++) {
      const nb = neighbours[v];
      if (nb.size === 0) {
        next[v * 3] = pos[v * 3];
        next[v * 3 + 1] = pos[v * 3 + 1];
        next[v * 3 + 2] = pos[v * 3 + 2];
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (const n of nb) {
        sx += pos[n * 3];
        sy += pos[n * 3 + 1];
        sz += pos[n * 3 + 2];
      }
      const inv = 1 / nb.size;
      next[v * 3] = pos[v * 3] + lambda * (sx * inv - pos[v * 3]);
      next[v * 3 + 1] = pos[v * 3 + 1] + lambda * (sy * inv - pos[v * 3 + 1]);
      next[v * 3 + 2] = pos[v * 3 + 2] + lambda * (sz * inv - pos[v * 3 + 2]);
    }
    pos.set(next);
  }
}

export interface SurfaceOptions {
  /** Field blur passes before meshing (more = smoother, softer detail). Default 1. */
  blurPasses?: number;
  /** Laplacian smoothing iterations on the output mesh. Default 2. */
  smoothIterations?: number;
}

/**
 * Build a smooth surface mesh from a voxel occupancy grid at iso = 0.5.
 */
export function buildSurfaceNetsGeometry(
  data: Uint8Array,
  dims: VoxelDims,
  opts: SurfaceOptions = {},
): THREE.BufferGeometry {
  const { nx, ny, nz, d, origin } = dims;
  const iso = 0.5;
  const field = blurField(data, nx, ny, nz, Math.max(0, opts.blurPasses ?? 1));

  const val = (x: number, y: number, z: number) => field[x + nx * (y + ny * z)];
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cIdx = (x: number, y: number, z: number) => x + (nx - 1) * (y + (ny - 1) * z);

  const positions: number[] = [];

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
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
          origin[0] + (x + vx * inv) * d[0],
          origin[1] + (y + vy * inv) * d[1],
          origin[2] + (z + vz * inv) * d[2],
        );
      }
    }
  }

  const indices: number[] = [];
  const du = 1;
  const dv = nx - 1;
  const dw = (nx - 1) * (ny - 1);

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const m = cIdx(x, y, z);
        if (cellVert[m] < 0) continue;
        const g0 = val(x, y, z) > iso ? 1 : 0;

        // edge 0 (+x): quad in the y-z plane, cells m, m-dv, m-dv-dw, m-dw
        if (y > 0 && z > 0) {
          const g1 = val(x + 1, y, z) > iso ? 1 : 0;
          if (g0 !== g1) {
            quad(indices, cellVert, m, m - dv, m - dv - dw, m - dw, g0 === 1);
          }
        }
        // edge 1 (+y): cells m, m-dw, m-dw-du, m-du
        if (x > 0 && z > 0) {
          const g2 = val(x, y + 1, z) > iso ? 1 : 0;
          if (g0 !== g2) {
            quad(indices, cellVert, m, m - dw, m - dw - du, m - du, g0 === 1);
          }
        }
        // edge 2 (+z): cells m, m-du, m-du-dv, m-dv
        if (x > 0 && y > 0) {
          const g4 = val(x, y, z + 1) > iso ? 1 : 0;
          if (g0 !== g4) {
            quad(indices, cellVert, m, m - du, m - du - dv, m - dv, g0 === 1);
          }
        }
      }
    }
  }

  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  laplacianSmooth(pos, idx, Math.max(0, opts.smoothIterations ?? 2), 0.5);

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
  if (flip) {
    out.push(va, vb, vc, va, vc, vd);
  } else {
    out.push(va, vd, vc, va, vc, vb);
  }
}
