import { describe, it, expect } from 'vitest';
import { makeBox, makeSphere, makeCylinder, applyMatrix4, translation, rotationZ, mergeMeshes } from '../src/geometry/mesh';
import { voxelize } from '../src/geometry/voxelize';
import { analyseFragility, estimateMinFeatureMm } from '../src/geometry/fragility';

describe('fragility analysis', () => {
  it('a chunky block has no thin features', () => {
    const g = voxelize(makeBox(24, 24, 24), { width: 40, height: 40, depth: 40 }, { approxCells: 44 });
    const r = analyseFragility(g);
    expect(r.fraction).toBeLessThan(0.03);
    expect(r.minThicknessMm).toBeGreaterThan(14);
  });

  it('min feature ~ diameter of a thick cylinder', () => {
    const g = voxelize(makeCylinder(9, 44, 40), { width: 40, height: 60, depth: 40 }, { approxCells: 50 });
    const mf = estimateMinFeatureMm(g);
    expect(mf).toBeGreaterThan(12);
    expect(mf).toBeLessThan(22);
  });

  it('flags a thin arm sticking off a body and measures it thin', () => {
    const body = makeSphere(14, 32);
    const arm = applyMatrix4(makeBox(4, 24, 8), translation(0, 24, 0)); // 4 mm thick, along Y
    const g = voxelize(mergeMeshes([body, arm]), { width: 48, height: 72, depth: 48 }, { approxCells: 72 });
    const r = analyseFragility(g, 1); // grain along Y = along the arm
    expect(r.fraction).toBeGreaterThan(0);
    expect(r.minThicknessMm).toBeLessThan(7);
    expect(r.crossGrainFraction).toBeLessThan(0.4); // arm runs with the grain
  });

  it('a sideways arm reads as cross-grain when grain is vertical', () => {
    const body = makeSphere(13, 32);
    const arm = applyMatrix4(applyMatrix4(makeBox(2.4, 22, 6), translation(0, 22, 0)), rotationZ(Math.PI / 2));
    const g = voxelize(mergeMeshes([body, arm]), { width: 66, height: 44, depth: 44 }, { approxCells: 58 });
    const r = analyseFragility(g, 1); // grain along Y, arm now along X
    expect(r.fraction).toBeGreaterThan(0);
    expect(r.crossGrainFraction).toBeGreaterThan(0.3);
  });
});
