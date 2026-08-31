/**
 * Museum library: aggregates all enabled providers behind one API for the UI.
 */

import { MuseumObject, MuseumProvider, SearchQuery, CarvingCategory } from './types';
import { SmithsonianProvider } from './providers/smithsonian';
import { EuropeanaProvider } from './providers/europeana';

export const CATEGORIES: CarvingCategory[] = [
  'Figures', 'Busts', 'Sculpture', 'Ancient', 'Ritual', 'Animals', 'Vessels', 'Masks', 'Archaeology',
];

export class MuseumLibrary {
  private providers: MuseumProvider[];

  constructor(providers?: MuseumProvider[]) {
    this.providers = (providers ?? [new SmithsonianProvider(), new EuropeanaProvider()]).filter((p) =>
      p.isEnabled(),
    );
  }

  providerLabels(): { id: string; label: string }[] {
    return this.providers.map((p) => ({ id: p.id, label: p.label }));
  }

  /** Curated objects — synchronous, always available offline. */
  curated(): MuseumObject[] {
    return this.providers.flatMap((p) => p.curated());
  }

  /**
   * Search live, merged with matching curated objects. Never throws: a failing
   * provider is skipped and its curated entries still show.
   */
  async search(query: SearchQuery): Promise<{ objects: MuseumObject[]; errors: string[] }> {
    const errors: string[] = [];
    const text = query.text?.trim().toLowerCase() ?? '';

    const curatedMatches = this.curated().filter((o) => {
      const catOk = !query.category || o.category === query.category;
      const textOk =
        !text ||
        o.title.toLowerCase().includes(text) ||
        (o.institution ?? '').toLowerCase().includes(text) ||
        (o.carvingNote ?? '').toLowerCase().includes(text) ||
        o.category.toLowerCase().includes(text);
      return catOk && textOk;
    });

    const live = await Promise.all(
      this.providers.map(async (p) => {
        try {
          return await p.search(query);
        } catch (e) {
          errors.push(`${p.label}: ${(e as Error).message}`);
          return [] as MuseumObject[];
        }
      }),
    );

    const merged = new Map<string, MuseumObject>();
    for (const o of curatedMatches) merged.set(o.id, o);
    for (const o of live.flat()) if (!merged.has(o.id)) merged.set(o.id, o);

    const objects = [...merged.values()].sort((a, b) => {
      if (a.curated !== b.curated) return a.curated ? -1 : 1;
      return a.estimatedDifficulty - b.estimatedDifficulty;
    });
    return { objects, errors };
  }
}
