import { describe, it, expect } from 'vitest';
import { makeSphere, makeBox, applyMatrix4, translation, mergeMeshes } from '../src/geometry/mesh';
import { voxelize } from '../src/geometry/voxelize';
import { undercutMask } from '../src/geometry/undercuts';

describe('undercut detection', () => {
  it('a convex blob has no undercuts', () => {
    const g = voxelize(makeSphere(15, 40), { width: 40, height: 40, depth: 40 }, { approxCells: 44 });
    const r = undercutMask(g);
    expect(r.surfaceVoxels).toBeGreaterThan(50);
    expect(r.fraction).toBeLessThan(0.02);
  });

  it('a mushroom overhang produces some undercuts under the cap', () => {
    const stem = applyMatrix4(makeBox(6, 20, 6), translation(0, -6, 0));
    const cap = applyMatrix4(makeBox(28, 6, 28), translation(0, 8, 0));
    const g = voxelize(mergeMeshes([stem, cap]), { width: 40, height: 44, depth: 40 }, { approxCells: 50 });
    const r = undercutMask(g);
    expect(r.undercutVoxels).toBeGreaterThan(0);
    // all flagged voxels are solid surface voxels
    for (let i = 0; i < r.mask.length; i++) if (r.mask[i]) expect(g.data[i]).toBe(1);
  });

  it('a fully enclosed cavity is entirely undercut', () => {
    // outer box minus inner box = a closed shell; its inner surface reaches no axis
    const outer = makeBox(30, 30, 30);
    // inner faces (a smaller box, inverted-ish — just add its walls as geometry)
    const inner = makeBox(16, 16, 16);
    const g = voxelize(mergeMeshes([outer, inner]), { width: 44, height: 44, depth: 44 }, { approxCells: 48 });
    const r = undercutMask(g);
    // the inner cube's outward faces are unreachable -> a real chunk of undercut
    expect(r.fraction).toBeGreaterThan(0.15);
  });

  it('a plain box has no undercuts', () => {
    const g = voxelize(makeBox(20, 30, 15), { width: 40, height: 50, depth: 40 }, { approxCells: 44 });
    expect(undercutMask(g).undercutVoxels).toBe(0);
  });
});
