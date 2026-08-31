/**
 * Built-in demo models — synthetic meshes so the full pipeline works instantly
 * and offline, with no museum download. Handy for a first look and for testing.
 */

import * as THREE from 'three';
import { LoadedModel } from './loaders';
import { Mesh, makePawn, makeSphere, makeCone, makeCylinder, applyMatrix4, translation, mergeMeshes, triangleCount } from '../geometry/mesh';

function toObject(mesh: Mesh): THREE.Object3D {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions.slice(), 3));
  geom.computeVertexNormals();
  return new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({ color: 0xc79a63, roughness: 0.8, metalness: 0, flatShading: false }),
  );
}

function birdMesh(): Mesh {
  const body = makeSphere(1, 22);
  const bodyS = applyMatrix4(body, [1.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const head = applyMatrix4(makeSphere(0.55, 18), translation(1.2, 0.5, 0));
  const beak = applyMatrix4(makeCone(0.22, 0.6, 12), [0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1.75, 0.5, 0, 1]);
  const tail = applyMatrix4(makeCone(0.5, 1.1, 12), [0, 0, -1, 0, 1, 0, 0, 0, 0, 0, 1, 0, -1.6, 0.15, 0, 1]);
  const base = applyMatrix4(makeCylinder(0.7, 0.4, 20), translation(0, -1.05, 0));
  return mergeMeshes([base, bodyS, head, beak, tail]);
}

export const DEMO_MODELS: { id: string; label: string; make: () => Mesh }[] = [
  { id: 'figure', label: 'Standing figure', make: makePawn },
  { id: 'bird', label: 'Perched bird', make: birdMesh },
];

export function demoModel(id = 'figure'): LoadedModel {
  const entry = DEMO_MODELS.find((d) => d.id === id) ?? DEMO_MODELS[0];
  const mesh = entry.make();
  return {
    object: toObject(mesh),
    mesh,
    triangleCount: triangleCount(mesh),
    format: 'glb',
    sourceName: `demo:${entry.id}`,
  };
}
