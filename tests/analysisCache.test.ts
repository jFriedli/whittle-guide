import { describe, it, expect } from 'vitest';
import { AnalysisCache, analysisKey, hashPositions } from '../src/workers/analysisCache';
import type { AnalysisResult } from '../src/geometry/analysis';
import type { Blank } from '../src/geometry/blank';

const blank: Blank = { width: 40, height: 100, depth: 40 };

function fakeResult(tag: number): AnalysisResult {
  // Only the fields the cache touches (structuredClone) need to be real-ish.
  return { triangles: tag, undercuts: { mask: new Uint8Array([tag]), fraction: 0 } } as unknown as AnalysisResult;
}

describe('analysis cache', () => {
  it('same geometry + blank + options hits the cache and returns a copy', () => {
    const c = new AnalysisCache();
    const p = Float32Array.from({ length: 90 }, (_, i) => i * 0.5);
    const key = analysisKey(p, blank, { approxCells: 64 });
    c.set(key, fakeResult(7));

    const a = c.get(key)!;
    const b = c.get(key)!;
    expect(a.triangles).toBe(7);
    expect(a).not.toBe(b); // distinct clones
    a.undercuts.mask[0] = 99;
    expect(c.get(key)!.undercuts.mask[0]).toBe(7); // stored copy untouched
  });

  it('different options or blank produce different keys', () => {
    const p = Float32Array.from({ length: 60 }, (_, i) => i);
    expect(analysisKey(p, blank, { approxCells: 64 })).not.toBe(analysisKey(p, blank, { approxCells: 84 }));
    expect(analysisKey(p, blank)).not.toBe(analysisKey(p, { ...blank, width: 41 }));
  });

  it('a changed vertex changes the hash', () => {
    const p = Float32Array.from({ length: 300 }, (_, i) => Math.sin(i));
    const q = p.slice();
    q[299] += 1;
    expect(hashPositions(p)).not.toBe(hashPositions(q));
  });

  it('evicts least-recently-used beyond the limit', () => {
    const c = new AnalysisCache(2);
    const mk = (n: number) => analysisKey(Float32Array.of(n, n, n), blank);
    c.set(mk(1), fakeResult(1));
    c.set(mk(2), fakeResult(2));
    c.get(mk(1)); // touch 1 so 2 is now LRU
    c.set(mk(3), fakeResult(3));
    expect(c.get(mk(2))).toBeUndefined();
    expect(c.get(mk(1))?.triangles).toBe(1);
    expect(c.get(mk(3))?.triangles).toBe(3);
  });
});
