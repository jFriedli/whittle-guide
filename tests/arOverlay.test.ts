import { describe, it, expect, vi, afterEach } from 'vitest';
import { arSupported, ARView } from '../src/viewer/arOverlay';

afterEach(() => vi.unstubAllGlobals());

describe('arSupported', () => {
  it('is false when the browser has no WebXR', async () => {
    vi.stubGlobal('navigator', {});
    expect(await arSupported()).toBe(false);
  });

  it('is false when immersive-ar is not supported', async () => {
    vi.stubGlobal('navigator', { xr: { isSessionSupported: async () => false } });
    expect(await arSupported()).toBe(false);
  });

  it('reflects a positive isSessionSupported for immersive-ar', async () => {
    const isSessionSupported = vi.fn(async (mode: string) => mode === 'immersive-ar');
    vi.stubGlobal('navigator', { xr: { isSessionSupported } });
    expect(await arSupported()).toBe(true);
    expect(isSessionSupported).toHaveBeenCalledWith('immersive-ar');
  });

  it('swallows a throwing isSessionSupported', async () => {
    vi.stubGlobal('navigator', { xr: { isSessionSupported: () => { throw new Error('nope'); } } });
    expect(await arSupported()).toBe(false);
  });
});

describe('ARView', () => {
  it('start() rejects cleanly with no WebXR and never becomes active', async () => {
    vi.stubGlobal('navigator', {});
    const view = new ARView();
    await expect(
      view.start({ object: {} as never, label: 'x', blank: { width: 40, height: 100, depth: 40 } }),
    ).rejects.toThrow(/WebXR/i);
    expect(view.active).toBe(false);
  });

  it('stop() on an inactive view is a harmless no-op', async () => {
    await expect(new ARView().stop()).resolves.toBeUndefined();
  });
});
