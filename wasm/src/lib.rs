//! WhittleGuide geometry kernel, compiled to `wasm32-unknown-unknown` with a
//! plain C ABI (no wasm-bindgen). The pure-TypeScript implementations in
//! `src/geometry/` remain the reference and the fallback; this module is a
//! drop-in fast path for the two hottest operations:
//!
//!   * `voxelize`            — 3-axis parity fill + majority vote
//!   * `distance_transform`  — 3-D chamfer (1 / √2 / √3) distance to solid
//!
//! Memory: linear memory is exported. `alloc(n)` bump-allocates `n` bytes and
//! returns an offset; `reset()` rewinds the bump pointer. The JS glue writes
//! inputs, calls a kernel, reads the output, then `reset()`s.

#![no_std]
#![allow(clippy::missing_safety_doc)]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;
use core::alloc::{GlobalAlloc, Layout};
use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// --- bump allocator ---------------------------------------------------------

const ARENA_SIZE: usize = 64 * 1024 * 1024; // 64 MiB

#[repr(align(16))]
#[allow(dead_code)]
struct Arena([u8; ARENA_SIZE]);
static mut ARENA: Arena = Arena([0; ARENA_SIZE]);
static mut BUMP: usize = 0;

#[inline]
unsafe fn arena_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(ARENA) as *mut u8
}

struct Bump;

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let align = layout.align().max(16);
        let start = (BUMP + align - 1) & !(align - 1);
        let end = start + layout.size();
        if end > ARENA_SIZE {
            return core::ptr::null_mut();
        }
        BUMP = end;
        arena_ptr().add(start)
    }
    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}

#[global_allocator]
static ALLOC: Bump = Bump;

// --- no_std float helpers (no libm dependency) ------------------------------

#[inline]
fn dabs(x: f64) -> f64 {
    f64::from_bits(x.to_bits() & 0x7fff_ffff_ffff_ffff)
}

#[inline]
fn dfloor(x: f64) -> f64 {
    let t = (x as i64) as f64;
    if x < t {
        t - 1.0
    } else {
        t
    }
}

#[inline]
fn dceil(x: f64) -> f64 {
    let t = (x as i64) as f64;
    if x > t {
        t + 1.0
    } else {
        t
    }
}

#[no_mangle]
pub unsafe extern "C" fn alloc(n: usize) -> *mut u8 {
    let align = 16usize;
    let start = (BUMP + align - 1) & !(align - 1);
    let end = start + n;
    if end > ARENA_SIZE {
        return core::ptr::null_mut();
    }
    BUMP = end;
    arena_ptr().add(start)
}

#[no_mangle]
pub unsafe extern "C" fn reset() {
    BUMP = 0;
}

/// Kernel ABI version — bump when the signatures below change.
#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    2
}

// --- voxelisation ----------------------------------------------------------

#[inline]
fn axis_map(axis: u32) -> (usize, usize, usize) {
    match axis {
        0 => (1, 2, 0),
        1 => (0, 2, 1),
        _ => (0, 1, 2),
    }
}

unsafe fn fill_axis(
    pos: *const f32,
    tri_count: usize,
    n: [usize; 3],
    d: [f64; 3],
    origin: [f64; 3],
    axis: u32,
    out: *mut u8,
) {
    let (u, v, w) = axis_map(axis);
    let nu = n[u];
    let nv = n[v];
    let nw = n[w];

    let stride = [1usize, n[0], n[0] * n[1]];
    let (su, sv, sw) = (stride[u], stride[v], stride[w]);

    let mut cols: Vec<Vec<f64>> = vec![Vec::new(); nu * nv];

    // The TS reference promotes the f32 vertex data to f64 for the barycentric
    // test; grid origin/spacing arrive as f64 already. Bit-identical to fallback.
    let (ou, ov, ow) = (origin[u], origin[v], origin[w]);
    let (du, dv, dw) = (d[u], d[v], d[w]);

    for t in 0..tri_count {
        let base = t * 9;
        let g = |k: usize, off: usize| *pos.add(base + k * 3 + off) as f64;
        let (au, av, aw) = (g(0, u), g(0, v), g(0, w));
        let (bu, bv, bw) = (g(1, u), g(1, v), g(1, w));
        let (cu, cv, cw) = (g(2, u), g(2, v), g(2, w));

        let min_u = au.min(bu).min(cu);
        let max_u = au.max(bu).max(cu);
        let min_v = av.min(bv).min(cv);
        let max_v = av.max(bv).max(cv);

        let mut i0 = dceil((min_u - ou) / du - 0.5) as isize;
        let mut i1 = dfloor((max_u - ou) / du - 0.5) as isize;
        let mut j0 = dceil((min_v - ov) / dv - 0.5) as isize;
        let mut j1 = dfloor((max_v - ov) / dv - 0.5) as isize;
        if i0 < 0 {
            i0 = 0;
        }
        if j0 < 0 {
            j0 = 0;
        }
        if i1 > nu as isize - 1 {
            i1 = nu as isize - 1;
        }
        if j1 > nv as isize - 1 {
            j1 = nv as isize - 1;
        }
        if i0 > i1 || j0 > j1 {
            continue;
        }

        let det = (bv - cv) * (au - cu) + (cu - bu) * (av - cv);
        if dabs(det) < 1e-12 {
            continue;
        }
        let inv = 1.0 / det;

        for i in i0..=i1 {
            let pu = ou + (i as f64 + 0.5) * du;
            for j in j0..=j1 {
                let pv = ov + (j as f64 + 0.5) * dv;
                let l1 = ((bv - cv) * (pu - cu) + (cu - bu) * (pv - cv)) * inv;
                let l2 = ((cv - av) * (pu - cu) + (au - cu) * (pv - cv)) * inv;
                let l3 = 1.0 - l1 - l2;
                if l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9 {
                    continue;
                }
                let hit = l1 * aw + l2 * bw + l3 * cw;
                cols[i as usize + nu * j as usize].push(hit);
            }
        }
    }

    for key in 0..cols.len() {
        let list = &mut cols[key];
        if list.len() < 2 {
            continue;
        }
        list.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
        let i = key % nu;
        let j = key / nu;
        let base_idx = i * su + j * sv;
        let mut s = 0;
        while s + 1 < list.len() {
            let wa = list[s];
            let wb = list[s + 1];
            let mut k0 = dceil((wa - ow) / dw - 0.5) as isize;
            let mut k1 = dfloor((wb - ow) / dw - 0.5) as isize;
            if k0 < 0 {
                k0 = 0;
            }
            if k1 > nw as isize - 1 {
                k1 = nw as isize - 1;
            }
            let mut k = k0;
            while k <= k1 {
                let idx = base_idx + k as usize * sw;
                *out.add(idx) = out.add(idx).read().saturating_add(1);
                k += 1;
            }
            s += 2;
        }
    }
}

