import { describe, it, expect } from 'vitest';
import { makeCylinder, makeBox, applyMatrix4, translation } from '../src/geometry/mesh';
import { voxelize } from '../src/geometry/voxelize';
import { horizontalSlice } from '../src/geometry/slice';

const dimsOf = (g: ReturnType<typeof voxelize>) => ({
  nx: g.nx, ny: g.ny, nz: g.nz, d: g.d, origin: g.origin,
});

describe('horizontal cross-sections', () => {
  it('a cylinder slices to a roughly circular section of ~its diameter', () => {
    const g = voxelize(makeCylinder(9, 44, 40), { width: 40, height: 60, depth: 40 }, { approxCells: 50 });
    const s = horizontalSlice(g.data, dimsOf(g), 0.5);
    const w = s.extentMm[2] - s.extentMm[0];
    const d = s.extentMm[3] - s.extentMm[1];
    expect(w).toBeGreaterThan(15);
    expect(w).toBeLessThan(21);
    expect(Math.abs(w - d)).toBeLessThan(3); // circular
    expect(s.polylines.length).toBeGreaterThan(0);
  });

  it('a stepped shape has different sections at different heights', () => {
    const lower = applyMatrix4(makeBox(30, 20, 30), translation(0, -10, 0));
    const upper = applyMatrix4(makeBox(12, 20, 12), translation(0, 10, 0));
    const g = voxelize(
      { positions: Float32Array.of(...lower.positions, ...upper.positions) },
      { width: 44, height: 48, depth: 44 },
      { approxCells: 50 },
    );
    const low = horizontalSlice(g.data, dimsOf(g), 0.25);
    const high = horizontalSlice(g.data, dimsOf(g), 0.75);
    expect(low.areaMm2).toBeGreaterThan(high.areaMm2 * 2);
  });

  it('section height increases with the fraction', () => {
    const g = voxelize(makeBox(20, 40, 20), { width: 40, height: 60, depth: 40 }, { approxCells: 40 });
    const a = horizontalSlice(g.data, dimsOf(g), 0.2);
    const b = horizontalSlice(g.data, dimsOf(g), 0.8);
    expect(b.heightMm).toBeGreaterThan(a.heightMm);
  });
});
