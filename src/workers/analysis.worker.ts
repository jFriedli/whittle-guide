/// <reference lib="webworker" />
/**
 * Runs the CPU-heavy geometry analysis off the main thread.
 * Input: a placed triangle soup (already in blank space) + blank + options.
 * Output: the full AnalysisResult (typed arrays transferred back).
 */

import { analyse, AnalysisOptions, AnalysisResult } from '../geometry/analysis';
import { Blank } from '../geometry/blank';
import { initKernel } from '../geometry/wasm';

// Load the WASM kernel once; analysis falls back to pure TS until it resolves.
const kernelReady = initKernel().catch(() => false);

export interface AnalysisRequest {
  id: number;
  positions: ArrayBuffer;
  blank: Blank;
  options?: AnalysisOptions;
}

export type AnalysisResponse =
  | { id: number; ok: true; result: AnalysisResult }
  | { id: number; ok: false; error: string };

self.onmessage = async (ev: MessageEvent<AnalysisRequest>) => {
  const { id, positions, blank, options } = ev.data;
  try {
    await kernelReady;
    const mesh = { positions: new Float32Array(positions) };
    const result = analyse(mesh, blank, options);

    const transfer: Transferable[] = [];
    for (const p of result.projections) transfer.push(p.mask.buffer);
    for (const d of result.depthMaps) transfer.push(d.depth.buffer);
    for (const s of result.stages) transfer.push(s.data.buffer);

    (self as unknown as Worker).postMessage({ id, ok: true, result } satisfies AnalysisResponse, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: (e as Error).message + '\n' + ((e as Error).stack ?? ''),
    } satisfies AnalysisResponse);
  }
};