/// Solid-voxelise a triangle soup. `out` must be `nx*ny*nz` bytes (written 0/1).
#[no_mangle]
pub unsafe extern "C" fn voxelize(
    pos: *const f32,
    tri_count: u32,
    nx: u32,
    ny: u32,
    nz: u32,
    ox: f64,
    oy: f64,
    oz: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    axes: u32,
    out: *mut u8,
) {
    let n = [nx as usize, ny as usize, nz as usize];
    let total = n[0] * n[1] * n[2];
    let d = [dx, dy, dz];
    let origin = [ox, oy, oz];

    let mut votes: Vec<u8> = vec![0u8; total];
    let axis_list: &[u32] = if axes == 1 { &[2] } else { &[0, 1, 2] };

    for &ax in axis_list {
        let mut partial: Vec<u8> = vec![0u8; total];
        fill_axis(pos, tri_count as usize, n, d, origin, ax, partial.as_mut_ptr());
        for i in 0..total {
            if partial[i] > 0 {
                votes[i] += 1;
            }
        }
    }

    let threshold = if axes == 1 { 1 } else { 2 };
    for i in 0..total {
        *out.add(i) = if votes[i] >= threshold { 1 } else { 0 };
    }
}

// --- distance transform --------------------------------------------------------

/// Chamfer distance (mm) from every voxel to the nearest solid voxel.
/// `out` must be `nx*ny*nz` f32; unreachable voxels get `f32::MAX`.
#[no_mangle]
pub unsafe extern "C" fn distance_transform(
    data: *const u8,
    nx: u32,
    ny: u32,
    nz: u32,
    scale: f64,
    out: *mut f32,
) {
    let scale = scale as f32;
    let (nx, ny, nz) = (nx as usize, ny as usize, nz as usize);
    let total = nx * ny * nz;
    const BIG: f32 = 1.0e9;
    let a = 1.0f32;
    let b = core::f32::consts::SQRT_2;
    let c = 1.7320508f32;

    let dist = core::slice::from_raw_parts_mut(out, total);
    for i in 0..total {
        dist[i] = if *data.add(i) != 0 { 0.0 } else { BIG };
    }

    let idx = |x: usize, y: usize, z: usize| x + nx * (y + ny * z);

    // Offsets split into "already visited" sets for the two raster sweeps.
    let mut fwd: Vec<(isize, isize, isize, f32)> = Vec::new();
    let mut bwd: Vec<(isize, isize, isize, f32)> = Vec::new();
    for oz in -1isize..=1 {
        for oy in -1isize..=1 {
            for ox in -1isize..=1 {
                if ox == 0 && oy == 0 && oz == 0 {
                    continue;
                }
                let man = ox.abs() + oy.abs() + oz.abs();
                let w = if man == 1 {
                    a
                } else if man == 2 {
                    b
                } else {
                    c
                };
                let order = oz * 100 + oy * 10 + ox;
                if order < 0 {
                    fwd.push((ox, oy, oz, w));
                } else {
                    bwd.push((ox, oy, oz, w));
                }
            }
        }
    }

    let relax = |dist: &mut [f32], x: usize, y: usize, z: usize, offs: &[(isize, isize, isize, f32)]| {
        let here = idx(x, y, z);
        let mut best = dist[here];
        for &(ox, oy, oz, w) in offs {
            let xx = x as isize + ox;
            let yy = y as isize + oy;
            let zz = z as isize + oz;
            if xx < 0 || yy < 0 || zz < 0 || xx >= nx as isize || yy >= ny as isize || zz >= nz as isize {
                continue;
            }
            let cand = dist[idx(xx as usize, yy as usize, zz as usize)] + w;
            if cand < best {
                best = cand;
            }
        }
        dist[here] = best;
    };

    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                relax(dist, x, y, z, &fwd);
            }
        }
    }
    for z in (0..nz).rev() {
        for y in (0..ny).rev() {
            for x in (0..nx).rev() {
                relax(dist, x, y, z, &bwd);
            }
        }
    }

    for i in 0..total {
        dist[i] = if dist[i] >= BIG { f32::MAX } else { dist[i] * scale };
    }
}
