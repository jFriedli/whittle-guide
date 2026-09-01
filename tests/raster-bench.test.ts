import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GeometryKernel } from '../src/geometry/wasm/kernel';
import { setKernel } from '../src/geometry/wasm';
import { makeSphere, applyMatrix4, translation } from '../src/geometry/mesh';
import { normalizeMesh } from '../src/geometry/normalize';
import { autoFit, defaultBlank, placementMatrix } from '../src/geometry/blank';
import { silhouette } from '../src/geometry/silhouette';
import { depthField, FACE_DEPTH_VIEWS } from '../src/geometry/depthField';
import { ALL_VIEWS } from '../src/geometry/projection';
import { analyse } from '../src/geometry/analysis';

const WASM = resolve(__dirname, '../src/geometry/wasm/kernel.wasm');
const hasWasm = existsSync(WASM);

describe.skipIf(!hasWasm || !process.env.BENCH)('raster kernel speed-up (set BENCH=1)', () => {
  it('WASM raster is faster than the TS loop on a dense mesh', async () => {
    const kernel = await GeometryKernel.fromBytes(readFileSync(WASM));
    const n = normalizeMesh(makeSphere(1, 160), { targetSize: 100 });
    const blank = defaultBlank();
    const fit = autoFit(n.bounds, blank, [0, 0, 0], 4);
    const positions = applyMatrix4(n.mesh, placementMatrix(fit.placement, n.bounds)).positions;
    void translation;
    const tris = positions.length / 9;

    const runAll = () => {
      for (const v of ALL_VIEWS) silhouette({ positions }, blank, v, { resolution: 420 });
      for (const v of FACE_DEPTH_VIEWS) depthField({ positions }, blank, v, { resolution: 300 });
    };

    setKernel(null); runAll();
    const t0 = performance.now(); for (let i = 0; i < 5; i++) runAll(); const ts = performance.now() - t0;

    setKernel(kernel); runAll();
    const t1 = performance.now(); for (let i = 0; i < 5; i++) runAll(); const wasm = performance.now() - t1;
    setKernel(null);

    // eslint-disable-next-line no-console
    console.log(`raster (${tris} tris, 5×): TS ${ts.toFixed(0)}ms  WASM ${wasm.toFixed(0)}ms  (${(ts / wasm).toFixed(1)}×)`);
    expect(wasm).toBeLessThan(ts);

    const full = () => analyse({ positions }, blank, { approxCells: 84 });
    setKernel(null); full();
    const f0 = performance.now(); for (let i = 0; i < 3; i++) full(); const fts = performance.now() - f0;
    setKernel(kernel); full();
    const f1 = performance.now(); for (let i = 0; i < 3; i++) full(); const fwasm = performance.now() - f1;
    setKernel(null);
    // eslint-disable-next-line no-console
    console.log(`full analyse (3×): TS ${fts.toFixed(0)}ms  WASM ${fwasm.toFixed(0)}ms  (${(fts / fwasm).toFixed(1)}×)`);
  });
});
