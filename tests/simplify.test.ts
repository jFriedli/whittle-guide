import { describe, it, expect } from 'vitest';
import { makeSphere, makeBox, makeCylinder, computeBounds, boxSize, triangleCount } from '../src/geometry/mesh';
import { simplifyMesh } from '../src/geometry/simplify';
import { voxelize, solidVolume } from '../src/geometry/voxelize';

describe('quadric simplification', () => {
  it('hits roughly the target triangle count', () => {
    const dense = makeSphere(50, 96); // ~18k tris
    const out = simplifyMesh(dense, 1200);
    expect(triangleCount(out)).toBeGreaterThan(300);
    expect(triangleCount(out)).toBeLessThan(1900);
  });

  it('keeps a sphere round (bounds preserved within 4%)', () => {
    const dense = makeSphere(40, 80);
    const before = boxSize(computeBounds(dense));
    const out = simplifyMesh(dense, 800);
    const after = boxSize(computeBounds(out));
    for (let i = 0; i < 3; i++) {
      expect(after[i]).toBeGreaterThan(before[i] * 0.9);
      expect(after[i]).toBeLessThan(before[i] * 1.04);
    }
  });

  it('preserves volume of a cylinder within 10%', () => {
    const blank = { width: 80, height: 80, depth: 80 };
    const dense = makeCylinder(25, 60, 120);
    const v0 = solidVolume(voxelize(dense, blank, { approxCells: 64 }));
    const out = simplifyMesh(dense, 500);
    const v1 = solidVolume(voxelize(out, blank, { approxCells: 64 }));
    expect(Math.abs(v1 - v0) / v0).toBeLessThan(0.1);
  });

  it('does not blow up a low-poly cube (already under target)', () => {
    const cube = makeBox(10, 10, 10);
    const out = simplifyMesh(cube, 1000);
    expect(triangleCount(out)).toBe(12);
  });

  it('produces no degenerate triangles', () => {
    const out = simplifyMesh(makeSphere(30, 64), 400);
    const p = out.positions;
    let degen = 0;
    for (let i = 0; i < p.length; i += 9) {
      const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
      const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (Math.hypot(cx, cy, cz) < 1e-6) degen++;
    }
    expect(degen).toBe(0);
  });
});
