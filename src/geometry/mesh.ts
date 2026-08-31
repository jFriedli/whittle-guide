/**
 * Core mesh representation for the geometry subsystem.
 *
 * The geometry pipeline is deliberately decoupled from three.js: everything here
 * operates on a plain triangle soup (`positions`, 9 floats per triangle) so the
 * algorithms can be unit-tested in plain Node and, later, ported to Rust/WASM.
 */

export type Vec3 = [number, number, number];

export interface Mesh {
  /** Triangle soup: x0,y0,z0, x1,y1,z1, x2,y2,z2, ... length is a multiple of 9. */
  positions: Float32Array;
}

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export const triangleCount = (mesh: Mesh): number => mesh.positions.length / 9;

export function emptyBox(): Box3 {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

export function computeBounds(mesh: Mesh): Box3 {
  const box = emptyBox();
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a];
      if (v < box.min[a]) box.min[a] = v;
      if (v > box.max[a]) box.max[a] = v;
    }
  }
  return box;
}

export const boxSize = (b: Box3): Vec3 => [
  b.max[0] - b.min[0],
  b.max[1] - b.min[1],
  b.max[2] - b.min[2],
];

export const boxCenter = (b: Box3): Vec3 => [
  (b.max[0] + b.min[0]) / 2,
  (b.max[1] + b.min[1]) / 2,
  (b.max[2] + b.min[2]) / 2,
];

/** Column-major 4x4 matrix, three.js compatible. */
export type Mat4 = number[];

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(sx: number, sy: number, sz = sy): Mat4 {
  const m = identity();
  m[0] = sx;
  m[5] = sy;
  m[10] = sz;
  return m;
}

export function rotationX(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function rotationY(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function rotationZ(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

export function composeTRS(
  t: Vec3,
  euler: Vec3,
  scale: Vec3 | number,
): Mat4 {
  const s = typeof scale === 'number' ? ([scale, scale, scale] as Vec3) : scale;
  let m = translation(t[0], t[1], t[2]);
  m = multiply(m, rotationX(euler[0]));
  m = multiply(m, rotationY(euler[1]));
  m = multiply(m, rotationZ(euler[2]));
  m = multiply(m, scaling(s[0], s[1], s[2]));
  return m;
}

export function applyMatrix4(mesh: Mesh, m: Mat4): Mesh {
  const src = mesh.positions;
  const dst = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i];
    const y = src[i + 1];
    const z = src[i + 2];
    dst[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    dst[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    dst[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return { positions: dst };
}

/** Merge multiple meshes into one triangle soup. */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  const total = meshes.reduce((n, mm) => n + mm.positions.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const mm of meshes) {
    out.set(mm.positions, o);
    o += mm.positions.length;
  }
  return { positions: out };
}

// ---------------------------------------------------------------------------
// Synthetic meshes — used for demos, offline fallbacks, and unit tests where
// the expected geometric result is known analytically.
// ---------------------------------------------------------------------------

function pushTri(arr: number[], a: Vec3, b: Vec3, c: Vec3) {
  arr.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

/** Axis-aligned box centred at the origin. */
export function makeBox(sx = 1, sy = 1, sz = 1): Mesh {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const v: Vec3[] = [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, hy, -hz],
    [-hx, hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [hx, hy, hz],
    [-hx, hy, hz],
  ];
  const faces = [
    [0, 1, 2, 3], // -z
    [5, 4, 7, 6], // +z
    [4, 0, 3, 7], // -x
    [1, 5, 6, 2], // +x
    [4, 5, 1, 0], // -y
    [3, 2, 6, 7], // +y
  ];
  const arr: number[] = [];
  for (const f of faces) {
    pushTri(arr, v[f[0]], v[f[1]], v[f[2]]);
    pushTri(arr, v[f[0]], v[f[2]], v[f[3]]);
  }
  return { positions: new Float32Array(arr) };
}

/** UV sphere centred at the origin. */
export function makeSphere(radius = 1, seg = 24): Mesh {
  const arr: number[] = [];
  const point = (i: number, j: number): Vec3 => {
    const theta = (i / seg) * Math.PI; // 0..pi
    const phi = (j / seg) * Math.PI * 2;
    return [
      radius * Math.sin(theta) * Math.cos(phi),
      radius * Math.cos(theta),
      radius * Math.sin(theta) * Math.sin(phi),
    ];
  };
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = point(i, j);
      const b = point(i + 1, j);
      const c = point(i + 1, j + 1);
      const d = point(i, j + 1);
      pushTri(arr, a, b, c);
      pushTri(arr, a, c, d);
    }
  }
  return { positions: new Float32Array(arr) };
}

/** Cylinder aligned with the Y axis, centred at the origin. */
export function makeCylinder(radius = 1, height = 2, seg = 24): Mesh {
  const arr: number[] = [];
  const hy = height / 2;
  for (let j = 0; j < seg; j++) {
    const p0 = (j / seg) * Math.PI * 2;
    const p1 = ((j + 1) / seg) * Math.PI * 2;
    const x0 = radius * Math.cos(p0);
    const z0 = radius * Math.sin(p0);
    const x1 = radius * Math.cos(p1);
    const z1 = radius * Math.sin(p1);
    pushTri(arr, [x0, -hy, z0], [x1, -hy, z1], [x1, hy, z1]);
    pushTri(arr, [x0, -hy, z0], [x1, hy, z1], [x0, hy, z0]);
    pushTri(arr, [0, hy, 0], [x0, hy, z0], [x1, hy, z1]);
    pushTri(arr, [0, -hy, 0], [x1, -hy, z1], [x0, -hy, z0]);
  }
  return { positions: new Float32Array(arr) };
}

/** Cone with apex up the +Y axis, base centred on the origin's -Y half. */
export function makeCone(radius = 1, height = 2, seg = 24): Mesh {
  const arr: number[] = [];
  const hy = height / 2;
  for (let j = 0; j < seg; j++) {
    const p0 = (j / seg) * Math.PI * 2;
    const p1 = ((j + 1) / seg) * Math.PI * 2;
    const x0 = radius * Math.cos(p0);
    const z0 = radius * Math.sin(p0);
    const x1 = radius * Math.cos(p1);
    const z1 = radius * Math.sin(p1);
    pushTri(arr, [x0, -hy, z0], [x1, -hy, z1], [0, hy, 0]);
    pushTri(arr, [0, -hy, 0], [x1, -hy, z1], [x0, -hy, z0]);
  }
  return { positions: new Float32Array(arr) };
}

/**
 * A crude low-poly "pawn"/figure: stacked box body, cylinder neck, sphere head.
 * Stand-in for a human-like carving subject in tests and offline demos.
 */
export function makePawn(): Mesh {
  const body = applyMatrix4(makeCylinder(0.5, 1.2, 20), translation(0, -0.3, 0));
  const base = applyMatrix4(makeCylinder(0.7, 0.25, 20), translation(0, -1.0, 0));
  const neck = applyMatrix4(makeCylinder(0.16, 0.35, 12), translation(0, 0.45, 0));
  const head = applyMatrix4(makeSphere(0.34, 18), translation(0, 0.85, 0));
  return mergeMeshes([base, body, neck, head]);
}
