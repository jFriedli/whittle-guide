import { describe, it, expect } from 'vitest';
import { makeSphere, makePawn, makeCone, makeBox, applyMatrix4, translation, computeBounds } from '../src/geometry/mesh';
import { normalizeMesh } from '../src/geometry/normalize';
import { autoFit, defaultBlank, placementMatrix, Blank } from '../src/geometry/blank';
import { voxelize, countSolid } from '../src/geometry/voxelize';
import { buildCarvingStages, verifyStageInvariant } from '../src/geometry/carvingStages';
import { analyse } from '../src/geometry/analysis';
import { Mesh } from '../src/geometry/mesh';

function placedGrid(mesh: Mesh, blank: Blank = defaultBlank(), cells = 44) {
  const n = normalizeMesh(mesh, { targetSize: 100 });
  const fit = autoFit(n.bounds, blank, [0, 0, 0], 4);
  const m = placementMatrix(fit.placement, n.bounds);
  return voxelize(applyMatrix4(n.mesh, m), blank, { approxCells: cells });
}

describe('carving stage containment invariant', () => {
  for (const [name, mesh] of [
    ['sphere', makeSphere(1, 40)],
    ['pawn', makePawn()],
    ['cone', makeCone(1, 2, 40)],
    ['box', makeBox(1, 2, 1)],
  ] as [string, Mesh][]) {
    it(`blank ⊇ stage1 ⊇ ... ⊇ final  (${name})`, () => {
      const g = placedGrid(mesh);
      const stages = buildCarvingStages(g);
      const check = verifyStageInvariant(stages);
      expect(check.violations).toEqual([]);
      expect(check.ok).toBe(true);

      // monotonic non-increasing volume
      for (let i = 1; i < stages.length; i++) {
        expect(stages[i].volumeCm3).toBeLessThanOrEqual(stages[i - 1].volumeCm3 + 1e-6);
      }
      // final stage equals the model occupancy exactly
      const finalSolid = countSolid({ data: stages[stages.length - 1].data });
      expect(finalSolid).toBe(countSolid(g));
      // first stage is the whole blank
      expect(countSolid({ data: stages[0].data })).toBe(g.data.length);
    });
  }
});

describe('safety margin monotonicity', () => {
  it('margins decrease across the shaping stages', () => {
    const g = placedGrid(makePawn());
    const stages = buildCarvingStages(g);
    const shaping = stages.slice(5).map((s) => s.marginMm);
    for (let i = 1; i < shaping.length; i++) {
      expect(shaping[i]).toBeLessThanOrEqual(shaping[i - 1]);
    }
    expect(stages[stages.length - 1].marginMm).toBe(0);
  });
});

describe('full analysis pipeline', () => {
  it('produces every artefact for the pawn and passes its own invariant check', () => {
    const n = normalizeMesh(makePawn(), { targetSize: 100 });
    const blank = defaultBlank();
    const fit = autoFit(n.bounds, blank, [0, 0, 0], 4);
    const placed = applyMatrix4(n.mesh, placementMatrix(fit.placement, n.bounds));
    const res = analyse(placed, blank, { approxCells: 40 });

    expect(res.projections).toHaveLength(6);
    expect(res.projections.every((p) => p.outline.length > 0)).toBe(true);
    expect(res.depthMaps).toHaveLength(4);
    expect(res.depthMaps.every((d) => d.maxDepthMm > 0)).toBe(true);
    expect(res.contours.length).toBeGreaterThan(0);
    expect(res.stages).toHaveLength(9);
    expect(res.stageInvariant.ok).toBe(true);
    expect(res.carvability.difficulty).toBeGreaterThanOrEqual(1);
    expect(res.carvability.difficulty).toBeLessThanOrEqual(5);
    expect(res.solidVolumeCm3).toBeGreaterThan(0);
    expect(res.solidVolumeCm3).toBeLessThan(res.blankVolumeCm3);
  });
});

describe('disconnected parts detection', () => {
  it('flags two separated blocks', () => {
    // Placed directly in blank space: two 18mm cubes with a 20mm air gap.
    const a = applyMatrix4(makeBox(18, 18, 18), translation(0, 28, 0));
    const b = applyMatrix4(makeBox(18, 18, 18), translation(0, -28, 0));
    const placed: Mesh = { positions: Float32Array.of(...a.positions, ...b.positions) };
    const blank = defaultBlank();
    void computeBounds(placed);
    const res = analyse(placed, blank, { approxCells: 50 });
    expect(res.carvability.metrics.disconnectedParts).toBeGreaterThanOrEqual(2);
    expect(res.carvability.warnings.join(' ')).toMatch(/disconnected/i);
  });
});
