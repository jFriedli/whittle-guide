import { describe, it, expect } from 'vitest';
import { makeBox, makeSphere } from '../src/geometry/mesh';
import { voxelize } from '../src/geometry/voxelize';
import { analyseCarvability } from '../src/geometry/carvability';

describe('carvability — hollowing suggestion', () => {
  it('suggests hollowing a large chunky solid with a thick core', () => {
    // 60mm solid cube in a 70mm blank: the centre sits ~30mm from every face.
    const g = voxelize(makeBox(60, 60, 60), { width: 70, height: 70, depth: 70 }, { approxCells: 48 });
    const report = analyseCarvability(g);
    expect(report.notes.join(' ')).toMatch(/hollow/i);
  });

  it('does not suggest hollowing a small thin piece', () => {
    const g = voxelize(makeSphere(1, 32), { width: 30, height: 30, depth: 30 }, { approxCells: 40 });
    const report = analyseCarvability(g);
    expect(report.notes.join(' ')).not.toMatch(/hollow/i);
  });
});
