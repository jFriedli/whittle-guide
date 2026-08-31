import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GeometryKernel } from '../src/geometry/wasm/kernel';
import { setKernel } from '../src/geometry/wasm';
import { makePawn, makeSphere, makeCone, applyMatrix4, translation } from '../src/geometry/mesh';
import { normalizeMesh } from '../src/geometry/normalize';
import { autoFit, defaultBlank, placementMatrix } from '../src/geometry/blank';
import { voxelize, countSolid } from '../src/geometry/voxelize';
import { distanceToSolid, dilate } from '../src/geometry/distance';

const WASM = resolve(__dirname, '../src/geometry/wasm/kernel.wasm');
const hasWasm = existsSync(WASM);

let kernel: GeometryKernel;

beforeAll(async () => {
  if (!hasWasm) return;
  const bytes = readFileSync(WASM);
  kernel = await GeometryKernel.fromBytes(bytes);
});

afterEach(() => setKernel(null));

function placed(mesh = makePawn()) {
  const n = normalizeMesh(mesh, { targetSize: 100 });
  const blank = defaultBlank();
  const fit = autoFit(n.bounds, blank, [0, 0, 0], 4);
  return {
    positions: applyMatrix4(n.mesh, placementMatrix(fit.placement, n.bounds)).positions,
    blank,
  };
}

describe.skipIf(!hasWasm)('WASM kernel parity with the TS reference', () => {
  it('abi version is current', () => {
    // fromBytes already throws on mismatch; this documents the expectation.
    expect(kernel).toBeTruthy();
  });

  it('voxelize matches exactly (pawn, cone, sphere)', () => {
    for (const mesh of [makePawn(), makeCone(1, 2, 40), applyMatrix4(makeSphere(1, 40), translation(0.2, 0, 0))]) {
      const { positions, blank } = placed(mesh);

      setKernel(null);
      const ts = voxelize({ positions }, blank, { approxCells: 48 });

      setKernel(kernel);
      const wasm = voxelize({ positions }, blank, { approxCells: 48 });

      expect(wasm.data.length).toBe(ts.data.length);
      let diff = 0;
      for (let i = 0; i < ts.data.length; i++) if (ts.data[i] !== wasm.data[i]) diff++;
      expect(diff).toBe(0);
      expect(countSolid(wasm)).toBeGreaterThan(50);
    }
  });

  it('voxelize matches for single-axis mode', () => {
    const { positions, blank } = placed();
    setKernel(null);
    const ts = voxelize({ positions }, blank, { approxCells: 40, axes: 1 });
    setKernel(kernel);
    const wasm = voxelize({ positions }, blank, { approxCells: 40, axes: 1 });
    let diff = 0;
    for (let i = 0; i < ts.data.length; i++) if (ts.data[i] !== wasm.data[i]) diff++;
    expect(diff).toBe(0);
  });

  it('distance transform agrees within 0.05 mm', () => {
    const { positions, blank } = placed();
    setKernel(null);
    const g = voxelize({ positions }, blank, { approxCells: 44 });
    const tsD = distanceToSolid(g);

    setKernel(kernel);
    const wasmD = distanceToSolid(g);

    let maxAbs = 0;
    for (let i = 0; i < tsD.length; i++) {
      if (!isFinite(tsD[i]) || !isFinite(wasmD[i])) {
        expect(isFinite(tsD[i])).toBe(isFinite(wasmD[i]));
        continue;
      }
      maxAbs = Math.max(maxAbs, Math.abs(tsD[i] - wasmD[i]));
    }
    expect(maxAbs).toBeLessThan(0.05);
  });

  it('dilate masks are identical at carving margins', () => {
    const { positions, blank } = placed();
    setKernel(null);
    const g = voxelize({ positions }, blank, { approxCells: 44 });
    for (const r of [1, 2, 5]) {
      setKernel(null);
      const ts = dilate(g, r);
      setKernel(kernel);
      const wasm = dilate(g, r);
      let diff = 0;
      for (let i = 0; i < ts.length; i++) if (ts[i] !== wasm[i]) diff++;
      // allow a handful of boundary voxels from f32-vs-f64 rounding
      expect(diff).toBeLessThanOrEqual(Math.ceil(ts.length * 0.001));
    }
  });
});
