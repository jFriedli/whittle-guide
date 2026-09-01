/**
 * Model loading. Supports .glb / .gltf (incl. Draco-compressed), .obj, .stl and
 * .ply, from a URL (museum objects) or a local File (upload — never leaves the
 * browser).
 *
 * Produces both a three.js object for the viewer and a plain triangle-soup
 * `Mesh` (world-space) for the geometry subsystem.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Mesh } from '../geometry/mesh';

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'ply' | 'fbx' | '3mf';

export const SUPPORTED_EXTENSIONS = ['.glb', '.gltf', '.obj', '.stl', '.ply', '.fbx', '.3mf'] as const;

export interface LoadedModel {
  object: THREE.Object3D;
  /** World-space triangle soup for analysis. */
  mesh: Mesh;
  triangleCount: number;
  format: ModelFormat;
  sourceName: string;
}

function makeGLTFLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  // three's DRACOLoader resolves its decoder via `new URL(..., import.meta.url)`,
  // so Vite bundles the decoder as an asset automatically — no decoder path or
  // public/ copy needed. Draco-compressed museum GLBs decode out of the box.
  loader.setDRACOLoader(new DRACOLoader());
  return loader;
}

export function formatFromName(name: string): ModelFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.glb')) return 'glb';
  if (lower.endsWith('.gltf')) return 'gltf';
  if (lower.endsWith('.obj')) return 'obj';
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.ply')) return 'ply';
  if (lower.endsWith('.fbx')) return 'fbx';
  if (lower.endsWith('.3mf')) return '3mf';
  return null;
}

/** Merge every mesh in an object into one world-space triangle soup. */
export function extractMesh(root: THREE.Object3D): { mesh: Mesh; triangles: number } {
  root.updateWorldMatrix(true, true);
  const chunks: Float32Array[] = [];
  let triangles = 0;
  const normalMatrix = new THREE.Matrix4();

  root.traverse((child) => {
    const m = child as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    let geom = m.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position');
    if (!pos) return;

    normalMatrix.copy(m.matrixWorld);
    const index = geom.getIndex();
    const v = new THREE.Vector3();
    const count = index ? index.count : pos.count;
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const vi = index ? index.getX(i) : i;
      v.fromBufferAttribute(pos, vi).applyMatrix4(normalMatrix);
      out[i * 3] = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
    chunks.push(out);
    triangles += count / 3;
  });

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    merged.set(c, o);
    o += c.length;
  }
  return { mesh: { positions: merged }, triangles: Math.round(triangles) };
}

async function parse(format: ModelFormat, data: ArrayBuffer, url?: string): Promise<THREE.Object3D> {
  switch (format) {
    case 'glb':
    case 'gltf': {
      const loader = makeGLTFLoader();
      const gltf = await loader.parseAsync(data, url ? url.substring(0, url.lastIndexOf('/') + 1) : '');
      return gltf.scene;
    }
    case 'obj': {
      const text = new TextDecoder().decode(data);
      return new OBJLoader().parse(text);
    }
    case 'stl': {
      const geom = new STLLoader().parse(data);
      geom.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({ color: 0xb0895e, roughness: 0.85, metalness: 0 });
      return new THREE.Mesh(geom, material);
    }
    case 'ply': {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      const geom = new PLYLoader().parse(data);
      if (!geom.getAttribute('position')) throw new Error('PLY file has no vertex data.');
      if (!geom.getIndex()) {
        throw new Error('This PLY has no faces — it looks like a point cloud. WhittleGuide needs a surface mesh (try meshing it first).');
      }
      if (!geom.getAttribute('normal')) geom.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({ color: 0xb0895e, roughness: 0.85, metalness: 0 });
      return new THREE.Mesh(geom, material);
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      return new FBXLoader().parse(data, url ? url.substring(0, url.lastIndexOf('/') + 1) : '');
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
      return new ThreeMFLoader().parse(data);
    }
  }
}

function ensureMaterials(root: THREE.Object3D) {
  root.traverse((child) => {
    const m = child as THREE.Mesh;
    if (m.isMesh && (!m.material || (Array.isArray(m.material) && m.material.length === 0))) {
      m.material = new THREE.MeshStandardMaterial({ color: 0xb0895e, roughness: 0.85 });
    }
  });
}

export async function loadModelFromArrayBuffer(
  data: ArrayBuffer,
  format: ModelFormat,
  sourceName: string,
  url?: string,
): Promise<LoadedModel> {
  const object = await parse(format, data, url);
  ensureMaterials(object);
  const { mesh, triangles } = extractMesh(object);
  if (triangles === 0) {
    throw new Error('The file loaded but contains no triangle geometry.');
  }
  return { object, mesh, triangleCount: triangles, format, sourceName };
}

export async function loadModelFromUrl(url: string, formatHint?: ModelFormat): Promise<LoadedModel> {
  const format = formatHint ?? formatFromName(url);
  if (!format) throw new Error(`Unsupported model type: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const data = await res.arrayBuffer();
  const name = url.substring(url.lastIndexOf('/') + 1) || 'model';
  return loadModelFromArrayBuffer(data, format, name, url);
}

export async function loadModelFromFile(file: File): Promise<LoadedModel> {
  const format = formatFromName(file.name);
  if (!format) {
    throw new Error(
      `Unsupported file type "${file.name.split('.').pop() ?? '?'}". Use ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    );
  }
  const data = await file.arrayBuffer();
  return loadModelFromArrayBuffer(data, format, file.name);
}
