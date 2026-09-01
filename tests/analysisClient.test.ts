import { describe, it, expect } from 'vitest';
import { AnalysisClient, SupersededError, coarseOptions } from '../src/workers/analysisClient';
import type { AnalysisResult } from '../src/geometry/analysis';
import type { Blank } from '../src/geometry/blank';

const blank: Blank = { width: 40, height: 100, depth: 40 };
const positions = () => Float32Array.from({ length: 90 }, (_, i) => Math.sin(i) * 10);

interface SentReq {
  id: number;
  kind: string;
  options?: { approxCells?: number; silhouetteResolution?: number };
}

/** Minimal stand-in for the geometry Web Worker: records requests, replies on demand. */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: SentReq[] = [];
  postMessage(msg: SentReq) {
    this.sent.push(msg);
  }
  terminate() {}
  reply(id: number, tag: string) {
    this.onmessage?.({ data: { id, ok: true, kind: 'analyse', result: fakeResult(tag) } });
  }
}

function fakeResult(tag: string): AnalysisResult {
  return { engine: 'js', triangles: 0, stages: [{ index: 0 }, { index: 1 }], _tag: tag } as unknown as AnalysisResult;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('coarseOptions', () => {
  it('lowers the grid and raster resolution but keeps semantic options', () => {
    const c = coarseOptions({ approxCells: 84, grainAxis: 2, stageCount: 6, symmetryAxis: 0 });
    expect(c.approxCells).toBe(44);
    expect(c.silhouetteResolution).toBe(150);
    expect(c.depthResolution).toBe(120);
    expect(c.grainAxis).toBe(2);
    expect(c.stageCount).toBe(6);
    expect(c.symmetryAxis).toBe(0);
  });
});

describe('AnalysisClient progressive run', () => {
  it('fires a coarse pass then the full pass and resolves with the full one', async () => {
    const w = new FakeWorker();
    const client = new AnalysisClient(w as unknown as Worker);
    const partials: string[] = [];

    const p = client.run(positions(), blank, { approxCells: 84 }, {
      onPartial: (r) => partials.push((r as unknown as { _tag: string })._tag),
    });
    await flush();

    expect(w.sent).toHaveLength(2);
    const [coarse, fine] = w.sent;
    expect(coarse.options?.approxCells).toBe(44);
    expect(fine.options?.approxCells).toBe(84);

    w.reply(coarse.id, 'coarse');
    await flush();
    expect(partials).toEqual(['coarse']);

    w.reply(fine.id, 'fine');
    const result = await p;
    expect((result as unknown as { _tag: string })._tag).toBe('fine');
  });

  it('skips the coarse pass for an already-cheap analysis', async () => {
    const w = new FakeWorker();
    const client = new AnalysisClient(w as unknown as Worker);
    const partials: string[] = [];
    const p = client.run(positions(), blank, { approxCells: 40 }, { onPartial: () => partials.push('x') });
    await flush();
    expect(w.sent).toHaveLength(1);
    w.reply(w.sent[0].id, 'only');
    await p;
    expect(partials).toEqual([]);
  });

  it('supersedes an in-flight run: older promise rejects, its onPartial goes quiet', async () => {
    const w = new FakeWorker();
    const client = new AnalysisClient(w as unknown as Worker);
    const aPartials: string[] = [];

    const a = client.run(positions(), blank, { approxCells: 84 }, { onPartial: () => aPartials.push('a') });
    await flush();
    const aCoarse = w.sent[0].id;
    const aFine = w.sent[1].id;

    // a newer run starts before `a` finishes
    const b = client.run(Float32Array.from({ length: 90 }, (_, i) => i), blank, { approxCells: 84 });
    await flush();
    const bFine = w.sent[w.sent.length - 1].id;

    w.reply(aCoarse, 'a-coarse'); // must NOT reach a.onPartial anymore
    w.reply(aFine, 'a-fine');
    await expect(a).rejects.toBeInstanceOf(SupersededError);
    expect(aPartials).toEqual([]);

    w.reply(bFine, 'b-fine');
    expect((await b as unknown as { _tag: string })._tag).toBe('b-fine');
  });

  it('falls back to a synchronous single pass with no worker', async () => {
    const client = new AnalysisClient(null);
    let partialCalls = 0;
    // real analyse() runs here; a tiny degenerate mesh is fine, we only check the shape
    const res = await client.run(positions(), blank, { approxCells: 16 }, { onPartial: () => partialCalls++ });
    expect(res).toBeTruthy();
    expect(res.stages.length).toBeGreaterThan(0);
    expect(partialCalls).toBe(0);
  });
});
