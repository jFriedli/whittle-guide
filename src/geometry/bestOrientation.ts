/**
 * Search the 24 axis-aligned orientations of a model for the one that carves
 * best: fewest undercuts, fewest cross-grain slivers, a simpler silhouette. Runs
 * a cheap low-resolution analysis per candidate, so it's a few dozen voxelisations.
 */

import { Mesh, Mat4, applyMatrix4, computeBounds, boxSize } from './mesh';
import { Blank, autoFit, placementMatrix, blankVolume } from './blank';
import { voxelize, countSolid, voxelVolume } from './voxelize';
import { undercutMask } from './undercuts';
import { analyseFragility } from './fragility';

/** The 24 rotation matrices that map the axes onto the axes (proper rotations). */
export function cubeRotations(): Mat4[] {
  const out: Mat4[] = [];
  // Ordered so out[0] is the identity (+Y up, +Z forward, +X right).
  const axes: [number, number, number][] = [
    [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0],
  ];
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  for (const up of axes) {
    for (const fwd of axes) {
      if (Math.abs(up[0] * fwd[0] + up[1] * fwd[1] + up[2] * fwd[2]) > 0.5) continue; // not perpendicular
      const right = cross(up, fwd);
      // rows = new X (right), new Y (up), new Z (fwd)  → column-major
      out.push([
        right[0], up[0], fwd[0], 0,
        right[1], up[1], fwd[1], 0,
        right[2], up[2], fwd[2], 0,
        0, 0, 0, 1,
      ]);
    }
  }
  return out;
}

export interface BestOrientationResult {
  rotation: Mat4;
  changed: boolean;
  scores: { undercut: number; fragile: number; crossGrain: number; excess: number; total: number };
}

/**
 * `mesh` is expected already normalised (centred, ~targetSize). Returns the extra
 * rotation to apply.
 */
export function findBestOrientation(mesh: Mesh, blank: Blank, cells = 40): BestOrientationResult {
  const candidates = cubeRotations();
  const results: BestOrientationResult[] = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    const R = candidates[ci];
    const rotated = applyMatrix4(mesh, R);
    const rb = computeBounds(rotated);
    const fit = autoFit(rb, blank, [0, 0, 0], 3);
    const placed = applyMatrix4(rotated, placementMatrix(fit.placement, rb));
    const grid = voxelize(placed, blank, { approxCells: cells });

    const uc = undercutMask(grid).fraction;
    const frag = analyseFragility(grid, 1);
    const excess = 1 - (countSolid(grid) * voxelVolume(grid)) / Math.max(1, blankVolume(blank));

    // Reward keeping the model's longest extent vertical — most carving subjects
    // (figures, busts, totems) are meant to stand up.
    const rbSize = boxSize(rb);
    const uprightness = rbSize[1] / (Math.max(rbSize[0], rbSize[1], rbSize[2]) || 1);

    const total =
      Math.max(0, uc - 0.15) * 2.5 + // only undercuts beyond ~15% really hurt
      frag.fraction * 1.5 +
      frag.crossGrainFraction * 0.8 +
      excess * 2 -
      uprightness * 0.7;
    results.push({
      rotation: R,
      changed: false,
      scores: { undercut: uc, fragile: frag.fraction, crossGrain: frag.crossGrainFraction, excess, total },
    });
  }

  const identity = results[0]; // candidates[0] is +Y up / +Z forward
  const min = results.reduce((a, b) => (b.scores.total < a.scores.total ? b : a));
  // Only re-orient for a clear improvement — voxelisation noise between
  // orientations is worth ~0.03, so require more than that.
  const winner = min.scores.total < identity.scores.total - 0.08 ? min : identity;
  const trace = winner.rotation[0] + winner.rotation[5] + winner.rotation[10];
  winner.changed = trace < 2.99;
  return winner;
}
