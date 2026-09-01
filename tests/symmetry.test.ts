import { describe, it, expect } from 'vitest';
import { makeBox, makePawn, applyMatrix4, translation, computeBounds } from '../src/geometry/mesh';
import { normalizeMesh } from '../src/geometry/normalize';
import { autoFit, defaultBlank, placementMatrix } from '../src/geometry/blank';
import { voxelize, countSolid } from '../src/geometry/voxelize';
import { symmetrizeGrid, mirrorMesh } from '../src/geometry/symmetry';
import { analyse } from '../src/geometry/analysis';

describe('symmetry enforcement', () => {
  it('symmetrizeGrid unions the mirror and only adds solid', () => {
    // Body centred in the blank + a bump on the +X side only.
    const body = makeBox(24, 40, 16);
    const bump = applyMatrix4(makeBox(10, 10, 10), translation(15, 0, 0));
    const mesh = { positions: Float32Array.of(...body.positions, ...bump.positions) };
    const blank = { width: 48, height: 48, depth: 24 };
    const g = voxelize(mesh, blank, { approxCells: 40 });

    const before = countSolid(g);
    const sym = symmetrizeGrid(g, 0);
    const symSolid = sym.reduce((s, v) => s + v, 0);

    expect(symSolid).toBeGreaterThan(before); // union added the mirrored bump
    // idempotent: a symmetric grid gains nothing from another pass
    const twice = symmetrizeGrid({ ...g, data: sym }, 0);
    expect(twice.reduce((s, v) => s + v, 0)).toBe(symSolid);
  });

  it('mirrorMesh doubles triangles and keeps the bounding box', () => {
    const m = applyMatrix4(makeBox(20, 30, 10), translation(4, 0, 0));
    const before = computeBounds(m);
    const s = mirrorMesh(m, 0);
    const after = computeBounds(s);
    expect(s.positions.length).toBe(m.positions.length * 2);
    expect(after.min[0]).toBeCloseTo(before.min[0], 4);
    expect(after.max[0]).toBeCloseTo(before.max[0], 4);
  });

  it('analyse with symmetryAxis produces a symmetric grid and symmetric templates', () => {
    const n = normalizeMesh(makePawn(), { targetSize: 100 });
    const blank = defaultBlank();
    const fit = autoFit(n.bounds, blank, [0, 0, 0], 4);
    const placed = applyMatrix4(n.mesh, placementMatrix(fit.placement, n.bounds));

    const plain = analyse(placed, blank, { approxCells: 40 });
    const sym = analyse(placed, blank, { approxCells: 40, symmetryAxis: 0 });

    const d = sym.grid;
    const finalData = sym.stages[sym.stages.length - 1].data;
    const gridLike = { nx: d.nx, ny: d.ny, nz: d.nz, data: finalData } as Parameters<typeof symmetrizeGrid>[0];
    const reSym = symmetrizeGrid(gridLike, 0);
    expect(reSym.reduce((s, v) => s + v, 0)).toBe(finalData.reduce((s, v) => s + v, 0)); // already symmetric
    // symmetry never removes material vs. the plain run
    expect(sym.solidVolumeCm3).toBeGreaterThanOrEqual(plain.solidVolumeCm3 - 1e-6);
    expect(sym.stageInvariant.ok).toBe(true);
  });
});
