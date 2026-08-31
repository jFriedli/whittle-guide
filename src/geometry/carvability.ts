/**
 * Heuristic carvability analysis. Not a physical simulation — a set of geometric
 * proxies for "how hard is this to whittle from a block", combined into a 1–5
 * difficulty score and a suggested skill level.
 */

import { VoxelGrid, countSolid, voxelVolume } from './voxelize';
import { erode, distanceToSolid } from './distance';
import { project, coverage, outlinePolylines } from './projection';
import { Mesh, triangleCount } from './mesh';
import { blankVolume } from './blank';

export type Rating = 'None' | 'Low' | 'Moderate' | 'High' | 'Very high';

export interface CarvabilityReport {
  difficulty: number; // 1..5
  stars: string;
  skillLevel: 'Beginner' | 'Beginner / Intermediate' | 'Intermediate' | 'Intermediate / Advanced' | 'Advanced';
  metrics: {
    undercuts: Rating;
    thinFeatures: Rating;
    silhouetteComplexity: Rating;
    deepRecesses: Rating;
    symmetry: Rating;
    excessMaterial: Rating;
    disconnectedParts: number;
    minFeatureMm: number;
  };
  warnings: string[];
  notes: string[];
}

function rate(value: number, thresholds: [number, number, number, number]): Rating {
  if (value < thresholds[0]) return 'None';
  if (value < thresholds[1]) return 'Low';
  if (value < thresholds[2]) return 'Moderate';
  if (value < thresholds[3]) return 'High';
  return 'Very high';
}

const ratingScore: Record<Rating, number> = {
  None: 0, Low: 1, Moderate: 2, High: 3, 'Very high': 4,
};

/** Count undercuts: from each of the 4 side views, columns that go solid→gap→solid. */
function undercutFraction(g: VoxelGrid): number {
  const { nx, ny, nz, data } = g;
  const idx = (i: number, j: number, k: number) => data[i + nx * (j + ny * k)];
  let columns = 0;
  let undercut = 0;
  const scan = (get: (a: number, b: number, t: number) => number, la: number, lb: number, lt: number) => {
    for (let a = 0; a < la; a++)
      for (let b = 0; b < lb; b++) {
        let seenSolid = false;
        let seenGapAfterSolid = false;
        let isUndercut = false;
        for (let t = 0; t < lt; t++) {
          const s = get(a, b, t) === 1;
          if (s && !seenSolid) seenSolid = true;
          else if (!s && seenSolid) seenGapAfterSolid = true;
          else if (s && seenGapAfterSolid) { isUndercut = true; break; }
        }
        if (seenSolid) {
          columns++;
          if (isUndercut) undercut++;
        }
      }
  };
  scan((y, k, i) => idx(i, y, k), ny, nz, nx); // along +X
  scan((y, k, i) => idx(nx - 1 - i, y, k), ny, nz, nx); // along -X
  scan((x, y, k) => idx(x, y, k), nx, ny, nz); // along +Z
  scan((x, y, k) => idx(x, y, nz - 1 - k), nx, ny, nz); // along -Z
  return columns === 0 ? 0 : undercut / columns;
}

/** Connected components (6-neighbour) of the solid, sorted desc by voxel count. */
function components(g: VoxelGrid): number[] {
  const { nx, ny, nz, data } = g;
  const label = new Int32Array(data.length).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || label[start] >= 0) continue;
    const id = sizes.length;
    let count = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const c = stack.pop()!;
      count++;
      const i = c % nx;
      const j = ((c - i) / nx) % ny;
      const k = Math.floor(c / (nx * ny));
      const nb = [
        i > 0 ? c - 1 : -1,
        i < nx - 1 ? c + 1 : -1,
        j > 0 ? c - nx : -1,
        j < ny - 1 ? c + nx : -1,
        k > 0 ? c - nx * ny : -1,
        k < nz - 1 ? c + nx * ny : -1,
      ];
      for (const n of nb) {
        if (n >= 0 && data[n] && label[n] < 0) {
          label[n] = id;
          stack.push(n);
        }
      }
    }
    sizes.push(count);
  }
  return sizes.sort((a, b) => b - a);
}

/** Smallest solid feature size, mm: 2×(largest erosion radius that keeps ≥60% volume). */
function minFeatureMm(g: VoxelGrid): number {
  const base = countSolid(g);
  if (base === 0) return 0;
  const step = (g.d[0] + g.d[1] + g.d[2]) / 3;
  for (let r = step; r <= step * 8; r += step) {
    const e = erode(g, r);
    let c = 0;
    for (let i = 0; i < e.length; i++) c += e[i];
    if (c < base * 0.5) return Math.max(step, 2 * (r - step));
  }
  return step * 16;
}

/** Mirror symmetry across the X=0 plane: overlap fraction. */
function symmetryScore(g: VoxelGrid): number {
  const { nx, ny, nz, data } = g;
  let both = 0;
  let either = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a = data[i + nx * (j + ny * k)];
        const b = data[nx - 1 - i + nx * (j + ny * k)];
        if (a || b) either++;
        if (a && b) both++;
      }
  return either === 0 ? 1 : both / either;
}

function silhouetteComplexity(g: VoxelGrid): number {
  // perimeter^2 / area of the front silhouette, normalised (circle ≈ 4π ≈ 12.57).
  const p = project(g, 'front');
  const lines = outlinePolylines(p);
  let perim = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const dx = line[i][0] - line[i - 1][0];
      const dy = line[i][1] - line[i - 1][1];
      perim += Math.hypot(dx, dy);
    }
  }
  const area = coverage(p) * p.widthMm * p.heightMm;
  if (area <= 0) return 0;
  return (perim * perim) / area / (4 * Math.PI);
}

