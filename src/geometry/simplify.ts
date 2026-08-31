/**
 * Mesh decimation via Garland–Heckbert quadric error metrics (edge collapse).
 *
 * Replaces the old vertex-clustering pass: this preserves silhouettes, sharp
 * edges and volume far better at the same triangle budget, which matters because
 * WhittleGuide is meant to work on *any* model the user brings — clean CAD
 * exports, messy photogrammetry scans, low-poly game assets — not just the
 * curated museum meshes.
 *
 * The result is watertight-friendly but not guaranteed manifold (input scans
 * rarely are); collapses that would flip a triangle or create a sliver are
 * rejected, so the shape stays sane.
 */

import { Mesh, triangleCount } from './mesh';

interface Indexed {
  verts: Float64Array; // xyz per vertex
  faces: Int32Array; // 3 vertex indices per face
}

/** Weld coincident vertices onto a grid of `tol` and drop degenerate faces. */
function weldAndIndex(mesh: Mesh, tol: number): Indexed {
  const p = mesh.positions;
  const map = new Map<string, number>();
  const verts: number[] = [];
  const faces: number[] = [];
  const inv = 1 / tol;
  const key = (x: number, y: number, z: number) =>
    `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
  const idx = (x: number, y: number, z: number) => {
    const k = key(x, y, z);
    let i = map.get(k);
    if (i === undefined) {
      i = verts.length / 3;
      verts.push(x, y, z);
      map.set(k, i);
    }
    return i;
  };
  for (let t = 0; t < p.length; t += 9) {
    const a = idx(p[t], p[t + 1], p[t + 2]);
    const b = idx(p[t + 3], p[t + 4], p[t + 5]);
    const c = idx(p[t + 6], p[t + 7], p[t + 8]);
    if (a === b || b === c || a === c) continue;
    faces.push(a, b, c);
  }
  return { verts: new Float64Array(verts), faces: new Int32Array(faces) };
}

function toSoup(im: Indexed, aliveFaces: Uint8Array): Mesh {
  const out: number[] = [];
  const { verts, faces } = im;
  for (let f = 0; f < faces.length; f += 3) {
    if (!aliveFaces[f / 3]) continue;
    for (let k = 0; k < 3; k++) {
      const v = faces[f + k] * 3;
      out.push(verts[v], verts[v + 1], verts[v + 2]);
    }
  }
  return { positions: new Float32Array(out) };
}

// Symmetric 4x4 quadric stored as 10 doubles:
// [ q0 q1 q2 q3 ]
// [ q1 q4 q5 q6 ]
// [ q2 q5 q7 q8 ]
// [ q3 q6 q8 q9 ]
function quadricAddPlane(Q: Float64Array, o: number, a: number, b: number, c: number, d: number) {
  Q[o] += a * a; Q[o + 1] += a * b; Q[o + 2] += a * c; Q[o + 3] += a * d;
  Q[o + 4] += b * b; Q[o + 5] += b * c; Q[o + 6] += b * d;
  Q[o + 7] += c * c; Q[o + 8] += c * d;
  Q[o + 9] += d * d;
}

/** vᵀ Q v for the homogeneous point (x,y,z,1). */
function quadricError(Q: Float64Array, o: number, x: number, y: number, z: number): number {
  return (
    Q[o] * x * x + 2 * Q[o + 1] * x * y + 2 * Q[o + 2] * x * z + 2 * Q[o + 3] * x +
    Q[o + 4] * y * y + 2 * Q[o + 5] * y * z + 2 * Q[o + 6] * y +
    Q[o + 7] * z * z + 2 * Q[o + 8] * z +
    Q[o + 9]
  );
}

interface HeapEntry {
  cost: number;
  u: number;
  v: number;
  x: number;
  y: number;
  z: number;
  gu: number;
  gv: number;
}

class MinHeap {
  private a: HeapEntry[] = [];
  get size() {
    return this.a.length;
  }
  push(e: HeapEntry) {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): HeapEntry | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface SimplifyOptions {
  /** Weld tolerance as a fraction of the mesh's max dimension. Default 1e-4. */
  weldFraction?: number;
  /** Reject a collapse if any incident triangle normal turns by more than this. */
  maxNormalFlipCos?: number;
}

export function simplifyMesh(mesh: Mesh, targetTriangles: number, opts: SimplifyOptions = {}): Mesh {
  if (triangleCount(mesh) <= targetTriangles) return mesh;

  // Bounds for the weld tolerance.
  const p = mesh.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const tol = maxDim * (opts.weldFraction ?? 1e-4);
  const flipCos = opts.maxNormalFlipCos ?? -0.1;

  const im = weldAndIndex(mesh, tol);
  const nv = im.verts.length / 3;
  const nf = im.faces.length / 3;
  if (nf <= targetTriangles) return toSoup(im, new Uint8Array(nf).fill(1));

  const verts = im.verts;
  const F = im.faces; // mutable
  const faceAlive = new Uint8Array(nf).fill(1);
  let liveFaces = nf;

  const Q = new Float64Array(nv * 10);
  const vfaces: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
  const gen = new Int32Array(nv);
  const vAlive = new Uint8Array(nv).fill(1);

  const faceNormal = (f: number): [number, number, number, number] => {
    const a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1e-20;
    nx /= len; ny /= len; nz /= len;
    const d = -(nx * verts[a] + ny * verts[a + 1] + nz * verts[a + 2]);
    return [nx, ny, nz, d];
  };

  for (let f = 0; f < nf; f++) {
    const [nx, ny, nz, d] = faceNormal(f);
    for (let k = 0; k < 3; k++) {
      const vi = F[f * 3 + k];
      quadricAddPlane(Q, vi * 10, nx, ny, nz, d);
      vfaces[vi].add(f);
    }
  }

  const heap = new MinHeap();
  const addEdge = (u: number, v: number) => {
    if (u === v || !vAlive[u] || !vAlive[v]) return;
    const a = Math.min(u, v), b = Math.max(u, v);
    // collapse target = midpoint (robust; solving the 3x3 can place points far away on scans)
    const x = (verts[a * 3] + verts[b * 3]) / 2;
    const y = (verts[a * 3 + 1] + verts[b * 3 + 1]) / 2;
    const z = (verts[a * 3 + 2] + verts[b * 3 + 2]) / 2;
    const cost =
      quadricError(Q, a * 10, x, y, z) + quadricError(Q, b * 10, x, y, z);
    heap.push({ cost, u: a, v: b, x, y, z, gu: gen[a], gv: gen[b] });
  };

  const seen = new Set<number>();
  for (let f = 0; f < nf; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const lo = Math.min(u, v), hi = Math.max(u, v);
      const k = lo * nv + hi;
      if (seen.has(k)) continue;
      seen.add(k);
      addEdge(lo, hi);
    }
  }

  const rawArea = (f: number): number => {
    const a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return 0.5 * Math.hypot(cx, cy, cz);
  };

  /** Would moving `moved`→(x,y,z) flip or crush any incident triangle that survives? */
  const wouldFlip = (moved: number, other: number, x: number, y: number, z: number): boolean => {
    const ox = verts[moved * 3], oy = verts[moved * 3 + 1], oz = verts[moved * 3 + 2];
    let bad = false;
    for (const f of vfaces[moved]) {
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      if (a === other || b === other || c === other) continue; // this face collapses away
      const before = faceNormal(f);
      const areaBefore = rawArea(f);
      verts[moved * 3] = x; verts[moved * 3 + 1] = y; verts[moved * 3 + 2] = z;
      const after = faceNormal(f);
      const areaAfter = rawArea(f);
      verts[moved * 3] = ox; verts[moved * 3 + 1] = oy; verts[moved * 3 + 2] = oz;
      const dot = before[0] * after[0] + before[1] * after[1] + before[2] * after[2];
      if (dot < flipCos || areaAfter < areaBefore * 1e-3) {
        bad = true;
        break;
      }
    }
    return bad;
  };

  while (liveFaces > targetTriangles && heap.size > 0) {
    const e = heap.pop()!;
    if (!vAlive[e.u] || !vAlive[e.v]) continue;
    if (e.gu !== gen[e.u] || e.gv !== gen[e.v]) continue; // stale

    const keep = e.v;
    const drop = e.u;
    if (wouldFlip(drop, keep, e.x, e.y, e.z) || wouldFlip(keep, drop, e.x, e.y, e.z)) {
      continue;
    }

    // Move keep to the collapse position, absorb quadric.
    verts[keep * 3] = e.x; verts[keep * 3 + 1] = e.y; verts[keep * 3 + 2] = e.z;
    for (let i = 0; i < 10; i++) Q[keep * 10 + i] += Q[drop * 10 + i];

    // Retarget / kill faces around drop.
    const affected = new Set<number>();
    for (const f of vfaces[drop]) {
      const i0 = f * 3;
      const has = [F[i0] === keep, F[i0 + 1] === keep, F[i0 + 2] === keep];
      if (has[0] || has[1] || has[2]) {
        // shares the collapsed edge -> remove
        if (faceAlive[f]) {
          faceAlive[f] = 0;
          liveFaces--;
          for (let k = 0; k < 3; k++) vfaces[F[i0 + k]].delete(f);
        }
      } else {
        for (let k = 0; k < 3; k++) if (F[i0 + k] === drop) F[i0 + k] = keep;
        vfaces[keep].add(f);
        affected.add(f);
      }
    }
    vAlive[drop] = 0;
    void affected;

    // Only `keep`'s quadric changed, so only edges incident to `keep` need new
    // costs. Bump keep's version (stale (keep, *) heap entries are then ignored)
    // and re-insert its current 1-ring edges.
    gen[keep]++;
    const nbrs = new Set<number>();
    for (const f of vfaces[keep]) {
      for (let k = 0; k < 3; k++) {
        const w = F[f * 3 + k];
        if (w !== keep && vAlive[w]) nbrs.add(w);
      }
    }
    for (const w of nbrs) addEdge(Math.min(keep, w), Math.max(keep, w));
  }

  return toSoup({ verts, faces: F }, faceAlive);
}
