/**
 * Build-time catalogue generator for the Smithsonian provider.
 *
 * The deployed static site must show real museum objects immediately, even when
 * the 3D API is unreachable at load time. This script resolves current
 * browser-ready GLB + preview URLs from the official Smithsonian 3D API
 * (https://3d-api.si.edu, no key required) for a hand-picked, carving-oriented
 * seed list and writes src/museum/catalogue.generated.json (committed to the repo
 * so runtime never depends on this).
 *
 *   npm run catalogue            # resolve URLs only
 *   npm run catalogue -- --enrich  # also verify CC0 via the Open Access API
 *                                  # (needs SI_API_KEY or falls back to DEMO_KEY,
 *                                  #  which is heavily rate-limited)
 *
 * Licence note: every seed below is published on 3d.si.edu as an Open Access
 * (CC0) 3D model; --enrich cross-checks metadata_usage.access against the Open
 * Access API. `sourceUrl` always points at the authoritative record.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../src/museum/catalogue.generated.json');
const API_KEY = process.env.SI_API_KEY || 'DEMO_KEY';
const ENRICH = process.argv.includes('--enrich');
const THREE_D = 'https://3d-api.si.edu/api/v1.0/content/file/search';
const OA = 'https://api.si.edu/openaccess/api/v1.0';

const SEEDS = [
  {
    uuid: '79da3e3f-3ad7-41de-8956-e891d88a3c5f',
    title: 'Colonoware Pot from Cooper River, Charleston County, SC',
    institution: 'National Museum of African American History and Culture',
    period: 'c. 1740–1780', category: 'Vessels', difficulty: 2,
    note: 'Round hand-built pot — near body-of-revolution, few undercuts. A great warm-up turning/whittling subject.',
    source: 'https://3d.si.edu/object/3d_package:79da3e3f-3ad7-41de-8956-e891d88a3c5f',
  },
  {
    uuid: 'c02c239d-5ebf-4a7a-a368-e2288bbf4b31',
    title: 'Abraham Lincoln Life Mask (Mills)',
    institution: 'National Portrait Gallery',
    period: '1865', category: 'Masks', difficulty: 2,
    note: 'Shallow face relief — ideal first relief-carving project; no undercuts.',
    source: 'https://3d.si.edu/object/3d_package:c02c239d-5ebf-4a7a-a368-e2288bbf4b31',
  },
  {
    uuid: '1f3700e8-6d01-4488-8ab9-ea14031ef641',
    title: 'Rutherford B. Hayes (plaster bust)',
    institution: 'National Portrait Gallery',
    period: '1877', category: 'Busts', difficulty: 3,
    note: 'Compact portrait bust — strong frontal features, minimal undercuts.',
    source: 'https://3d.si.edu/object/3d_package:1f3700e8-6d01-4488-8ab9-ea14031ef641',
  },
  {
    uuid: 'd825c526-69dd-472a-8d47-7da7fbe88fb7',
    title: 'Helen Ruthven Waterston',
    institution: 'Smithsonian American Art Museum',
    period: '1869', category: 'Busts', difficulty: 3,
    note: 'Child portrait bust with smooth, forgiving forms.',
    source: 'https://3d.si.edu/object/3d_package:d825c526-69dd-472a-8d47-7da7fbe88fb7',
  },
  {
    uuid: 'd8c642d6-4ebc-11ea-b77f-2e728ce88125',
    title: 'Abraham Lincoln (portrait bust)',
    institution: 'National Portrait Gallery',
    period: '1860s', category: 'Busts', difficulty: 3,
    note: 'Recognisable bearded profile — good practice for reading depth from contours.',
    source: 'https://3d.si.edu/object/3d_package:d8c642d6-4ebc-11ea-b77f-2e728ce88125',
  },
  {
    uuid: 'ff28cb3a-ad00-43b3-a928-fa61ab0a288f',
    title: 'George Washington (portrait bust)',
    institution: 'National Portrait Gallery',
    period: '18th–19th c.', category: 'Busts', difficulty: 3,
    note: 'Classic bust proportions; the tied hair is the only fiddly area.',
    source: 'https://3d.si.edu/object/3d_package:ff28cb3a-ad00-43b3-a928-fa61ab0a288f',
  },
  {
    uuid: '0dc68216-3651-44c7-99cf-18e5d4d1eb9f',
    title: 'Kneeling Winged Monster',
    institution: 'National Museum of Asian Art',
    period: 'Ancient Near East', category: 'Ritual', difficulty: 4,
    note: 'Compact ancient bronze — characterful, some wing undercuts.',
    source: 'https://3d.si.edu/object/3d_package:0dc68216-3651-44c7-99cf-18e5d4d1eb9f',
  },
  {
    uuid: 'd8c62be8-4ebc-11ea-b77f-2e728ce88125',
    title: 'Cosmic Buddha (Buddha draped in robes portraying the Realms of Desire)',
    institution: 'National Museum of Asian Art',
    period: '550–577 CE', category: 'Sculpture', difficulty: 4,
    note: 'Standing figure with deep drapery relief — a rewarding intermediate project.',
    source: 'https://asia.si.edu/object/F1923.15/',
  },
  {
    uuid: '88de08dd-b8ab-470a-b987-ed6fe35def04',
    title: 'Figure of a Dancer',
    institution: 'Smithsonian American Art Museum',
    period: '19th–20th c.', category: 'Figures', difficulty: 4,
    note: 'Dynamic standing pose; limbs create moderate undercuts.',
    source: 'https://3d.si.edu/object/3d_package:88de08dd-b8ab-470a-b987-ed6fe35def04',
  },
  {
    uuid: '8edffe56-c358-4c3a-a61f-019f615ccef0',
    title: 'Model of the Greek Slave',
    institution: 'Smithsonian American Art Museum',
    period: '1846', category: 'Figures', difficulty: 4,
    note: 'Full standing figure by Hiram Powers — a serious figure study.',
    source: 'https://3d.si.edu/object/3d_package:8edffe56-c358-4c3a-a61f-019f615ccef0',
  },
  {
    uuid: 'ce850625-2cf1-4c6f-9086-0d5845d9a664',
    title: 'Lidded Incense Burner (xianglu) with Geometric Decoration',
    institution: 'National Museum of Asian Art',
    period: 'Chinese', category: 'Vessels', difficulty: 3,
    note: 'Mountain-form vessel with landscape relief on a simple body.',
    source: 'https://3d.si.edu/object/3d_package:ce850625-2cf1-4c6f-9086-0d5845d9a664',
  },
  {
    uuid: 'd8c62f94-4ebc-11ea-b77f-2e728ce88125',
    title: 'Ritual Wine Container (fangyi) with taotie Masks',
    institution: 'National Museum of Asian Art',
    period: 'Shang dynasty', category: 'Ritual', difficulty: 4,
    note: 'Bold geometric bronze with a hipped-roof lid — strong straight-cut practice.',
    source: 'https://3d.si.edu/object/3d_package:d8c62f94-4ebc-11ea-b77f-2e728ce88125',
  },
  {
    uuid: 'd8c646aa-4ebc-11ea-b77f-2e728ce88125',
    title: 'Ritual Wine Ewer (gong) with taotie Masks and Animals',
    institution: 'National Museum of Asian Art',
    period: 'Shang dynasty', category: 'Ritual', difficulty: 4,
    note: 'Animal-shaped ancient bronze — the spout and handle are the tricky parts.',
    source: 'https://3d.si.edu/object/3d_package:d8c646aa-4ebc-11ea-b77f-2e728ce88125',
  },
  {
    uuid: '80a9e13c-8e58-4b74-8482-63fd5ee197d8',
    title: 'Andrew Jackson (equestrian, zinc reduction)',
    institution: 'Smithsonian American Art Museum',
    period: 'after 1852', category: 'Sculpture', difficulty: 5,
    note: 'Advanced: horse legs are fragile and there are deep undercuts under the belly.',
    source: 'https://3d.si.edu/object/3d_package:80a9e13c-8e58-4b74-8482-63fd5ee197d8',
  },
  {
    uuid: '789cf90a-4387-4ac1-9e96-c7d6a7b9d26f',
    title: 'George Washington (Greenough)',
    institution: 'National Museum of American History',
    period: '1840', category: 'Sculpture', difficulty: 5,
    note: 'Large seated figure, drapery-heavy, raised arm — advanced.',
    source: 'https://3d.si.edu/object/3d_package:789cf90a-4387-4ac1-9e96-c7d6a7b9d26f',
  },
  {
    uuid: '28663e98-595d-4994-bede-bd623252c82f',
    title: "The Fugitive's Story",
    institution: 'Smithsonian American Art Museum',
    period: '1869', category: 'Figures', difficulty: 5,
    note: 'Multi-figure narrative group by John Rogers — advanced, many undercuts.',
    source: 'https://3d.si.edu/object/3d_package:28663e98-595d-4994-bede-bd623252c82f',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function threeDFiles(uuid) {
  const data = await getJson(`${THREE_D}?model_url=3d_package:${uuid}&rows=40`);
  return (data.rows ?? []).map((r) => ({ ...r.content, title: r.title })).filter((c) => c && c.uri);
}

const pick = (files, type, quals) => {
  const of = files.filter((f) => f.file_type === type);
  for (const q of quals) {
    const hit = of.find((f) => f.quality === q);
    if (hit) return hit;
  }
  return of[0];
};

async function verifyCC0(title) {
  try {
    const q = encodeURIComponent(title.replace(/[()]/g, ''));
    const data = await getJson(`${OA}/search?q=${q}&rows=5&api_key=${API_KEY}`);
    const rows = data?.response?.rows ?? [];
    for (const r of rows) {
      const access = r.content?.descriptiveNonRepeating?.metadata_usage?.access;
      if (access) return access;
    }
  } catch (e) {
    console.warn(`    OA check failed (${e.message})`);
  }
  return null;
}

async function main() {
  const objects = [];
  for (const seed of SEEDS) {
    process.stdout.write(`• ${seed.title} … `);
    try {
      const files = await threeDFiles(seed.uuid);
      const model = pick(files, 'glb', ['Low', 'Medium', 'High']);
      const thumb = pick(files, 'jpg', ['Low', 'Medium', 'Thumb']);
      if (!model?.uri) { console.log('no GLB — skipped'); continue; }

      let license = 'CC0';
      if (ENRICH) {
        const access = await verifyCC0(seed.title);
        await sleep(2500);
        if (access && !/CC0/i.test(access)) { console.log(`licence ${access} — skipped`); continue; }
        if (access) license = access;
      }

      objects.push({
        id: `smithsonian:${seed.uuid}`,
        provider: 'smithsonian',
        providerId: `3d_package:${seed.uuid}`,
        title: seed.title,
        institution: seed.institution,
        period: seed.period,
        modelUrl: model.uri,
        modelFormat: 'glb',
        thumbnailUrl: thumb?.uri,
        license,
        sourceUrl: seed.source,
        category: seed.category,
        estimatedDifficulty: seed.difficulty,
        curated: true,
        carvingNote: seed.note,
      });
      console.log(`ok`);
    } catch (e) {
      console.log(`error: ${e.message}`);
    }
    await sleep(150);
  }

  objects.sort((a, b) => a.estimatedDifficulty - b.estimatedDifficulty || a.title.localeCompare(b.title));
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Smithsonian 3D API (https://3d-api.si.edu) + Smithsonian Open Access',
    licenceNote:
      'All objects are published on 3d.si.edu as Open Access / CC0. sourceUrl links the authoritative record; confirm reuse terms there.',
    objects,
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`\nWrote ${objects.length} objects → ${OUT}`);
}

main();
