/**
 * Canonical mapping from blank space to each orthographic view's 2-D face frame.
 *
 * One source of truth shared by the silhouette tracer and the depth-field
 * rasteriser, so templates, depth maps and contours always line up.
 *
 * Face frame: origin at the drawn face's bottom-left, +u right, +v up,
 * millimetres. `depth` is the distance *into* the viewed face (0 at the face,
 * increasing inward); the nearest surface to the viewer is the smallest depth.
 */

import { Vec3 } from './mesh';
import { Blank } from './blank';
import { ViewName } from './projection';

export interface ViewFrame {
  view: ViewName;
  widthMm: number;
  heightMm: number;
  toU: (p: Vec3) => number;
  toV: (p: Vec3) => number;
  depth: (p: Vec3) => number;
}

/** One in-plane / depth axis as an affine map: `coord = p[axis] * sign + off`. */
export interface FrameAxis {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  off: number;
}

export interface FrameAxes {
  u: FrameAxis;
  v: FrameAxis;
  /** Depth into the face. */
  w: FrameAxis;
}

/**
 * The same face frame as `viewFrame`, expressed as three per-axis affine maps.
 * Used to drive the WASM rasteriser (which is view-agnostic); `viewFrame` stays
 * the reference for the pure-TS path. Kept here so the two never drift.
 */
export function frameAxes(view: ViewName, b: Blank): FrameAxes {
  const W = b.width, H = b.height, D = b.depth;
  switch (view) {
    case 'front':
      return { u: { axis: 0, sign: 1, off: W / 2 }, v: { axis: 1, sign: 1, off: H / 2 }, w: { axis: 2, sign: -1, off: D / 2 } };
    case 'back':
      return { u: { axis: 0, sign: -1, off: W / 2 }, v: { axis: 1, sign: 1, off: H / 2 }, w: { axis: 2, sign: 1, off: D / 2 } };
    case 'left':
      return { u: { axis: 2, sign: 1, off: D / 2 }, v: { axis: 1, sign: 1, off: H / 2 }, w: { axis: 0, sign: 1, off: W / 2 } };
    case 'right':
      return { u: { axis: 2, sign: -1, off: D / 2 }, v: { axis: 1, sign: 1, off: H / 2 }, w: { axis: 0, sign: -1, off: W / 2 } };
    case 'top':
      return { u: { axis: 0, sign: 1, off: W / 2 }, v: { axis: 2, sign: -1, off: D / 2 }, w: { axis: 1, sign: -1, off: H / 2 } };
    case 'bottom':
      return { u: { axis: 0, sign: 1, off: W / 2 }, v: { axis: 2, sign: 1, off: D / 2 }, w: { axis: 1, sign: 1, off: H / 2 } };
    default:
      throw new Error(`unknown view: ${view as string}`);
  }
}

export function viewFrame(view: ViewName, b: Blank): ViewFrame {
  const W = b.width, H = b.height, D = b.depth;
  switch (view) {
    case 'front': // camera on +Z looking -Z; sees the +Z face
      return { view, widthMm: W, heightMm: H, toU: (p) => p[0] + W / 2, toV: (p) => p[1] + H / 2, depth: (p) => D / 2 - p[2] };
    case 'back': // camera on -Z looking +Z; sees the -Z face
      return { view, widthMm: W, heightMm: H, toU: (p) => W / 2 - p[0], toV: (p) => p[1] + H / 2, depth: (p) => p[2] + D / 2 };
    case 'left': // camera on -X looking +X; sees the -X face
      return { view, widthMm: D, heightMm: H, toU: (p) => p[2] + D / 2, toV: (p) => p[1] + H / 2, depth: (p) => p[0] + W / 2 };
    case 'right': // camera on +X looking -X; sees the +X face
      return { view, widthMm: D, heightMm: H, toU: (p) => D / 2 - p[2], toV: (p) => p[1] + H / 2, depth: (p) => W / 2 - p[0] };
    case 'top': // camera on +Y looking -Y; sees the +Y face
      return { view, widthMm: W, heightMm: D, toU: (p) => p[0] + W / 2, toV: (p) => D / 2 - p[2], depth: (p) => H / 2 - p[1] };
    case 'bottom': // camera on -Y looking +Y; sees the -Y face
      return { view, widthMm: W, heightMm: D, toU: (p) => p[0] + W / 2, toV: (p) => p[2] + D / 2, depth: (p) => p[1] + H / 2 };
    default:
      throw new Error(`unknown view: ${view as string}`);
  }
}
