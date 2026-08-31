/**
 * Progressive carving stages.
 *
 * Each stage is a solid region S_k with the guaranteed invariant
 *
 *     blank = S_0 ⊇ S_1 ⊇ S_2 ⊇ ... ⊇ S_n = final model
 *
 * and, crucially, every S_k ⊇ final. We achieve this by construction: each stage
 * is the previous stage intersected with one more "constraint region" C_k, and
 * every C_k is itself a superset of the final model (a dilation, an AABB, or a
 * back-extruded silhouette). Intersecting supersets-of-final can only ever
 * shrink towards — never inside — the final model. So the guide can never tell
 * you to remove wood that belongs to the finished carving.
 *
 * This is geometry-based staging, not tool-path planning (see README).
 */

import { VoxelGrid, makeGridLike, countSolid, voxelVolume } from './voxelize';
import { distanceToSolid, dilate } from './distance';

export interface CarvingStage {
  index: number;
  name: string;
  /** Solid occupancy for this stage (same dims as the source grid). */
  data: Uint8Array;
  /** Safety margin this stage aims to leave outside the final surface, mm. */
  marginMm: number;
  volumeCm3: number;
  /** Volume removed since the previous stage, cm³. */
  removedCm3: number;
  removedPct: number;
  cumulativeRemovedPct: number;
  instruction: string;
}

export interface StageMargins {
  coarse: number;
  intermediate: number;
  near: number;
}

export function adaptiveMargins(finalGrid: VoxelGrid): StageMargins {
  // Smallest solid extent of the model, mm.
  const ext = solidExtentMm(finalGrid);
  const minExt = Math.max(4, Math.min(ext[0], ext[1], ext[2]));
  const coarse = Math.min(5, minExt * 0.35);
  return {
    coarse,
    intermediate: Math.min(2, coarse * 0.5),
    near: Math.min(1, coarse * 0.25),
  };
}

function solidExtentMm(g: VoxelGrid): [number, number, number] {
  let minI = g.nx, minJ = g.ny, minK = g.nz, maxI = -1, maxJ = -1, maxK = -1;
  for (let k = 0; k < g.nz; k++)
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        if (g.data[i + g.nx * (j + g.ny * k)]) {
          if (i < minI) minI = i; if (i > maxI) maxI = i;
          if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
          if (k < minK) minK = k; if (k > maxK) maxK = k;
        }
      }
  if (maxI < 0) return [0, 0, 0];
  return [
    (maxI - minI + 1) * g.d[0],
    (maxJ - minJ + 1) * g.d[1],
    (maxK - minK + 1) * g.d[2],
  ];
}

const and = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
};

/** AABB of the solid, dilated by `padMm`, filled solid — a superset of `final`. */
function paddedBoundingBox(g: VoxelGrid, padMm: number): Uint8Array {
  let minI = g.nx, minJ = g.ny, minK = g.nz, maxI = -1, maxJ = -1, maxK = -1;
  for (let k = 0; k < g.nz; k++)
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++)
        if (g.data[i + g.nx * (j + g.ny * k)]) {
          if (i < minI) minI = i; if (i > maxI) maxI = i;
          if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
          if (k < minK) minK = k; if (k > maxK) maxK = k;
        }
  const out = new Uint8Array(g.data.length);
  if (maxI < 0) return out;
  const pi = Math.ceil(padMm / g.d[0]);
  const pj = Math.ceil(padMm / g.d[1]);
  const pk = Math.ceil(padMm / g.d[2]);
  const i0 = Math.max(0, minI - pi), i1 = Math.min(g.nx - 1, maxI + pi);
  const j0 = Math.max(0, minJ - pj), j1 = Math.min(g.ny - 1, maxJ + pj);
  const k0 = Math.max(0, minK - pk), k1 = Math.min(g.nz - 1, maxK + pk);
  for (let k = k0; k <= k1; k++)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) out[i + g.nx * (j + g.ny * k)] = 1;
  return out;
}

/**
 * Back-extrude a silhouette: axis 0=X (left/right), 1=Y (top/bottom), 2=Z (front/back).
 * Mark the whole line through any solid voxel, then dilate in-plane by padMm.
 * Result ⊇ final (it contains the model's shadow swept through the blank).
 */
