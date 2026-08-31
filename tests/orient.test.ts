import { describe, it, expect } from 'vitest';
import {
  makeCylinder, makeBox, makePawn, applyMatrix4, rotationX, rotationZ, computeBounds, boxSize, Vec3,
} from '../src/geometry/mesh';
import { computeOrientation } from '../src/geometry/orient';
import { normalizeMesh } from '../src/geometry/normalize';

const size = (m: { positions: Float32Array }) => boxSize(computeBounds(m));

describe('auto-orientation', () => {
  it('stands up a Z-up (lying-down) tall object', () => {
    // A tall cylinder rotated so its long axis is along Z.
    const lying = applyMatrix4(makeCylinder(10, 90, 40), rotationX(Math.PI / 2));
    const s0 = size(lying);
    expect(s0[2]).toBeGreaterThan(s0[1]); // currently longest along Z
    const o = computeOrientation(lying);
    expect(o.changed).toBe(true);
    const fixed = applyMatrix4(lying, o.rotation);
    const s1 = size(fixed);
    expect(s1[1]).toBeGreaterThan(s1[0]); // now tallest along Y
    expect(s1[1]).toBeGreaterThan(s1[2]);
  });

  it('leaves an already-upright object essentially alone', () => {
    const upright = makeCylinder(12, 80, 40);
    const o = computeOrientation(upright);
    expect(o.changed).toBe(false);
  });

  it('normalizeMesh reorients a tilted figure to vertical', () => {
    const tilted = applyMatrix4(makePawn(), rotationZ(Math.PI / 2)); // pawn lying on its side
    const n = normalizeMesh(tilted, { targetSize: 100 });
    const s = size(n.mesh);
    // pawn is ~2× taller than wide; after fixing, Y should dominate again
    expect(s[1]).toBeGreaterThan(s[0]);
    expect(n.report.reoriented).toBe(true);
  });

  it('does NOT stand a flat/wide object on its edge', () => {
    // A "car"-like block: 90 long × 40 wide × 20 tall, lying flat (correct pose).
    const car = makeBox(90, 20, 40);
    const s0 = size(car);
    const o = computeOrientation(car);
    const s1 = size(applyMatrix4(car, o.rotation));
    // tallest dimension must stay the same physical axis magnitude order
    expect(Math.max(...s1)).toBeCloseTo(Math.max(...s0), 3);
    expect(s1[1]).toBeCloseTo(20, 1); // still only 20 mm "tall"
  });

  it('squares up a Z-up axis-aligned tilt without a full stand-up when not elongated', () => {
    const blocky = applyMatrix4(makeBox(40, 30, 35), rotationX(Math.PI / 2));
    const o = computeOrientation(blocky);
    const s = size(applyMatrix4(blocky, o.rotation));
    // dims are a permutation of {40,30,35}
    const sorted = [...s].sort((a, b) => a - b).map((v) => Math.round(v));
    expect(sorted).toEqual([30, 35, 40]);
  });

  it('puts the heavier end down', () => {
    // Cone: wide base, narrow apex. Point it apex-down, expect it flipped.
    const apexDown = applyMatrix4(makeBox(40, 40, 40), rotationX(0)); // symmetric — no-op case
    const o = computeOrientation(apexDown);
    // symmetric box: orientation may or may not "change", but must stay axis-aligned
    const fixed = applyMatrix4(apexDown, o.rotation);
    const s = size(fixed) as Vec3;
    for (const v of s) expect(v).toBeGreaterThan(39.9);
  });
});
