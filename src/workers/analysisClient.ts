/**
 * Main-thread client for the geometry worker. `analyse` requests supersede each
 * other (the user is still dragging sliders); `prepare` runs once per model.
 */

import type { AnalysisResult, AnalysisOptions } from '../geometry/analysis';
import type { Blank } from '../geometry/blank';
import type { NormalizeOptions, NormalizeReport } from '../geometry/normalize';
import type { Box3 } from '../geometry/mesh';
import type { WorkerRequest, WorkerResponse } from './analysis.worker';
import { analyse } from '../geometry/analysis';
import { normalizeMesh } from '../geometry/normalize';

export interface PreparedMesh {
  positions: Float32Array;
  matrix: number[];
  bounds: Box3;
  report: NormalizeReport;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; kind: 'analyse' | 'prepare' };

export class AnalysisClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private latestAnalyse = 0;

  constructor() {
    try {
      this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (!msg.ok) {
          entry.reject(new Error(msg.error));
          return;
        }
        if (msg.kind === 'analyse') {
          if (msg.id < this.latestAnalyse) return; // superseded
          entry.resolve(msg.result);
        } else {
          entry.resolve({
            positions: new Float32Array(msg.positions),
            matrix: msg.matrix,
            bounds: msg.bounds,
            report: msg.report,
          } satisfies PreparedMesh);
        }
      };
      this.worker.onerror = (e) => {
        for (const [, entry] of this.pending) entry.reject(new Error(e.message || 'worker error'));
        this.pending.clear();
      };
    } catch {
      this.worker = null;
    }
  }

  async prepare(rawPositions: Float32Array, options?: NormalizeOptions): Promise<PreparedMesh> {
    if (!this.worker) {
      const n = normalizeMesh({ positions: rawPositions }, options);
      return { positions: n.mesh.positions, matrix: n.matrix, bounds: n.bounds, report: n.report };
    }
    const id = this.nextId++;
    const copy = rawPositions.slice();
    const req: PrepareRequestLike = { id, kind: 'prepare', positions: copy.buffer, options };
    return new Promise<PreparedMesh>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, kind: 'prepare' });
      this.worker!.postMessage(req as WorkerRequest, [copy.buffer]);
    });
  }

  async run(positions: Float32Array, blank: Blank, options?: AnalysisOptions): Promise<AnalysisResult> {
    const id = this.nextId++;
    this.latestAnalyse = id;
    if (!this.worker) {
      return analyse({ positions }, blank, options);
    }
    const copy = positions.slice();
    const req: AnalyseRequestLike = { id, kind: 'analyse', positions: copy.buffer, blank, options };
    return new Promise<AnalysisResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, kind: 'analyse' });
      this.worker!.postMessage(req as WorkerRequest, [copy.buffer]);
    });
  }

  dispose() {
    this.worker?.terminate();
  }
}

interface AnalyseRequestLike {
  id: number;
  kind: 'analyse';
  positions: ArrayBuffer;
  blank: Blank;
  options?: AnalysisOptions;
}
interface PrepareRequestLike {
  id: number;
  kind: 'prepare';
  positions: ArrayBuffer;
  options?: NormalizeOptions;
}
