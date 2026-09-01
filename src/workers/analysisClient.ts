/**
 * Main-thread client for the geometry worker.
 *
 * `run()` is progressive: given an `onPartial` hook it fires a fast low-resolution
 * pass first (surfaced immediately) and then the full-resolution pass, which the
 * promise resolves with. Overlapping `run()` calls supersede each other — an
 * older call's promise rejects with a `SupersededError` and its `onPartial`
 * stops firing. `prepare` runs once per model.
 */

import type { AnalysisResult, AnalysisOptions } from '../geometry/analysis';
import type { Blank } from '../geometry/blank';
import type { NormalizeOptions, NormalizeReport } from '../geometry/normalize';
import type { Box3 } from '../geometry/mesh';
import type { WorkerRequest, WorkerResponse } from './analysis.worker';
import { analyse } from '../geometry/analysis';
import { normalizeMesh } from '../geometry/normalize';
import { findBestOrientation, type BestOrientationResult } from '../geometry/bestOrientation';
import { AnalysisCache, analysisKey } from './analysisCache';

export interface PreparedMesh {
  positions: Float32Array;
  matrix: number[];
  bounds: Box3;
  report: NormalizeReport;
}

/** Thrown by `run()` when a newer `run()` has started before this one finished. */
export class SupersededError extends Error {
  readonly superseded = true;
  constructor() {
    super('analysis superseded');
    this.name = 'SupersededError';
  }
}

export interface RunHooks {
  /** Called with a fast, low-resolution result while the full pass is still running. */
  onPartial?: (result: AnalysisResult) => void;
}

/** Low-resolution variant of the options for the quick first pass. */
export function coarseOptions(o?: AnalysisOptions): AnalysisOptions {
  return {
    ...o,
    approxCells: Math.min(o?.approxCells ?? 64, 44),
    silhouetteResolution: 150,
    depthResolution: 120,
  };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; kind: 'analyse' | 'prepare' };

export class AnalysisClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private currentGen = 0;
  private cache = new AnalysisCache();

  constructor(worker?: Worker | null) {
    if (worker !== undefined) {
      this.worker = worker;
    } else {
      try {
        this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        this.worker = null;
      }
    }
    if (this.worker) {
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (!msg.ok) {
          entry.reject(new Error(msg.error));
          return;
        }
        if (msg.kind === 'bestOrient') {
          entry.resolve(msg.result);
        } else if (msg.kind === 'analyse') {
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

  async bestOrientation(positions: Float32Array, blank: Blank): Promise<BestOrientationResult> {
    if (!this.worker) return findBestOrientation({ positions }, blank);
    const id = this.nextId++;
    const copy = positions.slice();
    const req: BestOrientRequestLike = { id, kind: 'bestOrient', positions: copy.buffer, blank };
    return new Promise<BestOrientationResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, kind: 'analyse' });
      this.worker!.postMessage(req as WorkerRequest, [copy.buffer]);
    });
  }

  async run(
    positions: Float32Array,
    blank: Blank,
    options?: AnalysisOptions,
    hooks?: RunHooks,
  ): Promise<AnalysisResult> {
    const gen = ++this.currentGen;

    // Quick coarse pass — only worth a second worker round-trip when the full
    // pass is meaningfully heavier and someone is listening.
    if (hooks?.onPartial && this.worker && (options?.approxCells ?? 64) > 52) {
      this.analyseOnce(positions, blank, coarseOptions(options))
        .then((r) => {
          if (gen === this.currentGen) hooks.onPartial!(r);
        })
        .catch(() => {
          /* a coarse-pass failure is non-fatal; the full pass still runs */
        });
    }

    const fine = await this.analyseOnce(positions, blank, options);
    if (gen !== this.currentGen) throw new SupersededError();
    return fine;
  }

  /** One analysis request (cache-checked), resolving whenever the worker replies. */
  private analyseOnce(positions: Float32Array, blank: Blank, options?: AnalysisOptions): Promise<AnalysisResult> {
    const key = analysisKey(positions, blank, options);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);

    if (!this.worker) {
      const result = analyse({ positions }, blank, options);
      this.cache.set(key, result);
      return Promise.resolve(result);
    }
    const id = this.nextId++;
    const copy = positions.slice();
    const req: AnalyseRequestLike = { id, kind: 'analyse', positions: copy.buffer, blank, options };
    return new Promise<AnalysisResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: ((v: unknown) => {
          this.cache.set(key, v as AnalysisResult);
          resolve(v as AnalysisResult);
        }) as (v: unknown) => void,
        reject,
        kind: 'analyse',
      });
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
interface BestOrientRequestLike {
  id: number;
  kind: 'bestOrient';
  positions: ArrayBuffer;
  blank: Blank;
}
interface PrepareRequestLike {
  id: number;
  kind: 'prepare';
  positions: ArrayBuffer;
  options?: NormalizeOptions;
}
