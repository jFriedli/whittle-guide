/**
 * Wikimedia Commons 3D provider — no API key, CORS-open.
 *
 * Commons hosts 3D models as STL files (namespace 6 / `filetype:3d`). Everything
 * on Commons is under a free licence by policy; we surface the specific licence
 * from the file's structured metadata (`extmetadata.LicenseShortName`) and the
 * uploader/author for attribution, and link back to the file page.
 *
 * API: https://commons.wikimedia.org/w/api.php
 *   action=query&generator=search&gsrsearch=<term> filetype:3d&gsrnamespace=6
 *   &prop=imageinfo&iiprop=url|extmetadata|mediatype&origin=*
 * The STL bytes live on upload.wikimedia.org, which also sends `ACAO: *`.
 *
 * There is no curated offline set — the provider contributes only live results,
 * clearly labelled with their licence.
 */

import { MuseumObject, MuseumProvider, SearchQuery, CarvingCategory } from '../types';

const API = 'https://commons.wikimedia.org/w/api.php';

/** Licences Commons allows that are genuinely fine to carve from and redistribute templates of. */
const OPEN_LICENCE = /^(cc0|public domain|cc[- ]by([- ]sa)?([- ]\d(\.\d)?)?|pdm)/i;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function categoryGuess(title: string): CarvingCategory {
  const t = title.toLowerCase();
  if (/bust|portrait|head/.test(t)) return 'Busts';
  if (/mask/.test(t)) return 'Masks';
  if (/vase|vessel|pot|amphora|jar|bowl|cup/.test(t)) return 'Vessels';
  if (/figure|statue|statuette|figurine|deity|god|goddess/.test(t)) return 'Figures';
  if (/bird|animal|horse|lion|cat|dog|elephant|fish|dragon/.test(t)) return 'Animals';
  if (/relief|fragment|tablet|inscription|tool|axe|point/.test(t)) return 'Archaeology';
  if (/ancient|roman|greek|egypt|maya|assyr|etruscan/.test(t)) return 'Ancient';
  return 'Sculpture';
}

interface CommonsPage {
  title: string;
  imageinfo?: {
    url: string;
    descriptionurl?: string;
    thumburl?: string;
    mediatype?: string;
    extmetadata?: Record<string, { value?: string } | undefined>;
  }[];
}

export class WikimediaProvider implements MuseumProvider {
  readonly id = 'wikimedia';
  readonly label = 'Wikimedia Commons';

  isEnabled(): boolean {
    return true;
  }

  curated(): MuseumObject[] {
    return [];
  }

  async search(query: SearchQuery): Promise<MuseumObject[]> {
    const term = query.text?.trim() || 'sculpture';
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      generator: 'search',
      gsrsearch: `${term} filetype:3d`,
      gsrnamespace: '6',
      gsrlimit: String(Math.min(40, query.limit ?? 30)),
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|mediatype',
      iiurlwidth: '320',
    });
    const res = await fetch(`${API}?${params}`);
    if (!res.ok) throw new Error(`Wikimedia Commons API ${res.status}`);
    const data = (await res.json()) as { query?: { pages?: Record<string, CommonsPage> } };

    const out: MuseumObject[] = [];
    for (const page of Object.values(data.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (!info?.url || !/\.stl(\?|$)/i.test(info.url)) continue;
      const meta = info.extmetadata ?? {};
      const licence = stripHtml(meta.LicenseShortName?.value ?? meta.UsageTerms?.value ?? '');
      if (!licence || !OPEN_LICENCE.test(licence)) continue;
      const artist = stripHtml(meta.Artist?.value ?? '');
      const name = page.title.replace(/^File:/, '').replace(/\.(stl)$/i, '');
      out.push({
        id: `wikimedia:${encodeURIComponent(page.title)}`,
        provider: 'wikimedia',
        providerId: page.title,
        title: name,
        institution: artist || 'Wikimedia Commons',
        modelUrl: info.url,
        modelFormat: 'stl',
        thumbnailUrl: info.thumburl,
        license: licence,
        sourceUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
        category: query.category ?? categoryGuess(name),
        estimatedDifficulty: 3,
        curated: false,
        carvingNote: 'Wikimedia Commons scan — confirm the licence on the file page before sharing derived templates.',
      });
    }
    return out;
  }
}
