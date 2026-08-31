/**
 * Mesh cleanup + normalisation.
 *
 * Museum scans are frequently messy: nested scene transforms, duplicate vertices,
 * degenerate triangles, arbitrary origin/orientation, extreme units and very high
 * triangle counts. This module produces a well-behaved mesh for interactive
 * analysis without silently discarding meaningful geometry.
 */

import {
  Mesh,
  Box3,
  Vec3,
  computeBounds,
  boxSize,
  boxCenter,
  triangleCount,
} from './mesh';

export type UpAxis = 'x' | 'y' | 'z';

export interface NormalizeReport {
  inputTriangles: number;
  outputTriangles: number;
  removedDegenerate: number;
  simplified: boolean;
  guessedUp: UpAxis;
  originalSize: Vec3;
  /** Uniform scale applied so the largest dimension is ~`targetSize` mm. */
  unitScale: number;
}

export interface NormalizeResult {
  mesh: Mesh;
  bounds: Box3;
  report: NormalizeReport;
}

const triArea = (
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number => {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const cxp = uy * vz - uz * vy;
  const cyp = uz * vx - ux * vz;
  const czp = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cxp * cxp + cyp * cyp + czp * czp);
};

/** Drop triangles whose area is below `minArea` (relative to mesh scale). */
export function dropDegenerate(mesh: Mesh, scaleHint: number): { mesh: Mesh; removed: number } {
  const p = mesh.positions;
  const minArea = (scaleHint * 1e-5) ** 2;
  const keep: number[] = [];
  let removed = 0;
  for (let i = 0; i < p.length; i += 9) {
    const a = triArea(
      p[i], p[i + 1], p[i + 2],
      p[i + 3], p[i + 4], p[i + 5],
      p[i + 6], p[i + 7], p[i + 8],
    );
    if (a > minArea && Number.isFinite(a)) {
      for (let k = 0; k < 9; k++) keep.push(p[i + k]);
    } else {
      removed++;
    }
  }
  return { mesh: { positions: new Float32Array(keep) }, removed };
}

/**
 * Guess the "up" axis. glTF is nominally Y-up, but scans vary. Heuristic: the up
 * axis is the one whose extent is *not* the smallest and where the geometry is
 * roughly centred over a smaller footprint. We default to Y and only override
 * when another axis is clearly dominant.
 */
export function guessUpAxis(size: Vec3): UpAxis {
  const [x, y, z] = size;
  // If Y is already the tallest (or close), keep it.
  if (y >= 0.85 * Math.max(x, z)) return 'y';
  if (z > x && z > y) return 'z';
  if (x > y && x > z) return 'x';
  return 'y';
}

/**
 * Vertex-clustering simplification. Snaps vertices to a grid and collapses
 * triangles that become degenerate. Robust (works on non-manifold soup) and
 * fast; not as shape-preserving as quadric decimation but adequate for the
 * silhouette / depth / voxel analysis this app performs.
 */
export function simplifyByClustering(mesh: Mesh, targetTriangles: number): Mesh {
  const tris = triangleCount(mesh);
  if (tris <= targetTriangles) return mesh;

  const bounds = computeBounds(mesh);
  const size = boxSize(bounds);
  const maxDim = Math.max(size[0], size[1], size[2]) || 1;

  // Binary-search a grid resolution that lands near the target.
  let lo = 8;
  let hi = 512;
  let best: Mesh = mesh;
  for (let iter = 0; iter < 9; iter++) {
    const res = Math.round((lo + hi) / 2);
    const candidate = clusterAt(mesh, bounds, maxDim, res);
    const c = triangleCount(candidate);
    if (c > targetTriangles) {
      hi = res;
    } else {
      best = candidate;
      lo = res;
    }
    if (hi - lo <= 2) break;
  }
  return triangleCount(best) <= tris ? best : mesh;
}

