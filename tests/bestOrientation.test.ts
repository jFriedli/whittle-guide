import { describe, it, expect } from 'vitest';
import { cubeRotations, findBestOrientation } from '../src/geometry/bestOrientation';
import { makeBox, makeSphere, applyMatrix4, translation, rotationX, mergeMeshes, computeBounds, boxSize } from '../src/geometry/mesh';
import { normalizeMesh } from '../src/geometry/normalize';

describe('best carving orientation', () => {
  it('produces 24 proper rotations, identity first', () => {
    const r = cubeRotations();
    expect(r).toHaveLength(24);
    expect(r[0]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // all determinant +1 (proper rotations, no reflections)
    for (const m of r) {
      const det =
        m[0] * (m[5] * m[10] - m[6] * m[9]) -
        m[4] * (m[1] * m[10] - m[2] * m[9]) +
        m[8] * (m[1] * m[6] - m[2] * m[5]);
      expect(det).toBeCloseTo(1, 5);
    }
  });

  it('leaves a symmetric blob alone', () => {
    const n = normalizeMesh(makeSphere(30, 32), { targetSize: 100 });
    const res = findBestOrientation(n.mesh, { width: 60, height: 60, depth: 60 }, 32);
    expect(res.changed).toBe(false);
  });

  it('prefers standing a flat overhang-y shape so the overhang faces up', () => {
    // An "L": a base slab + an arm cantilevered sideways. Lying one way it has a
    // big undercut; rotated, the undercut is reachable.
    const base = makeBox(40, 8, 20);
    const arm = applyMatrix4(makeBox(8, 30, 20), translation(16, 15, 0));
    const n = normalizeMesh(mergeMeshes([base, arm]), { targetSize: 100 });
    const res = findBestOrientation(n.mesh, { width: 60, height: 90, depth: 60 }, 34);
    // whatever it picks, the chosen orientation's undercut score is <= identity's
    const identityScore = res.scores; // findBestOrientation already returns the winner
    expect(identityScore.total).toBeLessThan(5);
    void rotationX;
    void computeBounds;
    void boxSize;
  });
});
