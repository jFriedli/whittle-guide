/**
 * Interactive 3D workspace: the model inside a translucent wooden blank, with
 * orbit/pan/zoom, labelled axes and several visualisation modes.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Blank } from '../geometry/blank';
import { Mat4 } from '../geometry/mesh';
import { VoxelDims } from './voxelMesh';
import { buildSurfaceNetsGeometry } from './surfaceNets';

export type ViewMode = 'model' | 'blankModel' | 'stage' | 'remove' | 'wireframe' | 'section' | 'undercuts' | 'fragile';

export interface StageGrid {
  data: Uint8Array;
  removed: Uint8Array | null;
}

const WOOD = 0xc8a06a;

export class Viewer {
  readonly scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private container: HTMLElement;

  private modelPivot = new THREE.Group(); // raw-model -> blank space
  private modelObject: THREE.Object3D | null = null;
  private blankMesh: THREE.Mesh;
  private blankEdges: THREE.LineSegments;
  private centerLines: THREE.LineSegments;
  private stageMesh: THREE.Mesh | null = null;
  private removeMesh: THREE.Mesh | null = null;
  private undercutMesh: THREE.Mesh | null = null;
  private fragileMesh: THREE.Mesh | null = null;
  private grainLines: THREE.LineSegments | null = null;
  private clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

  private blank: Blank = { width: 40, height: 100, depth: 40 };
  private grainAxis: 0 | 1 | 2 = 1;
  private mode: ViewMode = 'blankModel';
  private raf = 0;
  private ro: ResizeObserver;

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(w, h);
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
    this.camera.position.set(150, 120, 220);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(120, 200, 160);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.5);
    fill.position.set(-160, 60, -120);
    this.scene.add(fill);

    const grid = new THREE.GridHelper(400, 20, 0x8a8f98, 0x30343c);
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    grid.position.y = -0.01;
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(35));

    this.scene.add(this.modelPivot);

    // Blank
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.blankMesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: WOOD, transparent: true, opacity: 0.16, roughness: 0.9,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.scene.add(this.blankMesh);
    this.blankEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x6b4f2f }),
    );
    this.scene.add(this.blankEdges);

    this.centerLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0x9aa4b2, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.6 }),
    );
    this.scene.add(this.centerLines);

    this.applyBlank();
    this.applyMode();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.loop();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  setModel(object: THREE.Object3D) {
    if (this.modelObject) this.modelPivot.remove(this.modelObject);
    this.modelObject = object;
    this.modelPivot.add(object);
    this.applyMode();
  }

  /** Matrix mapping raw model space to blank space (normalise ∘ placement). */
  setModelMatrix(m: Mat4) {
    this.modelPivot.matrixAutoUpdate = false;
    this.modelPivot.matrix.fromArray(m);
    this.modelPivot.matrixWorldNeedsUpdate = true;
  }

  setBlank(blank: Blank) {
    this.blank = blank;
    this.applyBlank();
  }

  private applyBlank() {
    const { width, height, depth } = this.blank;
    this.blankMesh.scale.set(width, height, depth);
    this.blankEdges.scale.set(width, height, depth);
    const hx = width / 2, hy = height / 2, hz = depth / 2;
    const pts = [
      -hx, 0, 0, hx, 0, 0,
      0, -hy, 0, 0, hy, 0,
      0, 0, -hz, 0, 0, hz,
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.centerLines.geometry.dispose();
    this.centerLines.geometry = g;
    this.centerLines.computeLineDistances();
    this.clipPlane.constant = 0;
    this.setGrainAxis(this.grainAxis);
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.applyMode();
  }

  private applyMode() {
    const m = this.mode;
    const overlay = m === 'undercuts' || m === 'fragile';
    const showModel = m === 'model' || m === 'blankModel' || m === 'wireframe' || m === 'section' || m === 'remove' || overlay;
    const showBlank = m === 'blankModel' || m === 'section';
    if (this.modelObject) {
      this.modelObject.visible = showModel;
      this.modelObject.traverse((c) => {
        const mm = c as THREE.Mesh;
        if (!mm.isMesh) return;
        const mat = mm.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
        const list = Array.isArray(mat) ? mat : [mat];
        for (const x of list) {
          x.wireframe = m === 'wireframe';
          x.clippingPlanes = m === 'section' ? [this.clipPlane] : [];
          x.transparent = m === 'remove' || overlay;
          x.opacity = m === 'remove' ? 0.35 : overlay ? 0.5 : 1;
          x.needsUpdate = true;
        }
      });
    }
    this.blankMesh.visible = showBlank || m === 'remove' || m === 'stage';
    (this.blankMesh.material as THREE.Material).opacity = m === 'stage' || m === 'remove' ? 0.06 : 0.16;
    this.blankEdges.visible = true;
    if (this.stageMesh) this.stageMesh.visible = m === 'stage';
    if (this.removeMesh) this.removeMesh.visible = m === 'remove' || m === 'stage';
    if (this.undercutMesh) this.undercutMesh.visible = m === 'undercuts';
    if (this.fragileMesh) this.fragileMesh.visible = m === 'fragile';
    if (this.grainLines) this.grainLines.visible = showBlank || m === 'fragile';
  }

  setFragility(mask: Uint8Array | null, dims: VoxelDims) {
    if (this.fragileMesh) {
      this.scene.remove(this.fragileMesh);
      this.fragileMesh.geometry.dispose();
      this.fragileMesh = null;
    }
    let any = false;
    if (mask) for (let i = 0; i < mask.length; i++) if (mask[i]) { any = true; break; }
    if (any && mask) {
      this.fragileMesh = new THREE.Mesh(
        buildSurfaceNetsGeometry(mask, dims, { blurPasses: 0, smoothIterations: 1 }),
        new THREE.MeshStandardMaterial({ color: 0xffcc33, emissive: 0x5c4300, emissiveIntensity: 0.6, roughness: 0.5, flatShading: false }),
      );
      this.scene.add(this.fragileMesh);
    }
    this.applyMode();
  }

  /** Draw grain-direction hatching on the blank surface. axis: 0=X,1=Y,2=Z. */
  setGrainAxis(axis: 0 | 1 | 2) {
    this.grainAxis = axis;
    if (this.grainLines) {
      this.scene.remove(this.grainLines);
      this.grainLines.geometry.dispose();
    }
    const { width: w, height: h, depth: d } = this.blank;
    const half: [number, number, number] = [w / 2, h / 2, d / 2];
    const span = half[axis];
    const pts: number[] = [];
    // a few grain lines on the two most-visible faces (+Z and +X)
    const other = [0, 1, 2].filter((a) => a !== axis);
    for (const faceAxis of other) {
      const inPlane = other.find((a) => a !== faceAxis)!;
      for (let t = -0.7; t <= 0.71; t += 0.35) {
        const a: [number, number, number] = [0, 0, 0];
        const b: [number, number, number] = [0, 0, 0];
        a[faceAxis] = b[faceAxis] = half[faceAxis] * 1.001;
        a[inPlane] = b[inPlane] = t * half[inPlane];
        a[axis] = -span;
        b[axis] = span;
        pts.push(...a, ...b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.grainLines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: 0x8a6a3f, transparent: true, opacity: 0.4 }),
    );
    this.scene.add(this.grainLines);
    this.applyMode();
  }

  setUndercuts(mask: Uint8Array | null, dims: VoxelDims) {
    if (this.undercutMesh) {
      this.scene.remove(this.undercutMesh);
      this.undercutMesh.geometry.dispose();
      this.undercutMesh = null;
    }
    let any = false;
    if (mask) for (let i = 0; i < mask.length; i++) if (mask[i]) { any = true; break; }
    if (any && mask) {
      this.undercutMesh = new THREE.Mesh(
        buildSurfaceNetsGeometry(mask, dims, { blurPasses: 0, smoothIterations: 1 }),
        new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0x5c0f0a, emissiveIntensity: 0.6, roughness: 0.6, flatShading: false }),
      );
      this.scene.add(this.undercutMesh);
    }
    this.applyMode();
  }

  setStage(grid: StageGrid | null, dims: VoxelDims) {
    if (this.stageMesh) {
      this.scene.remove(this.stageMesh);
      this.stageMesh.geometry.dispose();
      this.stageMesh = null;
    }
    if (this.removeMesh) {
      this.scene.remove(this.removeMesh);
      this.removeMesh.geometry.dispose();
      this.removeMesh = null;
    }
    if (!grid) {
      this.applyMode();
      return;
    }
    this.stageMesh = new THREE.Mesh(
      buildSurfaceNetsGeometry(grid.data, dims, { blurPasses: 0, smoothIterations: 3, isoLevel: 0.42 }),
      new THREE.MeshStandardMaterial({
        color: WOOD, roughness: 0.85, flatShading: false,
        emissive: 0x2a1c0d, emissiveIntensity: 0.4,
      }),
    );
    this.scene.add(this.stageMesh);
    if (grid.removed) {
      this.removeMesh = new THREE.Mesh(
        buildSurfaceNetsGeometry(grid.removed, dims, { blurPasses: 0, smoothIterations: 2 }),
        new THREE.MeshStandardMaterial({
          color: 0xd6584a, transparent: true, opacity: 0.3, roughness: 0.9,
          side: THREE.FrontSide, depthWrite: false, flatShading: false,
        }),
      );
      this.scene.add(this.removeMesh);
    }
    this.applyMode();
  }

  setSection(fraction: number) {
    // slide the clip plane through depth
    this.clipPlane.constant = (fraction - 0.5) * this.blank.depth;
  }

  resetCamera() {
    const r = Math.max(this.blank.width, this.blank.height, this.blank.depth);
    this.camera.position.set(r * 1.6, r * 1.3, r * 2.2);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * A fresh, detached group (own GPU resources not required — geometries and
   * materials are shared by reference) representing what's on screen right now,
   * for the WebXR overlay. Millimetre units, centred on the origin.
   *
   * Shows the smoothed carving stage when the current mode is 'stage',
   * otherwise the placed model; always includes a wireframe of the blank so the
   * carver can line it up with the real block.
   */
  buildARGroup(): THREE.Group {
    const group = new THREE.Group();

    if (this.mode === 'stage' && this.stageMesh) {
      group.add(this.stageMesh.clone());
    } else if (this.modelObject) {
      const pivot = this.modelPivot.clone(true);
      pivot.matrixAutoUpdate = false;
      pivot.matrix.copy(this.modelPivot.matrix);
      group.add(pivot);
    }

    const { width, height, depth } = this.blank;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
      new THREE.LineBasicMaterial({ color: 0x6b4f2f }),
    );
    group.add(edges);
    return group;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
