/**
 * Museum provider abstraction.
 *
 * A provider turns an external Open Access 3D collection into a uniform list of
 * `MuseumObject`s that the app can browse and load. New providers (Europeana,
 * etc.) implement the same interface without the rest of the app changing.
 */

export type CarvingCategory =
  | 'Figures'
  | 'Busts'
  | 'Sculpture'
  | 'Ancient'
  | 'Ritual'
  | 'Animals'
  | 'Vessels'
  | 'Masks'
  | 'Archaeology'
  | 'Other';

export interface MuseumObject {
  /** Stable id, unique within the app (`<provider>:<providerId>`). */
  id: string;
  provider: string;
  providerId: string;
  title: string;
  /** Owning institution / unit, when known. */
  institution?: string;
  /** Approximate date or period, free text. */
  period?: string;
  /** Direct URL to a browser-friendly GLB/glTF (low/medium resolution). */
  modelUrl: string;
  modelFormat: 'glb' | 'gltf';
  /** Preview image URL, when known. */
  thumbnailUrl?: string;
  /** Human-readable reuse terms, e.g. "CC0". */
  license: string;
  /** Canonical landing page for attribution. */
  sourceUrl?: string;
  category: CarvingCategory;
  /** 1–5, rough a-priori carving difficulty (refined once the mesh is analysed). */
  estimatedDifficulty: number;
  /** True for the hand-checked offline catalogue that always works. */
  curated: boolean;
  /** Short reason this object suits (or doesn't suit) carving. */
  carvingNote?: string;
}

export interface SearchQuery {
  text?: string;
  category?: CarvingCategory;
  limit?: number;
}

export interface MuseumProvider {
  readonly id: string;
  readonly label: string;
  /** Whether the provider is usable in the current build/runtime. */
  isEnabled(): boolean;
  /** Curated, always-available objects (no network). */
  curated(): MuseumObject[];
  /** Live search against the provider's API. May reject / return []. */
  search(query: SearchQuery): Promise<MuseumObject[]>;
}
