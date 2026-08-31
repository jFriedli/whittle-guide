/**
 * Main-thread client for the analysis worker, with a simple request queue so a
 * new request supersedes an in-flight one (the user is still adjusting sliders).
 */

import type { AnalysisResult, AnalysisOptions } from '../geometry/analysis';
import type { Blank } from '../geometry/blank';
import type { AnalysisRequest, AnalysisResponse } from './analysis.worker';
import { analyse } from '../geometry/analysis';

export class AnalysisClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: AnalysisResult) => void; reject: (e: Error) => void }>();
  private latest = 0;

  constructor() {
    try {
      this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<AnalysisResponse>) => {
        const msg = ev.data;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.id < this.latest) return; // superseded
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error));
      };
      this.worker.onerror = (e) => {
        for (const [, entry] of this.pending) entry.reject(new Error(e.message || 'worker error'));
        this.pending.clear();
      };
    } catch {
      this.worker = null; // fall back to synchronous analysis
    }
  }

  async run(positions: Float32Array, blank: Blank, options?: AnalysisOptions): Promise<AnalysisResult> {
    const id = this.nextId++;
    this.latest = id;

    if (!this.worker) {
      // Synchronous fallback (also used in non-worker environments / tests).
      return analyse({ positions }, blank, options);
    }

    const copy = positions.slice();
    const req: AnalysisRequest = { id, positions: copy.buffer, blank, options };
    return new Promise<AnalysisResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage(req, [copy.buffer]);
    });
  }

  dispose() {
    this.worker?.terminate();
  }
}
