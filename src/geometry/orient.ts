/**
 * Automatic model orientation.
 *
 * WhittleGuide takes *any* model, and users' files arrive in every pose — Z-up
 * CAD exports, tumbled photogrammetry scans, sideways game props. We run a PCA of
 * the vertex cloud and:
 *
 *   • elongated subjects (figure, bust, bottle, totem) → stand the long axis up,
 *     heavy end down;
 *   • everything else → just realign to the nearest axis-aligned pose (fixes a
 *     tilt or a Z-up export without tipping a car onto its bumper).
 *
 * Already-sensible models are left essentially untouched.
 */

import { Mesh, Mat4, Vec3, identity } from './mesh';

export interface OrientationResult {
  rotation: Mat4;
  changed: boolean;
  note: string;
}

const SNAP_COS = Math.cos((22 * Math.PI) / 180);

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const WORLD: Vec3[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** Nearest signed world axis to `v`, or null if none is within the snap cone. */
function snap(v: Vec3): Vec3 | null {
  let best: Vec3 | null = null;
  let bestDot = SNAP_COS;
  for (const ax of WORLD) {
    const d = dot(v, ax);
    if (d > bestDot) {
      bestDot = d;
      best = ax;
    }
  }
  return best;
}

/** Jacobi eigenvalue algorithm for a symmetric 3×3 matrix (row-major a[9]). */
function eigenSymmetric3(input: number[]): { values: number[]; vectors: Vec3[] } {
  let a = input.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iter = 0; iter < 60; iter++) {
    let p = 0, q = 1;
    let off = Math.abs(a[1]);
    if (Math.abs(a[2]) > off) { off = Math.abs(a[2]); p = 0; q = 2; }
    if (Math.abs(a[5]) > off) { off = Math.abs(a[5]); p = 1; q = 2; }
    if (off < 1e-13) break;
    const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[p * 3 + q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi), s = Math.sin(phi);
    const aj = a.slice();
    for (let i = 0; i < 3; i++) {
      aj[i * 3 + p] = c * a[i * 3 + p] - s * a[i * 3 + q];
      aj[i * 3 + q] = s * a[i * 3 + p] + c * a[i * 3 + q];
    }
    const next = aj.slice();
    for (let j = 0; j < 3; j++) {
      next[p * 3 + j] = c * aj[p * 3 + j] - s * aj[q * 3 + j];
      next[q * 3 + j] = s * aj[p * 3 + j] + c * aj[q * 3 + j];
    }
    a = next;
    for (let i = 0; i < 3; i++) {
      const vip = v[i * 3 + p], viq = v[i * 3 + q];
      v[i * 3 + p] = c * vip - s * viq;
      v[i * 3 + q] = s * vip + c * viq;
    }
  }
  return {
    values: [a[0], a[4], a[8]],
    vectors: [
      [v[0], v[3], v[6]],
      [v[1], v[4], v[7]],
      [v[2], v[5], v[8]],
    ],
  };
}

function multiplyMat(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

/** Column-major rotation whose rows are the given orthonormal model axes. */
function frameToWorld(width: Vec3, up: Vec3, depth: Vec3): Mat4 {
  return [
    width[0], up[0], depth[0], 0,
    width[1], up[1], depth[1], 0,
    width[2], up[2], depth[2], 0,
    0, 0, 0, 1,
  ];
}

/** Minimal rotation carrying unit vector `a` onto unit vector `b`. */
function minimalRotationTo(a: Vec3, b: Vec3): Mat4 {
  const d = Math.min(1, Math.max(-1, dot(a, b)));
  if (d > 0.99999) return identity();
  const axis =
    d < -0.99999
      ? Math.abs(a[0]) < 0.9
        ? norm(cross(a, [1, 0, 0]))
        : norm(cross(a, [0, 0, 1]))
      : norm(cross(a, b));
  const angle = Math.acos(d);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const [x, y, z] = axis;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

const FLIP_Z: Mat4 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

function angleOf(R: Mat4): number {
  const trace = R[0] + R[5] + R[10];
  return Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2)));
}

export interface OrientOptions {
  /** Try harder to stand the model upright (user pressed "Auto-orient"). */
  aggressive?: boolean;
}

