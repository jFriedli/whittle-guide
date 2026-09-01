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

  it('every stage carries a non-empty tool hint; the last mentions a fine tool', () => {
    const n = normalizeMesh(makePawn(), { targetSize: 100 });
    const blank = defaultBlank();
    const fit = autoFit(n.bounds, blank, [0, 0, 0], 4);
    const placed = applyMatrix4(n.mesh, placementMatrix(fit.placement, n.bounds));
    const res = analyse(placed, blank, { approxCells: 40 });
    expect(res.stages.every((s) => s.toolHint.length > 10)).toBe(true);
    expect(res.stages[0].toolHint).toMatch(/pencil|square|gauge/i);
    expect(res.stages[res.stages.length - 1].toolHint).toMatch(/knife|V-tool/i);
  });

  it('roughing cut-lines nest: each stage outline sits inside the previous one', () => {
    const n = normalizeMesh(makePawn(), { targetSize: 100 });
    const blank = defaultBlank();
    const fit = autoFit(n.bounds, blank, [0, 0, 0], 4);
    const placed = applyMatrix4(n.mesh, placementMatrix(fit.placement, n.bounds));
    const res = analyse(placed, blank, { approxCells: 40 });

    expect(res.stageOutlines.map((s) => s.view)).toEqual(['front', 'back', 'left', 'right', 'top']);
    for (const so of res.stageOutlines) {
      expect(so.stages.length).toBeGreaterThanOrEqual(2);
      // margins strictly decrease towards the final (0) line
      for (let i = 1; i < so.stages.length; i++) {
        expect(so.stages[i].marginMm).toBeLessThanOrEqual(so.stages[i - 1].marginMm);
      }
      expect(so.stages[so.stages.length - 1].marginMm).toBe(0);
      // bounding box of each successive outline is contained in the previous one
      const bbox = (pls: number[][][]) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const l of pls) for (const [x, y] of l) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y);
          x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
        return [x0, y0, x1, y1];
      };
      for (let i = 1; i < so.stages.length; i++) {
        const outer = bbox(so.stages[i - 1].polylines);
        const inner = bbox(so.stages[i].polylines);
        const tol = 1.5; // mm — voxel/marching-squares slop
        expect(inner[0]).toBeGreaterThanOrEqual(outer[0] - tol);
        expect(inner[1]).toBeGreaterThanOrEqual(outer[1] - tol);
        expect(inner[2]).toBeLessThanOrEqual(outer[2] + tol);
        expect(inner[3]).toBeLessThanOrEqual(outer[3] + tol);
      }
    }
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