function clusterAt(mesh: Mesh, bounds: Box3, maxDim: number, res: number): Mesh {
  const p = mesh.positions;
  const cell = maxDim / res;
  const key = (x: number, y: number, z: number) => {
    const ix = Math.floor((x - bounds.min[0]) / cell);
    const iy = Math.floor((y - bounds.min[1]) / cell);
    const iz = Math.floor((z - bounds.min[2]) / cell);
    return ix * 73856093 + iy * 19349663 + iz * 83492791;
  };
  // Representative position per cell = cell centroid of contributing verts.
  const sum = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < p.length; i += 3) {
    const k = key(p[i], p[i + 1], p[i + 2]);
    const e = sum.get(k);
    if (e) {
      e[0] += p[i];
      e[1] += p[i + 1];
      e[2] += p[i + 2];
      e[3] += 1;
    } else {
      sum.set(k, [p[i], p[i + 1], p[i + 2], 1]);
    }
  }
  const rep = new Map<number, [number, number, number]>();
  for (const [k, e] of sum) rep.set(k, [e[0] / e[3], e[1] / e[3], e[2] / e[3]]);

  const out: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < p.length; i += 9) {
    const ka = key(p[i], p[i + 1], p[i + 2]);
    const kb = key(p[i + 3], p[i + 4], p[i + 5]);
    const kc = key(p[i + 6], p[i + 7], p[i + 8]);
    if (ka === kb || kb === kc || ka === kc) continue; // collapsed
    const sig = [ka, kb, kc].sort((x, y) => x - y).join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const ra = rep.get(ka)!;
    const rb = rep.get(kb)!;
    const rc = rep.get(kc)!;
    out.push(ra[0], ra[1], ra[2], rb[0], rb[1], rb[2], rc[0], rc[1], rc[2]);
  }
  return { positions: new Float32Array(out) };
}

export interface NormalizeOptions {
  /** Largest dimension of the normalised mesh, mm (scale 1 reference). */
  targetSize?: number;
  /** Simplify to at most this many triangles for analysis. */
  maxTriangles?: number;
  /** Re-orient so the guessed up axis becomes +Y. */
  reorientUp?: boolean;
}

export function normalizeMesh(input: Mesh, opts: NormalizeOptions = {}): NormalizeResult {
  const targetSize = opts.targetSize ?? 100;
  const maxTriangles = opts.maxTriangles ?? 40000;
  const inputTriangles = triangleCount(input);

  const rawBounds = computeBounds(input);
  const rawSize = boxSize(rawBounds);
  const maxRaw = Math.max(rawSize[0], rawSize[1], rawSize[2]) || 1;

  const deg = dropDegenerate(input, maxRaw);

  let mesh = deg.mesh;
  const simplified = triangleCount(mesh) > maxTriangles;
  if (simplified) mesh = simplifyByClustering(mesh, maxTriangles);

  // Recentre to origin and scale so the largest dimension is `targetSize` mm.
  const b0 = computeBounds(mesh);
  const c0 = boxCenter(b0);
  const s0 = boxSize(b0);
  const maxDim = Math.max(s0[0], s0[1], s0[2]) || 1;
  const unitScale = targetSize / maxDim;

  const guessedUp = guessUpAxis(s0);
  const p = mesh.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    let x = (p[i] - c0[0]) * unitScale;
    let y = (p[i + 1] - c0[1]) * unitScale;
    let z = (p[i + 2] - c0[2]) * unitScale;
    if (opts.reorientUp && guessedUp !== 'y') {
      if (guessedUp === 'z') {
        // z-up -> y-up
        const ny = z;
        const nz = -y;
        y = ny;
        z = nz;
      } else {
        // x-up -> y-up
        const ny = x;
        const nx = -y;
        y = ny;
        x = nx;
      }
    }
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
  }

  const result: Mesh = { positions: out };
  const bounds = computeBounds(result);
  return {
    mesh: result,
    bounds,
    report: {
      inputTriangles,
      outputTriangles: triangleCount(result),
      removedDegenerate: deg.removed,
      simplified,
      guessedUp,
      originalSize: rawSize,
      unitScale,
    },
  };
}
