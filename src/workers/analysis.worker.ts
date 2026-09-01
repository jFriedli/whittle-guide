/// <reference lib="webworker" />
/**
 * Runs the CPU-heavy geometry work off the main thread:
 *  - `prepare`: mesh cleanup, quadric decimation, normalisation (once per model)
 *  - `analyse`: the full analysis pipeline (on every blank / placement change)
 */

import { analyse, AnalysisOptions, AnalysisResult } from '../geometry/analysis';
import { Blank } from '../geometry/blank';
import { normalizeMesh, NormalizeOptions, NormalizeReport } from '../geometry/normalize';
import { Box3 } from '../geometry/mesh';
import { initKernel } from '../geometry/wasm';

// Load the WASM kernel once; work falls back to pure TS until it resolves.
const kernelReady = initKernel().catch(() => false);

export interface AnalyseRequest {
  id: number;
  kind: 'analyse';
  positions: ArrayBuffer;
  blank: Blank;
  options?: AnalysisOptions;
}

export interface PrepareRequest {
  id: number;
  kind: 'prepare';
  positions: ArrayBuffer;
  options?: NormalizeOptions;
}

export type WorkerRequest = AnalyseRequest | PrepareRequest;

export type WorkerResponse =
  | { id: number; ok: true; kind: 'analyse'; result: AnalysisResult }
  | { id: number; ok: true; kind: 'prepare'; positions: ArrayBuffer; matrix: number[]; bounds: Box3; report: NormalizeReport }
  | { id: number; ok: false; error: string };

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    await kernelReady;

    if (req.kind === 'prepare') {
      const norm = normalizeMesh({ positions: new Float32Array(req.positions) }, req.options);
      const buf = norm.mesh.positions.buffer as ArrayBuffer;
      post(
        { id: req.id, ok: true, kind: 'prepare', positions: buf, matrix: norm.matrix, bounds: norm.bounds, report: norm.report },
        [buf],
      );
      return;
    }

    const result = analyse({ positions: new Float32Array(req.positions) }, req.blank, req.options);
    const transfer: Transferable[] = [];
    for (const p of result.projections) transfer.push(p.mask.buffer);
    for (const d of result.depthMaps) transfer.push(d.depth.buffer);
    for (const s of result.stages) transfer.push(s.data.buffer);
    transfer.push(result.undercuts.mask.buffer);
    transfer.push(result.fragility.mask.buffer);
    post({ id: req.id, ok: true, kind: 'analyse', result }, transfer);
  } catch (e) {
    post({ id: req.id, ok: false, error: (e as Error).message + '\n' + ((e as Error).stack ?? '') });
  }
};
