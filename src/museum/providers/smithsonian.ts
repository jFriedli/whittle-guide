/**
 * Smithsonian 3D provider.
 *
 * API: GET https://3d-api.si.edu/api/v1.0/content/file/search  (no key, CORS *)
 *   q, model_url, file_type(jpg|glb|ply|zip), file_quality(Low|Medium|High|Thumb…),
 *   model_type(glb|gltf|obj|stl…), owning_unit, start, rows(0..1000)
 * Response: { rows: [{ title, content: { uri, file_type, model_url, quality, … } }], rowCount }
 *
 * Curated objects come from the committed build-time catalogue
 * (catalogue.generated.json) so the library is never empty. Live search hits the
 * API directly; those results are marked with an unverified licence because the
 * 3D API does not return reuse terms (the Open Access API, which does, needs a
 * key and cannot be called from a static site).
 */

import { MuseumObject, MuseumProvider, SearchQuery, CarvingCategory } from '../types';
import generated from '../catalogue.generated.json';

const BASE = 'https://3d-api.si.edu/api/v1.0/content/file/search';

interface GeneratedObject {
  id: string;
  provider: string;
  providerId: string;
  title: string;
  institution?: string;
  period?: string;
  modelUrl: string;
  modelFormat: 'glb' | 'gltf';
  thumbnailUrl?: string;
  license: string;
  sourceUrl?: string;
  category: CarvingCategory;
  estimatedDifficulty: number;
  curated: boolean;
  carvingNote?: string;
}

const CURATED: MuseumObject[] = (generated.objects as GeneratedObject[]).map((o) => ({ ...o }));

function categoryGuess(title: string): CarvingCategory {
  const t = title.toLowerCase();
  if (/bust|portrait|head/.test(t)) return 'Busts';
  if (/mask/.test(t)) return 'Masks';
  if (/vase|vessel|pot|ewer|jar|bowl|cup|burner|container/.test(t)) return 'Vessels';
  if (/figure|statue|statuette|dancer|warrior|deity|god|goddess/.test(t)) return 'Figures';
  if (/ritual|shrine|reliquary|amulet/.test(t)) return 'Ritual';
  if (/bird|animal|horse|lion|cat|dog|elephant|fish|dragon|monster/.test(t)) return 'Animals';
  if (/tablet|fragment|tool|point|axe|arrow|shard/.test(t)) return 'Archaeology';
  if (/ancient|antiqu|roman|greek|egypt|maya|aztec/.test(t)) return 'Ancient';
  return 'Sculpture';
}

const CATEGORY_TERMS: Record<CarvingCategory, string> = {
  Figures: 'figure', Busts: 'bust', Sculpture: 'sculpture', Ancient: 'ancient',
  Ritual: 'ritual', Animals: 'animal', Vessels: 'vessel', Masks: 'mask',
  Archaeology: 'artifact', Other: '',
};

export class SmithsonianProvider implements MuseumProvider {
  readonly id = 'smithsonian';
  readonly label = 'Smithsonian 3D';

  isEnabled(): boolean {
    return true;
  }

  curated(): MuseumObject[] {
    return CURATED;
  }

  async search(query: SearchQuery): Promise<MuseumObject[]> {
    const term = (query.text?.trim() || (query.category ? CATEGORY_TERMS[query.category] : '') || 'sculpture');
    const params = new URLSearchParams({
      q: term,
      model_type: 'glb',
      file_quality: 'Low',
      rows: String(Math.min(60, query.limit ?? 40)),
    });
    const res = await fetch(`${BASE}?${params}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Smithsonian API ${res.status}`);
    const data = (await res.json()) as {
      rows?: { title?: string; content?: Record<string, unknown> }[];
    };

    const seen = new Set(CURATED.map((c) => c.providerId));
    const out: MuseumObject[] = [];
    for (const row of data.rows ?? []) {
      const c = row.content ?? {};
      const uri = c.uri as string | undefined;
      const modelUrl = (c.model_url as string | undefined) ?? '';
      if (!uri || !uri.endsWith('.glb') || !modelUrl) continue;
      if (seen.has(modelUrl)) continue;
      seen.add(modelUrl);
      const title = (row.title || 'Untitled').replace(/<[^>]+>/g, '').trim();
      const uuid = modelUrl.replace('3d_package:', '');
      out.push({
        id: `smithsonian:${uuid}`,
        provider: 'smithsonian',
        providerId: modelUrl,
        title,
        institution: 'Smithsonian Institution',
        modelUrl: uri,
        modelFormat: 'glb',
        thumbnailUrl: `https://3d-api.si.edu/content/document/${modelUrl}/scene-image-thumb.jpg`,
        license: 'Smithsonian 3D — verify reuse terms at si.edu',
        sourceUrl: `https://3d.si.edu/object/${modelUrl}`,
        category: query.category ?? categoryGuess(title),
        estimatedDifficulty: 3,
        curated: false,
        carvingNote: undefined,
      });
    }
    return out;
  }
}
