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
