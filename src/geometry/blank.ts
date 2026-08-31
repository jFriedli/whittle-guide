/**
 * The wooden blank and how the model sits inside it.
 *
 * Blank space convention (millimetres, right-handed):
 *   +X = width  (front-view horizontal)
 *   +Y = height (front-view vertical, "up")
 *   +Z = depth  (towards the viewer in the front view)
 * The blank is an axis-aligned box centred on the origin.
 */

import { Box3, boxCenter, Mat4, composeTRS, Vec3 } from './mesh';

export interface Blank {
  width: number; // X, mm
  height: number; // Y, mm
  depth: number; // Z, mm
}

export interface Placement {
  /** Translation of the model centre within blank space, mm. */
  translation: Vec3;
  /** Intrinsic XYZ euler rotation, radians. */
  rotation: Vec3;
  /** Uniform scale factor applied to the *normalised* (centred) model. */
  scale: number;
}

export const defaultBlank = (): Blank => ({ width: 40, height: 100, depth: 40 });

export const defaultPlacement = (): Placement => ({
  translation: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
});

export const blankVolume = (b: Blank): number => b.width * b.height * b.depth;

export function blankBox(b: Blank): Box3 {
  return {
    min: [-b.width / 2, -b.height / 2, -b.depth / 2],
    max: [b.width / 2, b.height / 2, b.depth / 2],
  };
}

/**
 * Build the model→blank matrix. `normalisedBounds` is the axis-aligned box of the
 * model *after* normalisation (roughly centred on the origin, in millimetres at
 * scale 1); we re-centre exactly so placement translation is measured from the
 * blank centre to the model centre.
 */
export function placementMatrix(
  placement: Placement,
  normalisedBounds: Box3,
): Mat4 {
  const c = boxCenter(normalisedBounds);
  const recentre = composeTRS(
    [-c[0], -c[1], -c[2]],
    [0, 0, 0],
    1,
  );
  const trs = composeTRS(placement.translation, placement.rotation, placement.scale);
  // trs * recentre  (recentre first)
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += trs[k * 4 + row] * recentre[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}

export interface AutoFitResult {
  placement: Placement;
  /** Final model size inside the blank, mm. */
  fittedSize: Vec3;
  /** How the fitted size compares to the blank (fraction of each axis used). */
  fill: Vec3;
}

/**
 * Scale the (rotated) model uniformly so it fits inside the blank minus `margin`
 * on every side, preserving aspect ratio, then centre it.
 */
export function autoFit(
  normalisedBounds: Box3,
  blank: Blank,
  rotation: Vec3 = [0, 0, 0],
  marginMm = 3,
): AutoFitResult {
  // Size of the model's oriented bounding box after rotation. We approximate by
  // rotating the 8 corners of the normalised box.
  const rotated = rotatedBoxSize(normalisedBounds, rotation);
  const avail: Vec3 = [
    Math.max(1e-3, blank.width - 2 * marginMm),
    Math.max(1e-3, blank.height - 2 * marginMm),
    Math.max(1e-3, blank.depth - 2 * marginMm),
  ];
  const scale = Math.min(
    avail[0] / rotated[0],
    avail[1] / rotated[1],
    avail[2] / rotated[2],
  );
  const fittedSize: Vec3 = [
    rotated[0] * scale,
    rotated[1] * scale,
    rotated[2] * scale,
  ];
  return {
    placement: { translation: [0, 0, 0], rotation, scale },
    fittedSize,
    fill: [
      fittedSize[0] / blank.width,
      fittedSize[1] / blank.height,
      fittedSize[2] / blank.depth,
    ],
  };
}

export function rotatedBoxSize(box: Box3, euler: Vec3): Vec3 {
  const m = composeTRS([0, 0, 0], euler, 1);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? box.max[0] : box.min[0];
    const y = i & 2 ? box.max[1] : box.min[1];
    const z = i & 4 ? box.max[2] : box.min[2];
    const tx = m[0] * x + m[4] * y + m[8] * z;
    const ty = m[1] * x + m[5] * y + m[9] * z;
    const tz = m[2] * x + m[6] * y + m[10] * z;
    min[0] = Math.min(min[0], tx);
    min[1] = Math.min(min[1], ty);
    min[2] = Math.min(min[2], tz);
    max[0] = Math.max(max[0], tx);
    max[1] = Math.max(max[1], ty);
    max[2] = Math.max(max[2], tz);
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/** Does the placed model fit entirely inside the blank? */
export function fitsInside(placedBounds: Box3, blank: Blank, tol = 1e-4): boolean {
  const bb = blankBox(blank);
  return (
    placedBounds.min[0] >= bb.min[0] - tol &&
    placedBounds.min[1] >= bb.min[1] - tol &&
    placedBounds.min[2] >= bb.min[2] - tol &&
    placedBounds.max[0] <= bb.max[0] + tol &&
    placedBounds.max[1] <= bb.max[1] + tol &&
    placedBounds.max[2] <= bb.max[2] + tol
  );
}
