/**
 * Experimental rough straight-cut suggestions.
 *
 * Looks for axis-aligned planar slabs that can be sawn off one face of the blank
 * without touching the final model plus its safety margin. Deliberately
 * conservative: a suggested cut never intersects the protected region.
 */

import { VoxelGrid, voxelVolume } from './voxelize';
import { dilate } from './distance';

export type CutSide = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface RoughCut {
  side: CutSide;
  /** Offset of the cut plane from that face, mm (how deep the slab is). */
  depthMm: number;
  approxVolumeCm3: number;
  note: string;
}

const SIDES: { side: CutSide; axis: 0 | 1 | 2; fromMax: boolean; faceMm: (g: VoxelGrid) => number }[] = [
  { side: 'left', axis: 0, fromMax: false, faceMm: (g) => g.blank.width },
  { side: 'right', axis: 0, fromMax: true, faceMm: (g) => g.blank.width },
  { side: 'bottom', axis: 1, fromMax: false, faceMm: (g) => g.blank.height },
  { side: 'top', axis: 1, fromMax: true, faceMm: (g) => g.blank.height },
  { side: 'front', axis: 2, fromMax: true, faceMm: (g) => g.blank.depth },
  { side: 'back', axis: 2, fromMax: false, faceMm: (g) => g.blank.depth },
];

export function suggestRoughCuts(finalGrid: VoxelGrid, safetyMm: number): RoughCut[] {
  const protectedMask = dilate(finalGrid, safetyMm);
  const { nx, ny, nz } = finalGrid;
  const n: [number, number, number] = [nx, ny, nz];
  const at = (i: number, j: number, k: number) => protectedMask[i + nx * (j + ny * k)];
  const cuts: RoughCut[] = [];

  for (const s of SIDES) {
    const nAlong = n[s.axis];
    // Find how many full slices from this face are entirely outside the protected mask.
    let free = 0;
    for (let step = 0; step < nAlong; step++) {
      const slice = s.fromMax ? nAlong - 1 - step : step;
      let clear = true;
      outer: for (let a = 0; a < n[(s.axis + 1) % 3]; a++) {
        for (let b = 0; b < n[(s.axis + 2) % 3]; b++) {
          const idx: [number, number, number] = [0, 0, 0];
          idx[s.axis] = slice;
          idx[(s.axis + 1) % 3] = a;
          idx[(s.axis + 2) % 3] = b;
          if (at(idx[0], idx[1], idx[2])) { clear = false; break outer; }
        }
      }
      if (!clear) break;
      free++;
    }
    if (free < 1) continue;
    const cell = finalGrid.d[s.axis];
    const depthMm = free * cell;
    const sliceVox = (finalGrid.data.length / nAlong) * free;
    const approxVolumeCm3 = (sliceVox * voxelVolume(finalGrid)) / 1000;
    if (depthMm < Math.max(2, cell * 1.5)) continue;
    cuts.push({
      side: s.side,
      depthMm: Math.round(depthMm * 10) / 10,
      approxVolumeCm3: Math.round(approxVolumeCm3 * 10) / 10,
      note: `Saw a ${depthMm.toFixed(1)} mm slab off the ${s.side} face. Stays at least ${safetyMm} mm clear of the figure.`,
    });
  }
  return cuts.sort((a, b) => b.approxVolumeCm3 - a.approxVolumeCm3);
}
