/**
 * WebXR passthrough-AR overlay.
 *
 * Drops the finished carving (or the current roughing stage) into the room at
 * true 1:1 scale so the carver can hold it up against the actual block of wood.
 * Uses `immersive-ar` with hit-testing to place the model on a real surface and
 * a `dom-overlay` for the on-screen controls.
 *
 * Entirely optional: `arSupported()` gates the entry point, and every failure
 * path just closes the session and returns — the rest of the app is untouched.
 */

import * as THREE from 'three';
import { Blank } from '../geometry/blank';
import { el } from '../app/dom';

/** True only on devices/browsers with immersive-AR (Android Chrome, XR headsets). */
export async function arSupported(): Promise<boolean> {
  try {
    return (await navigator.xr?.isSessionSupported('immersive-ar')) ?? false;
  } catch {
    return false;
  }
}

export interface ARContent {
  /** Millimetre-scale group, centred on the origin in X/Z, base at y = 0. */
  object: THREE.Object3D;
  /** What is being shown, e.g. "Finished carving" or "Stage 3 — Coarse block". */
  label: string;
  blank: Blank;
}

const MM_TO_M = 0.001;

export class ARView {
  private session: XRSession | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private overlay: HTMLElement | null = null;
  private hitSource: XRHitTestSource | null = null;
  private onEnd: (() => void) | null = null;

  get active(): boolean {
    return this.session !== null;
  }

  async start(content: ARContent, onEnd?: () => void): Promise<void> {
    if (this.session) return;
    const xr = navigator.xr;
    if (!xr) throw new Error('WebXR not available');
    this.onEnd = onEnd ?? null;

    const overlay = this.buildOverlay(content.label, content.blank);
    this.overlay = overlay;
    document.body.append(overlay);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.xr.enabled = true;
    renderer.domElement.style.cssText = 'position:fixed;inset:0;';
    document.body.append(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404030, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.5, 1, 0.25);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    // Anchor holds the mm-scale content; scale converts to metres.
    const anchor = new THREE.Group();
    anchor.scale.setScalar(MM_TO_M);
    anchor.visible = false;
    // Lift so the model's base (centred at y=0, spanning ±h/2) rests on the surface.
    content.object.position.y = content.blank.height / 2;
    anchor.add(content.object);
    scene.add(anchor);

    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.045, 0.055, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffcc33 }),
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    let session: XRSession;
    try {
      session = await xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: overlay },
      });
    } catch (e) {
      this.cleanup();
      throw e instanceof Error ? e : new Error('could not start AR');
    }
    this.session = session;

    session.addEventListener('end', () => this.cleanup());

    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);

    // Hit-test source anchored to the viewer ray.
    try {
      const viewerSpace = await session.requestReferenceSpace('viewer');
      this.hitSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
    } catch {
      this.hitSource = null;
    }

    let placed = false;
    const place = (matrix: THREE.Matrix4) => {
      anchor.position.setFromMatrixPosition(matrix);
      // Yaw only — keep the piece upright even on a sloped hit.
      const e = new THREE.Euler().setFromRotationMatrix(matrix, 'YXZ');
      anchor.rotation.set(0, e.y, 0);
      anchor.visible = true;
      placed = true;
      overlay.dataset.placed = '1';
    };

    session.addEventListener('select', () => {
      if (reticle.visible) place(reticle.matrix);
      else if (!placed) {
        // No surface found — drop it ~0.6 m in front of the camera.
        const m = new THREE.Matrix4().makeTranslation(0, 0, -0.6).premultiply(camera.matrixWorld);
        place(m);
      }
    });

    overlay.querySelector('[data-act=replace]')?.addEventListener('click', () => {
      placed = false;
      anchor.visible = false;
      delete overlay.dataset.placed;
    });
    overlay.querySelector('[data-act=exit]')?.addEventListener('click', () => void session.end());

    const refSpace = renderer.xr.getReferenceSpace();
    renderer.setAnimationLoop((_t, frame) => {
      if (frame && this.hitSource && refSpace && !placed) {
        const hits = frame.getHitTestResults(this.hitSource);
        const pose = hits[0]?.getPose(refSpace);
        if (pose) {
          reticle.visible = true;
          reticle.matrix.fromArray(pose.transform.matrix);
        } else {
          reticle.visible = false;
        }
      } else if (placed) {
        reticle.visible = false;
      }
      renderer.render(scene, camera);
    });
  }

  async stop(): Promise<void> {
    await this.session?.end().catch(() => {});
    this.cleanup();
  }

  private cleanup(): void {
    this.hitSource?.cancel?.();
    this.hitSource = null;
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.session = null;
    const cb = this.onEnd;
    this.onEnd = null;
    cb?.();
  }

  private buildOverlay(label: string, blank: Blank): HTMLElement {
    return el('div', { class: 'ar-overlay' }, [
      el('div', { class: 'ar-overlay__bar' }, [
        el('div', { class: 'ar-overlay__info' }, [
          el('strong', {}, [label]),
          el('span', {}, [
            `1:1 — ${Math.round(blank.width)} × ${Math.round(blank.height)} × ${Math.round(blank.depth)} mm. `,
            'Point at a flat surface, then tap to place.',
          ]),
        ]),
        el('div', { class: 'ar-overlay__btns' }, [
          el('button', { 'data-act': 'replace', class: 'ar-btn' }, ['Re-place']),
          el('button', { 'data-act': 'exit', class: 'ar-btn ar-btn--primary' }, ['Exit AR']),
        ]),
      ]),
    ]);
  }
}
