import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikimediaProvider } from '../src/museum/providers/wikimedia';

const page = (title: string, url: string, licence: string, artist = 'A. Scanner') => ({
  title,
  imageinfo: [
    {
      url,
      descriptionurl: `https://commons.wikimedia.org/wiki/${title}`,
      thumburl: url.replace('.stl', '.stl.png'),
      mediatype: '3D',
      extmetadata: { LicenseShortName: { value: licence }, Artist: { value: artist } },
    },
  ],
});

function mockFetch(pages: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ query: { pages: Object.fromEntries(pages.map((p, i) => [i, p])) } }),
  })) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe('WikimediaProvider', () => {
  it('keeps open-licensed STL files and maps them to MuseumObjects', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        page('File:Venus figurine.stl', 'https://upload.wikimedia.org/x/Venus_figurine.stl', 'CC0'),
        page('File:Bust of someone.stl', 'https://upload.wikimedia.org/y/Bust.stl', 'CC BY-SA 4.0'),
      ]),
    );
    const out = await new WikimediaProvider().search({ text: 'figurine' });
    expect(out).toHaveLength(2);
    expect(out[0].modelFormat).toBe('stl');
    expect(out[0].modelUrl).toMatch(/\.stl$/);
    expect(out[0].provider).toBe('wikimedia');
    expect(out[0].curated).toBe(false);
    expect(out[0].sourceUrl).toContain('commons.wikimedia.org');
  });

  it('drops non-STL media and unclear / non-free licences', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        page('File:Photo.jpg', 'https://upload.wikimedia.org/z/Photo.jpg', 'CC0'),
        page('File:Model.stl', 'https://upload.wikimedia.org/w/Model.stl', 'All rights reserved'),
        page('File:Ok.stl', 'https://upload.wikimedia.org/w/Ok.stl', 'Public domain'),
      ]),
    );
    const out = await new WikimediaProvider().search({ text: 'x' });
    expect(out.map((o) => o.title)).toEqual(['Ok']);
  });

  it('throws on a non-ok response so the library can report it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch);
    await expect(new WikimediaProvider().search({ text: 'x' })).rejects.toThrow(/503/);
  });
});