function extrudedSilhouette(g: VoxelGrid, axis: 0 | 1 | 2, padMm: number): Uint8Array {
  const { nx, ny, nz, data } = g;
  const out = new Uint8Array(data.length);
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  if (axis === 2) {
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let hit = false;
        for (let k = 0; k < nz; k++) if (data[idx(i, j, k)]) { hit = true; break; }
        if (hit) for (let k = 0; k < nz; k++) out[idx(i, j, k)] = 1;
      }
  } else if (axis === 0) {
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        let hit = false;
        for (let i = 0; i < nx; i++) if (data[idx(i, j, k)]) { hit = true; break; }
        if (hit) for (let i = 0; i < nx; i++) out[idx(i, j, k)] = 1;
      }
  } else {
    for (let k = 0; k < nz; k++)
      for (let i = 0; i < nx; i++) {
        let hit = false;
        for (let j = 0; j < ny; j++) if (data[idx(i, j, k)]) { hit = true; break; }
        if (hit) for (let j = 0; j < ny; j++) out[idx(i, j, k)] = 1;
      }
  }
  if (padMm > 0) {
    const tmp = makeGridLike(g, out);
    return dilate(tmp, padMm);
  }
  return out;
}

export interface StageOptions {
  margins?: StageMargins;
}

/**
 * Build the full stage sequence from the final-model voxel grid.
 */
export function buildCarvingStages(finalGrid: VoxelGrid, opts: StageOptions = {}): CarvingStage[] {
  const margins = opts.margins ?? adaptiveMargins(finalGrid);
  const voxCm3 = voxelVolume(finalGrid) / 1000;
  const totalVox = finalGrid.data.length;

  const finalDist = distanceToSolid(finalGrid);
  const full = new Uint8Array(totalVox).fill(1);

  const constraints: { name: string; region: Uint8Array; margin: number; instr: (ctx: InstrCtx) => string }[] = [
    {
      name: 'Coarse block',
      region: paddedBoundingBox(finalGrid, margins.coarse),
      margin: margins.coarse,
      instr: (c) =>
        `Saw the blank down to roughly a ${c.stageSizeMm} mm block — the smallest rectangular prism that still encloses the whole figure plus a ${fmt(margins.coarse)} mm margin. Removes about ${fmt(c.removedCm3)} cm³ (${Math.round(c.removedPct)}%).`,
    },
    {
      name: 'Front / back silhouette',
      region: extrudedSilhouette(finalGrid, 2, margins.coarse),
      margin: margins.coarse,
      instr: (c) =>
        `Transfer the FRONT template and cut away everything outside that outline, all the way through the block. Stay about ${fmt(margins.coarse)} mm proud of the line. Removes ~${fmt(c.removedCm3)} cm³.`,
    },
    {
      name: 'Left / right silhouette',
      region: extrudedSilhouette(finalGrid, 0, margins.coarse),
      margin: margins.coarse,
      instr: (c) =>
        `Now transfer the SIDE template and repeat: saw/chisel away everything outside the side outline, ~${fmt(margins.coarse)} mm proud. The block is now a rough cross of the two silhouettes. Removes ~${fmt(c.removedCm3)} cm³.`,
    },
    {
      name: 'Top silhouette & corners',
      region: extrudedSilhouette(finalGrid, 1, margins.coarse),
      margin: margins.coarse,
      instr: (c) =>
        `Knock off the four long corners left by the previous cuts, guided by the TOP template. Do not yet carve any part to final thickness. Removes ~${fmt(c.removedCm3)} cm³.`,
    },
    {
      name: 'Coarse 3-D envelope',
      region: dilate(finalGrid, margins.coarse, finalDist),
      margin: margins.coarse,
      instr: (c) =>
        `Round the block down to a coarse 3-D envelope roughly ${fmt(margins.coarse)} mm oversize everywhere. Work all around; keep checking depth against the contour maps. Removes ~${fmt(c.removedCm3)} cm³.`,
    },
    {
      name: 'Medium detail',
      region: dilate(finalGrid, margins.intermediate, finalDist),
      margin: margins.intermediate,
      instr: (c) =>
        `Refine to about ${fmt(margins.intermediate)} mm oversize. Establish the major forms and their relationships. Fragile protrusions stay chunky for now. Removes ~${fmt(c.removedCm3)} cm³.`,
    },
    {
      name: 'Near-final',
      region: dilate(finalGrid, margins.near, finalDist),
      margin: margins.near,
      instr: (c) =>
        `Bring the surface to about ${fmt(margins.near)} mm oversize. Do not undercut. This is the last stage with a safety margin. Removes ~${fmt(c.removedCm3)} cm³.`,
    },
    {
      name: 'Final surface',
      region: finalGrid.data,
      margin: 0,
      instr: (c) =>
        `Carve to the final surface and add detail. Total wood removed from the blank: about ${fmt(c.cumulativeRemovedCm3)} cm³ (${Math.round(c.cumulativeRemovedPct)}%).`,
    },
  ];

  const stages: CarvingStage[] = [];
  const blankCm3 = totalVox * voxCm3;
  let prev: Uint8Array = full;
  let prevVol = countSolid({ data: full }) * voxCm3;
  const blankVol = prevVol;

  stages.push({
    index: 0,
    name: 'Rectangular blank',
    data: full,
    marginMm: Infinity,
    volumeCm3: blankVol,
    removedCm3: 0,
    removedPct: 0,
    cumulativeRemovedPct: 0,
    instruction: `Start with the full ${fmt(finalGrid.blank.width)} × ${fmt(finalGrid.blank.height)} × ${fmt(finalGrid.blank.depth)} mm blank. Mark centre lines on every face before making a cut.`,
  });

  let cumulative = 0;
  constraints.forEach((con, ci) => {
    const region = and(prev, con.region);
    const vol = countSolid({ data: region }) * voxCm3;
    const removed = Math.max(0, prevVol - vol);
    cumulative += removed;
    const ctx: InstrCtx = {
      removedCm3: removed,
      removedPct: (removed / blankCm3) * 100,
      cumulativeRemovedCm3: cumulative,
      cumulativeRemovedPct: (cumulative / blankCm3) * 100,
      stageSizeMm: sizeLabel(makeGridLike(finalGrid, region), finalGrid),
    };
    stages.push({
      index: ci + 1,
      name: con.name,
      data: region,
      marginMm: con.margin,
      volumeCm3: vol,
      removedCm3: removed,
      removedPct: ctx.removedPct,
      cumulativeRemovedPct: ctx.cumulativeRemovedPct,
      instruction: con.instr(ctx),
    });
    prev = region;
    prevVol = vol;
  });

  return stages;
}

