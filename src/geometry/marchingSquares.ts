/**
 * Marching squares: extract iso-contours from a scalar field on a regular grid.
 * Used both for silhouette outlines (threshold on an occupancy mask) and for
 * depth contour maps (threshold at each carving depth).
 */

export interface Grid2D {
  cols: number;
  rows: number;
  /** Row-major, length cols*rows. */
  values: Float32Array;
  /** Value treated as "outside" / missing. */
  nodata?: number;
}

export type Segment = [number, number, number, number]; // x0,y0,x1,y1 in grid units

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Return iso-line segments at `level`, in grid coordinates where cell centres are
 * at integer positions (0..cols-1, 0..rows-1). NaN / nodata samples are treated
 * as far below `level`.
 */
export function isoSegments(grid: Grid2D, level: number): Segment[] {
  const { cols, rows, values } = grid;
  const nd = grid.nodata ?? NaN;
  const at = (x: number, y: number): number => {
    const v = values[y * cols + x];
    if (Number.isNaN(v) || v === nd) return level - 1e6;
    return v;
  };
  const segs: Segment[] = [];
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      let idx = 0;
      if (tl >= level) idx |= 1;
      if (tr >= level) idx |= 2;
      if (br >= level) idx |= 4;
      if (bl >= level) idx |= 8;
      if (idx === 0 || idx === 15) continue;

      // Edge crossing points (relative to cell origin x,y).
      const top = (): [number, number] => [x + edgeT(tl, tr, level), y];
      const bottom = (): [number, number] => [x + edgeT(bl, br, level), y + 1];
      const left = (): [number, number] => [x, y + edgeT(tl, bl, level)];
      const right = (): [number, number] => [x + 1, y + edgeT(tr, br, level)];

      const add = (a: [number, number], b: [number, number]) =>
        segs.push([a[0], a[1], b[0], b[1]]);

      switch (idx) {
        case 1: case 14: add(left(), top()); break;
        case 2: case 13: add(top(), right()); break;
        case 3: case 12: add(left(), right()); break;
        case 4: case 11: add(right(), bottom()); break;
        case 5: add(left(), top()); add(right(), bottom()); break;
        case 6: case 9: add(top(), bottom()); break;
        case 7: case 8: add(left(), bottom()); break;
        case 10: add(top(), right()); add(left(), bottom()); break;
      }
    }
  }
  return segs;
}

function edgeT(a: number, b: number, level: number): number {
  const denom = b - a;
  if (Math.abs(denom) < 1e-9) return 0.5;
  const t = (level - a) / denom;
  return Math.min(1, Math.max(0, t));
}

/** Stitch unordered segments into polylines by matching endpoints. */
export function stitch(segs: Segment[], epsilon = 1e-4): number[][][] {
  const key = (x: number, y: number) =>
    `${Math.round(x / epsilon)},${Math.round(y / epsilon)}`;
  const remaining = segs.map((s) => s.slice() as Segment);
  const byPoint = new Map<string, number[]>();
  const register = (k: string, i: number) => {
    const list = byPoint.get(k);
    if (list) list.push(i);
    else byPoint.set(k, [i]);
  };
  remaining.forEach((s, i) => {
    register(key(s[0], s[1]), i);
    register(key(s[2], s[3]), i);
  });
  const used = new Set<number>();
  const polylines: number[][][] = [];

  for (let i = 0; i < remaining.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const s = remaining[i];
    const line: number[][] = [[s[0], s[1]], [s[2], s[3]]];

    // Extend forward.
    let grow = true;
    while (grow) {
      grow = false;
      const tail = line[line.length - 1];
      const cand = byPoint.get(key(tail[0], tail[1])) || [];
      for (const j of cand) {
        if (used.has(j)) continue;
        const t = remaining[j];
        if (near(t[0], t[1], tail[0], tail[1], epsilon)) {
          line.push([t[2], t[3]]);
          used.add(j);
          grow = true;
          break;
        }
        if (near(t[2], t[3], tail[0], tail[1], epsilon)) {
          line.push([t[0], t[1]]);
          used.add(j);
          grow = true;
          break;
        }
      }
    }
    polylines.push(line);
  }
  return polylines;
}

const near = (ax: number, ay: number, bx: number, by: number, e: number) =>
  Math.abs(ax - bx) < e && Math.abs(ay - by) < e;

export { lerp };
