import { el, clear } from '../app/dom';
import { MuseumLibrary, CATEGORIES } from '../museum/library';
import { MuseumObject, CarvingCategory } from '../museum/types';

export interface LibraryCallbacks {
  onOpen: (obj: MuseumObject) => void;
  onUpload: (file: File) => void;
  onDemo: (id: string) => void;
}

export function renderLibrary(library: MuseumLibrary, cb: LibraryCallbacks): HTMLElement {
  const root = el('div', { class: 'library' });

  const hero = el('section', { class: 'hero' }, [
    el('h1', {}, ['Turn museum sculptures into carving projects.']),
    el('p', { class: 'hero__sub' }, [
      'Browse real Open Access 3D scans, drop one into a block of wood, and WhittleGuide works out the templates, depth maps and a safe step-by-step roughing sequence — all in your browser.',
    ]),
  ]);

  const searchRow = el('div', { class: 'searchbar' });
  const input = el('input', {
    type: 'search',
    placeholder: 'Search the museum collection…  (e.g. bust, Buddha, ritual, animal)',
    'aria-label': 'Search museum collection',
  }) as HTMLInputElement;
  const searchBtn = el('button', { class: 'btn btn--primary' }, ['Search']);
  searchRow.append(input, searchBtn);

  const chips = el('div', { class: 'chips' });
  let activeCategory: CarvingCategory | undefined;
  const allChip = el('button', { class: 'chip chip--on' }, ['All']);
  chips.append(allChip);
  const catChips: HTMLElement[] = [allChip];
  for (const c of CATEGORIES) {
    const chip = el('button', { class: 'chip' }, [c]);
    chip.addEventListener('click', () => {
      activeCategory = activeCategory === c ? undefined : c;
      catChips.forEach((x) => x.classList.remove('chip--on'));
      (activeCategory ? chip : allChip).classList.add('chip--on');
      run();
    });
    catChips.push(chip);
    chips.append(chip);
  }
  allChip.addEventListener('click', () => {
    activeCategory = undefined;
    catChips.forEach((x) => x.classList.remove('chip--on'));
    allChip.classList.add('chip--on');
    run();
  });

  const status = el('div', { class: 'library__status' });
  const grid = el('div', { class: 'cardgrid' });

  const uploadZone = el('section', { class: 'uploadzone' }, [
    el('div', { class: 'uploadzone__inner' }, [
      el('strong', {}, ['Or use your own model']),
      el('p', {}, ['.glb · .gltf · .obj · .stl · .ply — processed entirely on this device. Your file is never uploaded anywhere.']),
      (() => {
        const b = el('button', { class: 'btn' }, ['Choose a file…']);
        const fi = el('input', { type: 'file', accept: '.glb,.gltf,.obj,.stl,.ply', style: 'display:none' }) as HTMLInputElement;
        b.addEventListener('click', () => fi.click());
        fi.addEventListener('change', () => {
          if (fi.files?.[0]) cb.onUpload(fi.files[0]);
        });
        return el('div', {}, [b, fi]);
      })(),
    ]),
  ]);

  const demoRow = el('div', { class: 'demorow' }, [
    el('span', { class: 'muted' }, ['No connection, or just curious? ']),
    (() => {
      const b = el('button', { class: 'linkbtn' }, ['Open a built-in demo model →']);
      b.addEventListener('click', () => cb.onDemo('figure'));
      return b;
    })(),
  ]);

  root.append(hero, searchRow, chips, demoRow, status, grid, uploadZone);

  function card(obj: MuseumObject): HTMLElement {
    const media = el('div', { class: 'card__media' });
    if (obj.thumbnailUrl) {
      const img = el('img', { src: obj.thumbnailUrl, alt: obj.title, loading: 'lazy' }) as HTMLImageElement;
      img.addEventListener('error', () => {
        media.classList.add('card__media--empty');
        img.remove();
      });
      media.append(img);
    } else {
      media.classList.add('card__media--empty');
    }
    const stars = el('span', { class: 'stars', title: `Estimated difficulty ${obj.estimatedDifficulty}/5` }, [
      '★'.repeat(obj.estimatedDifficulty) + '☆'.repeat(5 - obj.estimatedDifficulty),
    ]);
    const btn = el('button', { class: 'btn btn--primary card__cta' }, ['Carve this →']);
    btn.addEventListener('click', () => cb.onOpen(obj));
    return el('article', { class: 'card' }, [
      media,
      el('div', { class: 'card__body' }, [
        el('h3', {}, [obj.title]),
        el('div', { class: 'card__meta' }, [
          obj.institution ? el('span', {}, [obj.institution]) : null,
          obj.period ? el('span', {}, ['· ' + obj.period]) : null,
        ]),
        el('div', { class: 'card__row' }, [
          stars,
          el('span', { class: `tag ${obj.curated ? 'tag--ok' : 'tag--warn'}` }, [obj.license.includes('CC0') ? 'CC0' : obj.curated ? obj.license : 'verify terms']),
        ]),
        obj.carvingNote ? el('p', { class: 'card__note' }, [obj.carvingNote]) : null,
        el('div', { class: 'card__row' }, [
          el('span', { class: 'pill' }, [obj.category]),
          obj.sourceUrl ? el('a', { class: 'card__src', href: obj.sourceUrl, target: '_blank', rel: 'noopener' }, ['source']) : null,
          btn,
        ]),
      ]),
    ]);
  }

  async function run() {
    clear(status);
    status.append(el('span', { class: 'spinner spinner--sm' }), ' Searching…');
    const { objects, errors } = await library.search({
      text: input.value,
      category: activeCategory,
      limit: 48,
    });
    clear(grid);
    for (const o of objects) grid.append(card(o));
    clear(status);
    const bits: (Node | string)[] = [`${objects.length} object${objects.length === 1 ? '' : 's'}`];
    if (objects.some((o) => o.curated)) bits.push(' · curated Smithsonian CC0 shown first');
    if (errors.length) {
      bits.push(
        el('span', { class: 'library__err' }, [
          ` · live search unavailable (${errors.join('; ')}) — showing the offline catalogue`,
        ]),
      );
    }
    status.append(...bits);
    if (objects.length === 0) {
      grid.append(el('p', { class: 'empty' }, ['No matches. Try a broader term, or upload your own model below.']));
    }
  }

  searchBtn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') run();
  });
  run();

  return root;
}