interface InstrCtx {
  removedCm3: number;
  removedPct: number;
  cumulativeRemovedCm3: number;
  cumulativeRemovedPct: number;
  stageSizeMm: string;
}

function sizeLabel(g: VoxelGrid, ref: VoxelGrid): string {
  const e = solidExtentMm({ ...ref, data: g.data });
  return `${fmt(e[0])} × ${fmt(e[1])} × ${fmt(e[2])}`;
}

const fmt = (n: number): string => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));

/**
 * Verify the containment invariant across a stage list. Returned violations are
 * (stageIndex, voxelCount) pairs where a later stage is NOT a subset of an
 * earlier one, or a stage does not contain the final model.
 */
export function verifyStageInvariant(stages: CarvingStage[]): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const final = stages[stages.length - 1].data;
  for (let i = 1; i < stages.length; i++) {
    const a = stages[i - 1].data;
    const b = stages[i].data;
    let notSubset = 0;
    for (let v = 0; v < b.length; v++) if (b[v] && !a[v]) notSubset++;
    if (notSubset > 0) violations.push(`stage ${i} not ⊆ stage ${i - 1} (${notSubset} voxels)`);
  }
  for (let i = 0; i < stages.length; i++) {
    let missing = 0;
    const s = stages[i].data;
    for (let v = 0; v < final.length; v++) if (final[v] && !s[v]) missing++;
    if (missing > 0) violations.push(`stage ${i} does not contain final model (${missing} voxels)`);
  }
  return { ok: violations.length === 0, violations };
}
