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
import { voxelize, VoxelGrid, solidVolume, makeGridLike } from './voxelize';
import { project, outlinePolylines, ALL_VIEWS, ViewName } from './projection';
import { silhouette } from './silhouette';
import { depthField, DepthField, FACE_DEPTH_VIEWS } from './depthField';
import { contourMap, CONTOUR_INTERVALS } from './contours';
import { buildCarvingStages, verifyStageInvariant, CarvingStage } from './carvingStages';
import { analyseCarvability, CarvabilityReport } from './carvability';
import { suggestRoughCuts, RoughCut } from './roughCuts';
import { undercutMask } from './undercuts';
import { analyseFragility, GrainAxis } from './fragility';
import { getKernel } from './wasm';

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

/** Projected outlines of key carving stages, for overlaying on a template. */
export interface StageOutlineResult {
  view: ViewName;
  widthMm: number;
  heightMm: number;
  stages: { index: number; name: string; marginMm: number; polylines: number[][][] }[];
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
  /** Which tools suit this stage, given the model's undercuts / fragility. */
  toolHint: string;
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
  /** Nested stage outlines per template view (block → coarse → medium → final). */
  stageOutlines: StageOutlineResult[];
  stages: StageResult[];
  stageInvariant: { ok: boolean; violations: string[] };
  carvability: CarvabilityReport;
  roughCuts: RoughCut[];
  /** Surface voxels a straight knife can't reach from any axis (grid-sized mask). */
  undercuts: { mask: Uint8Array; fraction: number };
  /** Thin / fragile solid voxels. */
  fragility: { mask: Uint8Array; minThicknessMm: number; fraction: number; crossGrainFraction: number };
  /** Blank axis the wood grain runs along (0=X,1=Y,2=Z). */
  grainAxis: GrainAxis;
  /** Which geometry backend ran this analysis. */
  engine: 'wasm' | 'js';
}

export interface AnalysisOptions {
  approxCells?: number;
  depthQuantiseMm?: number;
  contourIntervalMm?: number;
  voxelAxes?: 1 | 3;
  /** Pixels across the longer face axis for silhouette tracing. Default 420. */
  silhouetteResolution?: number;
  /** Pixels across the longer face axis for depth maps / contours. Default 300. */
  depthResolution?: number;
  /** Which blank axis the grain runs along. Default 1 (Y / height). */
  grainAxis?: GrainAxis;
  /** How many carving stages to build (4–9). Default 9. */
  stageCount?: number;
}

/** Suggest hand tools for a stage from its role and the model's difficulty. */
function stageToolHint(
  stage: CarvingStage,
  stageCount: number,
  undercutFraction: number,
  crossGrainFraction: number,
): string {
  if (stage.index === 0) return 'Pencil, square and marking gauge — lay out centre lines on every face.';

  const last = stage.index === stageCount - 1 || stage.marginMm === 0;
  const name = stage.name.toLowerCase();
  const isSawStage = /block|silhouette|corner/.test(name);

  if (last) {
    let t = 'Detail knife and a 60° V-tool for crisp lines; a shallow (#3) gouge for soft transitions.';
    if (undercutFraction > 0.05)
      t += ' Reach the shaded undercut areas with a bent (hook) knife or a spoon gouge — a straight blade will bruise them.';
    if (crossGrainFraction > 0.12)
      t += ' On the across-grain parts take paring cuts only, with stop cuts first, to avoid splitting.';
    return t;
  }
  if (isSawStage)
    return 'Bow or coping saw for the straight outside cuts; a hatchet or a large flat (#3) gouge to knock off the waste. Stay proud of the line.';
  if (/envelope/.test(name))
    return 'Large (#5–#7) gouge and a roughing knife, working in from the corners. Keep everything oversize.';
  if (/medium/.test(name))
    return 'Bench knife and a medium (#5) gouge. Establish flat planes before you round anything.';
  // near-final / anything left
  return 'Detail knife and a shallow (#3) gouge. Pare with the grain, cut stop cuts first, no undercutting yet.';
}

/** Pick up to four representative stages (excluding the raw blank) for cut-lines. */
function pickOutlineStages(stages: CarvingStage[]): CarvingStage[] {
  const body = stages.slice(1);
  if (body.length <= 4) return body;
  const picks = [
    body[0],
    body[Math.floor(body.length / 3)],
    body[Math.floor((2 * body.length) / 3)],
    body[body.length - 1],
  ];
  return picks.filter((s, i) => picks.indexOf(s) === i);
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

  const depthQuantiseMm = opts.depthQuantiseMm ?? 1;
  const depthByView = new Map<ViewName, DepthField>();
  for (const view of FACE_DEPTH_VIEWS) {
    depthByView.set(
      view,
      depthField(placed, blank, view, {
        resolution: opts.depthResolution ?? 300,
        quantiseMm: depthQuantiseMm,
      }),
    );
  }

  const depthMaps = FACE_DEPTH_VIEWS.map((view) => {
    const dm = depthByView.get(view)!;
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
    const dm = depthByView.get(view)!;
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

  const grainAxis = opts.grainAxis ?? 1;
  const stages: CarvingStage[] = buildCarvingStages(grid, { stageCount: opts.stageCount });
  const stageInvariant = verifyStageInvariant(stages);

  // Roughing cut-lines: project a few key stages onto each face so the printed
  // template can show nested "cut to here" outlines (block → coarse → near → final).
  const outlineStages = pickOutlineStages(stages);
  const STAGE_OUTLINE_VIEWS: ViewName[] = ['front', 'back', 'left', 'right', 'top'];
  const stageOutlines: StageOutlineResult[] = STAGE_OUTLINE_VIEWS.map((view) => {
    const base = project(grid, view);
    return {
      view,
      widthMm: base.widthMm,
      heightMm: base.heightMm,
      stages: outlineStages.map((s) => ({
        index: s.index,
        name: s.name,
        marginMm: s.marginMm,
        polylines: outlinePolylines(project(makeGridLike(grid, s.data), view)),
      })),
    };
  });

  const uc = undercutMask(grid);
  const frag = analyseFragility(grid, grainAxis);
  const carvability = analyseCarvability(grid, {
    mesh: placed,
    undercutFraction: uc.fraction,
    fragility: frag,
  });
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
    stageOutlines,
    stages: stages.map((s) => ({
      index: s.index,
      name: s.name,
      marginMm: s.marginMm,
      volumeCm3: s.volumeCm3,
      removedCm3: s.removedCm3,
      removedPct: s.removedPct,
      cumulativeRemovedPct: s.cumulativeRemovedPct,
      instruction: s.instruction,
      toolHint: stageToolHint(s, stages.length, uc.fraction, frag.crossGrainFraction),
      data: s.data,
    })),
    stageInvariant,
    carvability,
    roughCuts,
    undercuts: { mask: uc.mask, fraction: uc.fraction },
    fragility: {
      mask: frag.mask,
      minThicknessMm: frag.minThicknessMm,
      fraction: frag.fraction,
      crossGrainFraction: frag.crossGrainFraction,
    },
    grainAxis,
    engine: getKernel() ? 'wasm' : 'js',
  };
}