function deepRecessScore(g: VoxelGrid): number {
  // Distance-into-solid from outside, capped; deep interior cavities read as
  // recesses that a knife cannot reach.
  const inv: VoxelGrid = { ...g, data: new Uint8Array(g.data.length) };
  for (let i = 0; i < inv.data.length; i++) inv.data[i] = g.data[i] ? 0 : 1;
  const dist = distanceToSolid(inv); // distance from each solid voxel to nearest empty
  let deep = 0;
  let solid = 0;
  const thresh = Math.max(g.d[0], g.d[1], g.d[2]) * 4;
  for (let i = 0; i < g.data.length; i++) {
    if (g.data[i]) {
      solid++;
      if (dist[i] > thresh) deep++;
    }
  }
  return solid === 0 ? 0 : deep / solid;
}

export function analyseCarvability(
  finalGrid: VoxelGrid,
  analysisMeshInfo?: { mesh: Mesh },
): CarvabilityReport {
  const solidVol = countSolid(finalGrid) * voxelVolume(finalGrid);
  const blankVol = blankVolume(finalGrid.blank);
  const excess = 1 - solidVol / Math.max(1, blankVol);

  const undercuts = undercutFraction(finalGrid);
  const comps = components(finalGrid);
  const bigComps = comps.length ? comps.filter((c) => c > comps[0] * 0.02).length : 0;
  const minFeat = minFeatureMm(finalGrid);
  const sym = symmetryScore(finalGrid);
  const silh = silhouetteComplexity(finalGrid);
  const deep = deepRecessScore(finalGrid);
  const step = (finalGrid.d[0] + finalGrid.d[1] + finalGrid.d[2]) / 3;

  const rateThin = (mf: number): Rating => {
    if (mf >= step * 6) return 'None';
    if (mf >= step * 4) return 'Low';
    if (mf >= step * 2.5) return 'Moderate';
    if (mf >= step * 1.5) return 'High';
    return 'Very high';
  };

  const metrics = {
    undercuts: rate(undercuts, [0.02, 0.08, 0.18, 0.35]),
    thinFeatures: rateThin(minFeat),
    silhouetteComplexity: rate(silh, [1.3, 1.8, 2.6, 3.6]),
    deepRecesses: rate(deep, [0.02, 0.06, 0.14, 0.28]),
    symmetry: rate(sym, [0.55, 0.75, 0.88, 0.96]),
    excessMaterial: rate(excess, [0.3, 0.55, 0.75, 0.88]),
    disconnectedParts: bigComps,
    minFeatureMm: Math.round(minFeat * 10) / 10,
  };

  // Weighted difficulty.
  let score =
    ratingScore[metrics.undercuts] * 1.4 +
    ratingScore[metrics.thinFeatures] * 1.2 +
    ratingScore[metrics.silhouetteComplexity] * 1.0 +
    ratingScore[metrics.deepRecesses] * 1.1 +
    (4 - ratingScore[metrics.symmetry]) * 0.5 +
    ratingScore[metrics.excessMaterial] * 0.4 +
    (bigComps > 1 ? 3 : 0);

  const maxScore = 4 * 1.4 + 4 * 1.2 + 4 * 1.0 + 4 * 1.1 + 4 * 0.5 + 4 * 0.4;
  const difficulty = Math.max(1, Math.min(5, Math.round(1 + (score / maxScore) * 4)));

  const skillLevel = (
    ['Beginner', 'Beginner / Intermediate', 'Intermediate', 'Intermediate / Advanced', 'Advanced'] as const
  )[difficulty - 1];

  const warnings: string[] = [];
  const notes: string[] = [];

  if (bigComps > 1) {
    warnings.push(
      `The model has ${bigComps} disconnected solid parts. A single wooden blank cannot reproduce separated pieces — carve the largest part, or choose a different subject.`,
    );
  }
  if (minFeat < step * 1.6) {
    warnings.push(
      `Thinnest features are about ${metrics.minFeatureMm} mm. Details this fine are fragile in most carving woods and may snap; consider scaling the blank up.`,
    );
  }
  if (metrics.undercuts === 'High' || metrics.undercuts === 'Very high') {
    warnings.push(
      'Significant undercuts detected. A knife cannot reach behind overhangs — expect to accept some simplification or use bent tools.',
    );
  }
  if (metrics.deepRecesses === 'High' || metrics.deepRecesses === 'Very high') {
    warnings.push('Deep enclosed recesses detected — these need gouges or riffler files, not a straight knife.');
  }
  if (analysisMeshInfo && triangleCount(analysisMeshInfo.mesh) < 50) {
    notes.push('Very low-poly source mesh: faceting may show through in silhouettes and depth maps.');
  }
  if (excess > 0.85) {
    notes.push('The figure fills only a small part of the blank — most of the work is removing bulk waste. A smaller blank would save effort.');
  }
  if (sym > 0.9) notes.push('Near-symmetric subject: you can work both sides in parallel and check one against the other.');

  return {
    difficulty,
    stars: '★'.repeat(difficulty) + '☆'.repeat(5 - difficulty),
    skillLevel,
    metrics,
    warnings,
    notes,
  };
}
