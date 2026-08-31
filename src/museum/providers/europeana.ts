/**
 * Europeana provider — OPTIONAL, disabled by default.
 *
 * Europeana's Search API (https://api.europeana.eu/record/v2/search.json) and
 * Record API require a personal `wskey` API key. That key cannot be safely
 * embedded in a public static site, so this provider is only active when a key
 * is supplied at build time via the `VITE_EUROPEANA_KEY` environment variable
 * (e.g. in an untracked .env.local, or a GitHub Actions secret).
 *
 * To enable it later:
 *   1. Request a free key at https://pro.europeana.eu/pages/get-api-keys
 *   2. Add `VITE_EUROPEANA_KEY=xxxx` to `.env.local` (dev) or as a repository
 *      secret wired into the deploy workflow (prod).
 *   3. Rebuild. The provider then appears in the library automatically.
 *
 * The app is fully functional without Europeana.
 *
 * Implementation notes: we query for items with a downloadable 3D model
 * (`TYPE:3D` + `MIME_TYPE` gltf/glb) and open licences (`RIGHTS` CC0 / public
 * domain), then use `edmIsShownBy` as the model URL. Because many Europeana 3D
 * assets are hosted off-CORS or as Sketchfab embeds rather than raw glTF, we
 * keep only results whose media URL is a direct .glb/.gltf.
 */

import { MuseumObject, MuseumProvider, SearchQuery, CarvingCategory } from '../types';

const KEY = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_EUROPEANA_KEY;
const SEARCH = 'https://api.europeana.eu/record/v2/search.json';

const OPEN_RIGHTS = /creativecommons\.org\/(publicdomain\/(zero|mark)|licenses\/by(-sa)?\/)/i;

export class EuropeanaProvider implements MuseumProvider {
  readonly id = 'europeana';
  readonly label = 'Europeana';

  isEnabled(): boolean {
    return typeof KEY === 'string' && KEY.length > 0;
  }

  curated(): MuseumObject[] {
    return [];
  }

  async search(query: SearchQuery): Promise<MuseumObject[]> {
    if (!this.isEnabled()) return [];
    const term = query.text?.trim() || 'sculpture';
    const params = new URLSearchParams({
      wskey: KEY as string,
      query: `${term} AND TYPE:3D`,
      qf: 'MIME_TYPE:(model/gltf-binary OR model/gltf+json)',
      reusability: 'open',
      rows: String(Math.min(40, query.limit ?? 24)),
      profile: 'rich',
    });
    const res = await fetch(`${SEARCH}?${params}`);
    if (!res.ok) throw new Error(`Europeana API ${res.status}`);
    const data = (await res.json()) as { items?: EuropeanaItem[] };

    const out: MuseumObject[] = [];
    for (const item of data.items ?? []) {
      const media = (item.edmIsShownBy ?? [])[0];
      if (!media || !/\.(glb|gltf)(\?|$)/i.test(media)) continue;
      const rights = (item.rights ?? [])[0] ?? '';
      if (!OPEN_RIGHTS.test(rights)) continue;
      out.push({
        id: `europeana:${item.id}`,
        provider: 'europeana',
        providerId: item.id,
        title: (item.title ?? ['Untitled'])[0],
        institution: (item.dataProvider ?? [])[0],
        period: (item.year ?? [])[0],
        modelUrl: media,
        modelFormat: /\.glb(\?|$)/i.test(media) ? 'glb' : 'gltf',
        thumbnailUrl: item.edmPreview?.[0],
        license: rights.replace('http://creativecommons.org/', 'CC ').replace(/\/$/, ''),
        sourceUrl: (item.edmIsShownAt ?? [])[0] ?? `https://www.europeana.eu/item${item.id}`,
        category: (query.category ?? 'Sculpture') as CarvingCategory,
        estimatedDifficulty: 3,
        curated: false,
      });
    }
    return out;
  }
}

interface EuropeanaItem {
  id: string;
  title?: string[];
  dataProvider?: string[];
  year?: string[];
  edmIsShownBy?: string[];
  edmIsShownAt?: string[];
  edmPreview?: string[];
  rights?: string[];
}
