/**
 * Build a three.js surface mesh from a voxel occupancy grid by emitting only the
 * faces between a solid voxel and empty space. Used to draw carving stages and
 * the "material to remove" volume.
 */

import * as THREE from 'three';

export interface VoxelDims {
  nx: number;
  ny: number;
  nz: number;
  d: [number, number, number];
  origin: [number, number, number];
}

const FACES: [number, number, number, number[][]][] = [
  [1, 0, 0, [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
  [-1, 0, 0, [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]],
  [0, 1, 0, [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
  [0, -1, 0, [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
  [0, 0, 1, [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]],
  [0, 0, -1, [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
];

export function buildVoxelGeometry(data: Uint8Array, dims: VoxelDims): THREE.BufferGeometry {
  const { nx, ny, nz, d, origin } = dims;
  const at = (i: number, j: number, k: number) =>
    i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : data[i + nx * (j + ny * k)];

  const positions: number[] = [];
  const normals: number[] = [];

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!data[i + nx * (j + ny * k)]) continue;
        const x0 = origin[0] + i * d[0];
        const y0 = origin[1] + j * d[1];
        const z0 = origin[2] + k * d[2];
        for (const [ni, nj, nk, quad] of FACES) {
          if (at(i + ni, j + nj, k + nk)) continue;
          const p = quad.map(([cx, cy, cz]) => [x0 + cx * d[0], y0 + cy * d[1], z0 + cz * d[2]]);
          for (const idx of [0, 1, 2, 0, 2, 3]) {
            positions.push(p[idx][0], p[idx][1], p[idx][2]);
            normals.push(ni, nj, nk);
          }
        }
      }
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geom;
}