export function computeOrientation(mesh: Mesh, opts: OrientOptions = {}): OrientationResult {
  const p = mesh.positions;
  const n = p.length / 3;
  const noop: OrientationResult = { rotation: identity(), changed: false, note: 'orientation looked fine, left as-is' };
  if (n < 8) return noop;

  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
  cx /= n; cy /= n; cz /= n;

  const cov = new Array(9).fill(0);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] - cx, y = p[i + 1] - cy, z = p[i + 2] - cz;
    cov[0] += x * x; cov[1] += x * y; cov[2] += x * z;
    cov[4] += y * y; cov[5] += y * z; cov[8] += z * z;
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
  for (let i = 0; i < 9; i++) cov[i] /= n;

  const { values, vectors } = eigenSymmetric3(cov);
  const evec = [0, 1, 2]
    .sort((a, b) => values[b] - values[a])
    .map((i) => norm(vectors[i]));

  // Physical extent of the model along each principal axis.
  const extent = (e: Vec3): number => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const d = (p[i] - cx) * e[0] + (p[i + 1] - cy) * e[1] + (p[i + 2] - cz) * e[2];
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    return hi - lo;
  };
  const ax = evec
    .map((e) => ({ e, ext: extent(e) }))
    .sort((a, b) => b.ext - a.ext);
  const [long, mid, short] = ax;

  // "Stand it up" only for things that read as a figure / bust / bottle / totem:
  // clearly longer than they are wide, with a roughly compact cross-section.
  // A flat, wide object (car, relief, plaque) is elongated but must stay put.
  const elongated = opts.aggressive
    ? mid.ext > 1e-6 && long.ext / mid.ext > 1.12
    : mid.ext > 1e-6 &&
      short.ext > 1e-6 &&
      long.ext / mid.ext > 1.6 &&
      mid.ext / short.ext < 1.7;

  let R: Mat4;
  let note: string;

  if (elongated) {
    // Stand the long axis up; snap the cross-section axes to the world.
    let up = snap(long.e) ?? long.e;
    // enforce Y-up
    R = minimalRotationTo(up, [0, 1, 0]);
    up = [0, 1, 0];
    let width = snap(mid.e);
    if (!width || Math.abs(dot(norm([R[0], R[1], R[2]]), width)) > 0.99) {
      // roll ambiguous / not snappable -> just the up rotation
      note = 'stood the long axis upright';
    } else {
      // rotate the already-up model so mid.e lands on X
      const midW: Vec3 = norm([
        R[0] * mid.e[0] + R[4] * mid.e[1] + R[8] * mid.e[2],
        R[1] * mid.e[0] + R[5] * mid.e[1] + R[9] * mid.e[2],
        R[2] * mid.e[0] + R[6] * mid.e[1] + R[10] * mid.e[2],
      ]);
      const targetW = snap([midW[0], 0, midW[2]] as Vec3) ?? [1, 0, 0];
      const roll = minimalRotationTo([midW[0], 0, midW[2]] as Vec3, targetW);
      R = multiplyMat(roll, R);
      note = 'stood upright and squared to the axes';
    }
  } else {
    // Realign to the nearest axis-aligned pose without forcing verticality.
    const sLong = snap(long.e);
    const sMid = snap(mid.e);
    const sShort = snap(short.e);
    if (
      sLong && sMid && sShort &&
      axisId(sLong) !== axisId(sMid) && axisId(sMid) !== axisId(sShort) && axisId(sLong) !== axisId(sShort)
    ) {
      // width/up/depth = whichever snapped principal axis points along X/Y/Z
      const byAxis: (Vec3 | null)[] = [null, null, null];
      for (const [e, s] of [[long.e, sLong], [mid.e, sMid], [short.e, sShort]] as [Vec3, Vec3][]) {
        byAxis[axisId(s)] = s[axisId(s)] > 0 ? e : ([-e[0], -e[1], -e[2]] as Vec3);
      }
      R = frameToWorld(byAxis[0]!, byAxis[1]!, byAxis[2]!);
      note = 'squared to the nearest axes';
    } else {
      return noop;
    }
  }

  // Broader end down: compare the cross-section footprint of the top half vs the
  // bottom half along the new up axis (a wide base sits down; a wide head flips).
  const upRow: Vec3 = [R[1], R[5], R[9]];
  const wRow: Vec3 = [R[0], R[4], R[8]];
  const dRow: Vec3 = [R[2], R[6], R[10]];
  let topW = 0, topD = 0, botW = 0, botD = 0;
  const spanTop = { wLo: Infinity, wHi: -Infinity, dLo: Infinity, dHi: -Infinity };
  const spanBot = { wLo: Infinity, wHi: -Infinity, dLo: Infinity, dHi: -Infinity };
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] - cx, y = p[i + 1] - cy, z = p[i + 2] - cz;
    const u = upRow[0] * x + upRow[1] * y + upRow[2] * z;
    const w = wRow[0] * x + wRow[1] * y + wRow[2] * z;
    const d = dRow[0] * x + dRow[1] * y + dRow[2] * z;
    const s = u >= 0 ? spanTop : spanBot;
    if (w < s.wLo) s.wLo = w; if (w > s.wHi) s.wHi = w;
    if (d < s.dLo) s.dLo = d; if (d > s.dHi) s.dHi = d;
  }
  topW = spanTop.wHi - spanTop.wLo; topD = spanTop.dHi - spanTop.dLo;
  botW = spanBot.wHi - spanBot.wLo; botD = spanBot.dHi - spanBot.dLo;
  if (Math.max(topW, topD) > Math.max(botW, botD) * 1.08) R = multiplyMat(FLIP_Z, R);

  const angle = angleOf(R);
  const changed = angle > (7 * Math.PI) / 180;
  return {
    rotation: changed ? R : identity(),
    changed,
    note: changed ? `${note} (rotated ${Math.round((angle * 180) / Math.PI)}°)` : noop.note,
  };
}

const axisId = (v: Vec3): number => (Math.abs(v[0]) > 0.5 ? 0 : Math.abs(v[1]) > 0.5 ? 1 : 2);
