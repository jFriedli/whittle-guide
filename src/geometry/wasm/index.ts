/**
 * Optional WASM acceleration registry.
 *
 * `analyse()` (and therefore the worker) calls `initKernel()` once; if it
 * succeeds, `voxelize()` and `distanceToSolid()` transparently use the Rust
 * kernel. Everything still works — just slower — when it doesn't load.
 */

import { GeometryKernel } from './kernel';

let active: GeometryKernel | null = null;
let attempted = false;

export function getKernel(): GeometryKernel | null {
  return active;
}

export function setKernel(k: GeometryKernel | null): void {
  active = k;
}

/** Idempotent: loads the bundled kernel once. Safe to call from any context. */
export async function initKernel(): Promise<boolean> {
  if (active) return true;
  if (attempted) return false;
  attempted = true;
  active = await GeometryKernel.tryLoad();
  return active !== null;
}

export { GeometryKernel };
