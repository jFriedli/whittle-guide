import { describe, it, expect } from 'vitest';
import { buildSurfaceNetsGeometry } from '../src/viewer/surfaceNets';
import type { VoxelDims } from '../src/viewer/voxelMesh';

function bbox(geom: { getAttribute(name: string): { array: ArrayLike<number>; count: number } }) {
  const p = geom.getAttribute('position');
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = p.array[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], count: p.count };
}

const dims = (nx: number, ny: number, nz: number): VoxelDims => ({
  nx, ny, nz,
  d: [1, 1, 1],
  origin: [-nx / 2, -ny / 2, -nz / 2],
});

describe('surface nets rendering fixes', () => {
  it('a volume that fills the whole grid is closed on all six sides (bug 1)', () => {
    const nx = 12, ny = 20, nz = 12;
    const data = new Uint8Array(nx * ny * nz).fill(1); // fills to every boundary
    const g = bbox(buildSurfaceNetsGeometry(data, dims(nx, ny, nz)));
    // full extent present on every axis (~nx, ny, nz), not a couple of interior planes
    expect(g.size[0]).toBeGreaterThan(nx - 2);
    expect(g.size[1]).toBeGreaterThan(ny - 2);
    expect(g.size[2]).toBeGreaterThan(nz - 2);
    expect(g.count).toBeGreaterThan(50);
  });

  it('a one-voxel-thick slab does not vanish (bug 2)', () => {
    const nx = 20, ny = 3, nz = 20;
    const data = new Uint8Array(nx * ny * nz);
    for (let z = 2; z < nz - 2; z++) for (let x = 2; x < nx - 2; x++) data[x + nx * (1 + ny * z)] = 1; // y = 1 only
    const g = bbox(buildSurfaceNetsGeometry(data, dims(nx, ny, nz), { blurPasses: 1 }));
    expect(g.count).toBeGreaterThan(20);
    expect(g.size[0]).toBeGreaterThan(10);
    expect(g.size[2]).toBeGreaterThan(10);
  });

  it('does not shrink a final-model-sized blob (bug 3)', () => {
    // solid 14×14×14 block centred in a 24³ grid, empty all around
    const n = 24;
    const data = new Uint8Array(n * n * n);
    let vminX = 99, vmaxX = -1;
    for (let z = 5; z < 19; z++)
      for (let y = 5; y < 19; y++)
        for (let x = 5; x < 19; x++) {
          data[x + n * (y + n * z)] = 1;
          if (x < vminX) vminX = x;
          if (x > vmaxX) vmaxX = x;
        }
    const g = bbox(buildSurfaceNetsGeometry(data, dims(n, n, n), { blurPasses: 0, smoothIterations: 3, isoLevel: 0.42 }));
    // voxel solid spans ~14 units; the mesh must be within ~1.5 units of that, not visibly smaller
    for (let a = 0; a < 3; a++) {
      expect(g.size[a]).toBeGreaterThan(12.5);
      expect(g.size[a]).toBeLessThan(16);
    }
  });

  it('falls back to the cube mesher when Surface Nets would be degenerate', () => {
    // 2×2×2 solid — tiny, but still must produce a visible closed mesh
    const n = 8;
    const data = new Uint8Array(n * n * n);
    for (let z = 3; z < 5; z++) for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) data[x + n * (y + n * z)] = 1;
    const g = bbox(buildSurfaceNetsGeometry(data, dims(n, n, n)));
    expect(g.count).toBeGreaterThan(0);
    expect(g.size[0]).toBeGreaterThan(1);
  });
});
