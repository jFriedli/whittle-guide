import { describe, it, expect } from 'vitest';
import { makeBox, makeCylinder, makeSphere, applyMatrix4, translation } from '../src/geometry/mesh';
import { silhouette, simplifyPolyline } from '../src/geometry/silhouette';

const blank = { width: 60, height: 80, depth: 40 };

describe('vector silhouette', () => {
  it('front outline of a centred box matches its projected size', () => {
    const sil = silhouette(makeBox(30, 40, 20), blank, 'front', { resolution: 400 });
    const xs = sil.polylines.flat().map((p) => p[0]);
    const ys = sil.polylines.flat().map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(w).toBeGreaterThan(29);
    expect(w).toBeLessThan(31);
    expect(h).toBeGreaterThan(39);
    expect(h).toBeLessThan(41);
    // A rectangle simplifies to ~4-6 vertices per loop.
    expect(sil.polylines[0].length).toBeLessThanOrEqual(8);
  });

  it('coverage of a box ≈ area fraction', () => {
    const sil = silhouette(makeBox(30, 40, 20), blank, 'front', { resolution: 400 });
    const expected = (30 * 40) / (blank.width * blank.height);
    expect(sil.coverage).toBeGreaterThan(expected * 0.95);
    expect(sil.coverage).toBeLessThan(expected * 1.05);
  });

  it('circle silhouette is smooth and near-round', () => {
    const sil = silhouette(makeSphere(18, 48), blank, 'front', { resolution: 500 });
    const loop = sil.polylines.sort((a, b) => b.length - a.length)[0];
    // perimeter^2 / (4 pi area) ~ 1 for a circle
    let perim = 0;
    for (let i = 1; i < loop.length; i++) perim += Math.hypot(loop[i][0] - loop[i - 1][0], loop[i][1] - loop[i - 1][1]);
    const r = 18;
    expect(perim).toBeGreaterThan(2 * Math.PI * r * 0.9);
    expect(perim).toBeLessThan(2 * Math.PI * r * 1.12);
    expect(loop.length).toBeGreaterThan(12); // many segments, not a polygon
  });

  it('is resolution-independent in extent (coarse vs fine agree)', () => {
    const mesh = makeCylinder(15, 50, 40);
    const coarse = silhouette(mesh, blank, 'left', { resolution: 120 });
    const fine = silhouette(mesh, blank, 'left', { resolution: 600 });
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(coarse.extentMm[i] - fine.extentMm[i])).toBeLessThan(2);
    }
  });

  it('top view uses width × depth', () => {
    const sil = silhouette(applyMatrix4(makeBox(20, 10, 30), translation(0, 0, 0)), blank, 'top');
    expect(sil.widthMm).toBe(blank.width);
    expect(sil.heightMm).toBe(blank.depth);
  });
});

describe('simplifyPolyline', () => {
  it('drops collinear points', () => {
    const line: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 3]];
    const out = simplifyPolyline(line, 0.01);
    expect(out.length).toBe(3);
  });
  it('keeps closed loops closed', () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const out = simplifyPolyline(sq, 0.1);
    expect(out[0]).toEqual(out[out.length - 1]);
  });
});
