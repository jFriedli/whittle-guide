import { describe, it, expect } from 'vitest';
import {
  makeBox,
  makeSphere,
  makeCylinder,
  makeCone,
  makePawn,
  computeBounds,
  boxSize,
  applyMatrix4,
  translation,
} from '../src/geometry/mesh';
import { normalizeMesh } from '../src/geometry/normalize';
import { autoFit, defaultBlank, placementMatrix, fitsInside, blankBox } from '../src/geometry/blank';
import { voxelize, solidVolume, countSolid } from '../src/geometry/voxelize';
import { project, silhouetteExtent } from '../src/geometry/projection';
import { depthMap, sampleDepthAt } from '../src/geometry/depthMap';
import { contourMap } from '../src/geometry/contours';

describe('mesh generators + bounds', () => {
  it('box has exact bounds', () => {
    const b = computeBounds(makeBox(10, 20, 30));
    expect(boxSize(b)).toEqual([10, 20, 30]);
  });
  it('sphere bounds ~ diameter', () => {
    const s = boxSize(computeBounds(makeSphere(5, 32)));
    expect(s[0]).toBeCloseTo(10, 1);
    expect(s[1]).toBeCloseTo(10, 1);
  });
  it('cylinder aligned to Y', () => {
    const s = boxSize(computeBounds(makeCylinder(3, 12, 32)));
    expect(s[1]).toBeCloseTo(12, 5);
    expect(s[0]).toBeCloseTo(6, 1);
  });
});

describe('normalize', () => {
  it('centres and scales to target size', () => {
    const raw = applyMatrix4(makeBox(1000, 500, 250), translation(4000, -2000, 100));
    const { bounds, report } = normalizeMesh(raw, { targetSize: 100 });
    const size = boxSize(bounds);
    expect(Math.max(...size)).toBeCloseTo(100, 3);
    const c = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
    expect(Math.abs(c[0])).toBeLessThan(1e-3);
    expect(report.inputTriangles).toBe(12);
  });
  it('drops degenerate triangles', () => {
    const good = makeBox(10, 10, 10).positions;
    const withDegen = new Float32Array(good.length + 9);
    withDegen.set(good);
    // a zero-area triangle
    withDegen.set([0, 0, 0, 1, 1, 1, 2, 2, 2], good.length);
    const { report } = normalizeMesh({ positions: withDegen }, { targetSize: 10 });
    expect(report.removedDegenerate).toBeGreaterThanOrEqual(1);
  });
  it('simplifies a dense sphere', () => {
    const dense = makeSphere(50, 120);
    const { report } = normalizeMesh(dense, { maxTriangles: 2000 });
    expect(report.simplified).toBe(true);
    expect(report.outputTriangles).toBeLessThanOrEqual(2600);
  });
});

describe('auto-fit', () => {
  it('fits inside the blank preserving aspect ratio', () => {
    const blank = defaultBlank();
    const norm = normalizeMesh(makeCylinder(20, 80, 40), { targetSize: 100 });
    const fit = autoFit(norm.bounds, blank, [0, 0, 0], 3);
    const m = placementMatrix(fit.placement, norm.bounds);
    const placed = applyMatrix4(norm.mesh, m);
    expect(fitsInside(computeBounds(placed), blank)).toBe(true);
    // aspect ratio preserved: fitted proportions match normalised proportions
    const ns = boxSize(norm.bounds);
    const fs = fit.fittedSize;
    expect(fs[1] / fs[0]).toBeCloseTo(ns[1] / ns[0], 1);
  });
  it('leaves the requested margin', () => {
    const blank = { width: 50, height: 120, depth: 50 };
    const norm = normalizeMesh(makeBox(40, 100, 40), { targetSize: 100 });
    const fit = autoFit(norm.bounds, blank, [0, 0, 0], 5);
    expect(fit.fittedSize[1]).toBeLessThanOrEqual(120 - 10 + 1e-6);
    const m = placementMatrix(fit.placement, norm.bounds);
    const placed = computeBounds(applyMatrix4(norm.mesh, m));
    expect(placed.max[1]).toBeLessThanOrEqual(60 - 5 + 1e-6);
  });
});

