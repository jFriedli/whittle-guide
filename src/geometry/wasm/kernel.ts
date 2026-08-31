/**
 * Loader + typed wrapper for the Rust/WASM geometry kernel.
 *
 * The kernel is an optional fast path: `analyse()` and the worker use it when it
 * loads, and fall back to the pure-TS implementations (which stay the reference
 * and the test oracle) otherwise. Plain C ABI, no wasm-bindgen.
 */

export interface KernelExports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  alloc(n: number): number;
  reset(): void;
  voxelize(
    pos: number, triCount: number,
    nx: number, ny: number, nz: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    axes: number, out: number,
  ): void;
  distance_transform(
    data: number, nx: number, ny: number, nz: number, scale: number, out: number,
  ): void;
}

const EXPECTED_ABI = 2;

export class GeometryKernel {
  private ex: KernelExports;

  private constructor(ex: KernelExports) {
    this.ex = ex;
  }

  static async fromBytes(bytes: BufferSource): Promise<GeometryKernel> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports as unknown as KernelExports;
    if (typeof ex.voxelize !== 'function' || ex.abi_version() !== EXPECTED_ABI) {
      throw new Error('kernel ABI mismatch');
    }
    return new GeometryKernel(ex);
  }

  /** Try to load the bundled kernel; return null on any failure (caller falls back). */
  static async tryLoad(): Promise<GeometryKernel | null> {
    try {
      // Vite resolves this to a hashed asset URL at build time.
      const url = (await import('./kernel.wasm?url')).default;
      const res = await fetch(url);
      if (!res.ok) return null;
      return await GeometryKernel.fromBytes(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private u8(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.ex.memory.buffer, ptr, len);
  }
  private f32(ptr: number, len: number): Float32Array {
    return new Float32Array(this.ex.memory.buffer, ptr, len);
  }

  voxelize(
    positions: Float32Array,
    dims: { nx: number; ny: number; nz: number },
    d: [number, number, number],
    origin: [number, number, number],
    axes: 1 | 3,
  ): Uint8Array {
    const { nx, ny, nz } = dims;
    const total = nx * ny * nz;
    const triCount = positions.length / 9;
    this.ex.reset();
    const posPtr = this.ex.alloc(positions.length * 4);
    const outPtr = this.ex.alloc(total);
    this.f32(posPtr, positions.length).set(positions);
    this.u8(outPtr, total).fill(0);
    this.ex.voxelize(
      posPtr, triCount, nx, ny, nz,
      origin[0], origin[1], origin[2], d[0], d[1], d[2],
      axes, outPtr,
    );
    const out = this.u8(outPtr, total).slice();
    this.ex.reset();
    return out;
  }

  distanceTransform(
    data: Uint8Array,
    dims: { nx: number; ny: number; nz: number },
    scaleMm: number,
  ): Float32Array {
    const { nx, ny, nz } = dims;
    const total = nx * ny * nz;
    this.ex.reset();
    const dataPtr = this.ex.alloc(total);
    const outPtr = this.ex.alloc(total * 4);
    this.u8(dataPtr, total).set(data);
    this.ex.distance_transform(dataPtr, nx, ny, nz, scaleMm, outPtr);
    const out = this.f32(outPtr, total).slice();
    this.ex.reset();
    // Rust writes f32::MAX for unreachable; normalise to Infinity like the TS path.
    for (let i = 0; i < out.length; i++) if (out[i] >= 3.4e38) out[i] = Infinity;
    return out;
  }
}
