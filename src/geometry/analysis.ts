/**
 * High-level analysis pipeline. Pure and synchronous so it can be unit-tested in
 * Node and run inside a Web Worker unchanged.
 *
 *   placed mesh (blank space)
 *        -> voxelise
 *        -> orthographic projections (6)
 *        -> depth maps (4 faces)
 *        -> contour maps (2 / 5 / 10 mm)
 *        -> progressive carving stages (invariant-checked)
 *        -> carvability report
 *        -> experimental rough cuts
 */

import { Mesh, triangleCount } from './mesh';
import { Blank } from './blank';
import { voxelize, VoxelGrid, solidVolume } from './voxelize';
import { project, ALL_VIEWS, ViewName } from './projection';
import { silhouette } from './silhouette';
import { depthMap, DepthMap, FACE_DEPTH_VIEWS } from './depthMap';
import { contourMap, CONTOUR_INTERVALS } from './contours';
import { buildCarvingStages, verifyStageInvariant, CarvingStage } from './carvingStages';
import { analyseCarvability, CarvabilityReport } from './carvability';
import { suggestRoughCuts, RoughCut } from './roughCuts';

export interface ProjectionResult {
  view: ViewName;
  widthMm: number;
  heightMm: number;
  cols: number;
  rows: number;
  mask: Uint8Array;
  outline: number[][][];
  extentMm: [number, number, number, number];
  coverage: number;
}

export interface ContourResult {
  view: ViewName;
  intervalMm: number;
  widthMm: number;
  heightMm: number;
  levels: { depthMm: number; polylines: number[][][] }[];
}

export interface StageResult {
  index: number;
  name: string;
  marginMm: number;
  volumeCm3: number;
  removedCm3: number;
  removedPct: number;
  cumulativeRemovedPct: number;
  instruction: string;
  data: Uint8Array;
}

export interface AnalysisResult {
  grid: { nx: number; ny: number; nz: number; d: [number, number, number]; origin: [number, number, number] };
  blank: Blank;
  triangles: number;
  solidVolumeCm3: number;
  blankVolumeCm3: number;
  projections: ProjectionResult[];
  depthMaps: {
    view: ViewName;
    widthMm: number;
    heightMm: number;
    cols: number;
    rows: number;
    depth: Float32Array;
    maxDepthMm: number;
    stepMm: number;
  }[];
  contours: ContourResult[];
  stages: StageResult[];
  stageInvariant: { ok: boolean; violations: string[] };
  carvability: CarvabilityReport;
  roughCuts: RoughCut[];
}

export interface AnalysisOptions {
  approxCells?: number;
  depthQuantiseMm?: number;
  contourIntervalMm?: number;
  voxelAxes?: 1 | 3;
  /** Pixels across the longer face axis for silhouette tracing. Default 420. */
  silhouetteResolution?: number;
}

export function analyse(placed: Mesh, blank: Blank, opts: AnalysisOptions = {}): AnalysisResult {
  const approxCells = opts.approxCells ?? 64;
  const grid: VoxelGrid = voxelize(placed, blank, { approxCells, axes: opts.voxelAxes ?? 3 });

  const projections: ProjectionResult[] = ALL_VIEWS.map((view) => {
    const p = project(grid, view);
    // Outline comes from a high-res projected-triangle raster, independent of the
    // voxel grid, so printed templates stay crisp. The voxel mask is retained for
    // quick coverage/extent checks elsewhere.
    const sil = silhouette(placed, blank, view, { resolution: opts.silhouetteResolution ?? 420 });
    return {
      view,
      widthMm: p.widthMm,
      heightMm: p.heightMm,
      cols: p.cols,
      rows: p.rows,
      mask: p.mask,
      outline: sil.polylines,
      extentMm: sil.extentMm,
      coverage: sil.coverage,
    };
  });

  const depthMaps = FACE_DEPTH_VIEWS.map((view) => {
    const dm: DepthMap = depthMap(grid, view, { quantiseMm: opts.depthQuantiseMm ?? 1 });
    return {
      view,
      widthMm: dm.widthMm,
      heightMm: dm.heightMm,
      cols: dm.cols,
      rows: dm.rows,
      depth: dm.depth,
      maxDepthMm: dm.maxDepthMm,
      stepMm: dm.stepMm,
    };
  });

  const intervals = opts.contourIntervalMm ? [opts.contourIntervalMm] : CONTOUR_INTERVALS;
  const contours: ContourResult[] = [];
  for (const view of FACE_DEPTH_VIEWS) {
    const dm = depthMap(grid, view, { quantiseMm: opts.depthQuantiseMm ?? 1 });
    for (const interval of intervals) {
      const cm = contourMap(dm, interval);
      contours.push({
        view,
        intervalMm: interval,
        widthMm: cm.widthMm,
        heightMm: cm.heightMm,
        levels: cm.levels,
      });
    }
  }

  const stages: CarvingStage[] = buildCarvingStages(grid);
  const stageInvariant = verifyStageInvariant(stages);

  const carvability = analyseCarvability(grid, { mesh: placed });
  const roughCuts = suggestRoughCuts(grid, Math.max(2, carvability.metrics.minFeatureMm));

  const blankVolumeCm3 = (blank.width * blank.height * blank.depth) / 1000;

  return {
    grid: { nx: grid.nx, ny: grid.ny, nz: grid.nz, d: grid.d, origin: grid.origin },
    blank,
    triangles: triangleCount(placed),
    solidVolumeCm3: solidVolume(grid) / 1000,
    blankVolumeCm3,
    projections,
    depthMaps,
    contours,
    stages: stages.map((s) => ({
      index: s.index,
      name: s.name,
      marginMm: s.marginMm,
      volumeCm3: s.volumeCm3,
      removedCm3: s.removedCm3,
      removedPct: s.removedPct,
      cumulativeRemovedPct: s.cumulativeRemovedPct,
      instruction: s.instruction,
      data: s.data,
    })),
    stageInvariant,
    carvability,
    roughCuts,
  };
}