describe('voxelisation', () => {
  it('box fills its analytic volume within 5%', () => {
    const blank = { width: 40, height: 40, depth: 40 };
    const mesh = makeBox(20, 20, 20);
    const g = voxelize(mesh, blank, { approxCells: 40 });
    const vol = solidVolume(g);
    expect(vol).toBeGreaterThan(8000 * 0.9);
    expect(vol).toBeLessThan(8000 * 1.12);
  });
  it('sphere ~ 4/3 pi r^3', () => {
    const blank = { width: 40, height: 40, depth: 40 };
    const g = voxelize(makeSphere(15, 48), blank, { approxCells: 48 });
    const expected = (4 / 3) * Math.PI * 15 ** 3;
    expect(solidVolume(g)).toBeGreaterThan(expected * 0.85);
    expect(solidVolume(g)).toBeLessThan(expected * 1.15);
  });
  it('empty where there is no geometry', () => {
    const g = voxelize(makeBox(10, 10, 10), { width: 60, height: 60, depth: 60 }, { approxCells: 30 });
    // corners must be empty
    expect(g.data[0]).toBe(0);
  });
});

describe('projection extents', () => {
  it('front silhouette of a placed box matches its size', () => {
    const blank = { width: 60, height: 60, depth: 60 };
    const mesh = makeBox(30, 40, 20);
    const g = voxelize(mesh, blank, { approxCells: 60 });
    const p = project(g, 'front');
    const [x0, y0, x1, y1] = silhouetteExtent(p);
    expect(x1 - x0).toBeCloseTo(30, 0);
    expect(y1 - y0).toBeCloseTo(40, 0);
  });
  it('top silhouette uses width x depth', () => {
    const blank = { width: 60, height: 80, depth: 40 };
    const g = voxelize(makeBox(30, 50, 20), blank, { approxCells: 50 });
    const p = project(g, 'top');
    expect(p.widthMm).toBe(60);
    expect(p.heightMm).toBe(40);
  });
});

describe('depth maps', () => {
  it('depth to a centred sphere front face', () => {
    const blank = { width: 40, height: 40, depth: 40 };
    const g = voxelize(makeSphere(15, 48), blank, { approxCells: 48 });
    const dm = depthMap(g, 'front', { quantiseMm: 1 });
    // at the centre of the face, first hit is at depth ~ (20 - 15) = 5mm
    const d = sampleDepthAt(dm, 20, 20);
    expect(d).toBeGreaterThan(2);
    expect(d).toBeLessThan(9);
    expect(dm.maxDepthMm).toBeGreaterThan(0);
  });
  it('no hit outside silhouette returns -1', () => {
    const blank = { width: 60, height: 60, depth: 60 };
    const g = voxelize(makeSphere(10, 32), blank, { approxCells: 40 });
    const dm = depthMap(g, 'front');
    expect(sampleDepthAt(dm, 2, 2)).toBe(-1);
  });
});

describe('contours', () => {
  it('generates nested contour levels for a cone', () => {
    const blank = { width: 50, height: 50, depth: 50 };
    const g = voxelize(applyMatrix4(makeCone(18, 40, 48), translation(0, 0, 0)), blank, { approxCells: 50 });
    const dm = depthMap(g, 'front', { quantiseMm: 1 });
    const cm = contourMap(dm, 5);
    expect(cm.levels.length).toBeGreaterThanOrEqual(2);
    // deeper levels enclose less area (fewer/shorter polylines total length)
    const len = (lvl: { polylines: number[][][] }) =>
      lvl.polylines.reduce((s, pl) => s + pl.length, 0);
    expect(len(cm.levels[0])).toBeGreaterThanOrEqual(len(cm.levels[cm.levels.length - 1]));
  });
});

describe('blank helpers', () => {
  it('blankBox is centred', () => {
    const b = blankBox({ width: 10, height: 20, depth: 30 });
    expect(b.min).toEqual([-5, -10, -15]);
    expect(b.max).toEqual([5, 10, 15]);
  });
  it('pawn normalises without throwing and is non-empty', () => {
    const n = normalizeMesh(makePawn(), { targetSize: 100 });
    const g = voxelize(applyMatrix4(n.mesh, placementMatrix(autoFit(n.bounds, defaultBlank()).placement, n.bounds)), defaultBlank(), { approxCells: 40 });
    expect(countSolid(g)).toBeGreaterThan(100);
  });
});
