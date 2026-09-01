/**
 * Small LRU cache for analysis results. The pipeline is deterministic in
 * (placed geometry, blank, options), so re-running it while the user flips
 * between tabs or toggles a view is pure waste. Keyed by a fast content hash
 * of the positions plus the JSON of the blank and options.
 */

import type { AnalysisResult, AnalysisOptions } from '../geometry/analysis';
import type { Blank } from '../geometry/blank';

/** FNV-1a over a strided sample of the buffer — collision-safe enough for a cache. */
export function hashPositions(p: Float32Array): string {
  let h = 0x811c9dc5;
  const n = p.length;
  // Sample ~4096 floats evenly; always include the tail so small edits at the
  // end still change the key.
  const stride = Math.max(1, Math.floor(n / 4096));
  const u = new Uint32Array(p.buffer, p.byteOffset, n);
  for (let i = 0; i < n; i += stride) {
    h ^= u[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= n;
  h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(36) + ':' + n.toString(36);
}

export function analysisKey(positions: Float32Array, blank: Blank, options?: AnalysisOptions): string {
  return hashPositions(positions) + '|' + JSON.stringify(blank) + '|' + JSON.stringify(options ?? {});
}

export class AnalysisCache {
  private map = new Map<string, AnalysisResult>();

  constructor(private limit = 4) {}

  get(key: string): AnalysisResult | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return clone(hit);
  }

  set(key: string, value: AnalysisResult): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, clone(value));
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

/** Deep copy so a cached result can never be mutated (or its buffers transferred). */
function clone(r: AnalysisResult): AnalysisResult {
  return structuredClone(r);
}
