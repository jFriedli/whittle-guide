import { el, clear, toast } from './dom';
import { MuseumLibrary } from '../museum/library';
import { MuseumObject } from '../museum/types';
import { renderLibrary } from '../components/library';
import { Workspace, ProjectSource } from '../components/workspace';
import { AnalysisClient } from '../workers/analysisClient';
import { loadModelFromFile, loadModelFromUrl, LoadedModel } from '../viewer/loaders';
import { demoModel } from '../viewer/demo';

type Screen = 'home' | 'loading' | 'workspace' | 'about';

export class App {
  private root: HTMLElement;
  private main: HTMLElement;
  private library = new MuseumLibrary();
  private client = new AnalysisClient();
  private workspace: Workspace | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.main = el('main', { class: 'main' });
    this.root.append(this.topbar(), this.main);
    this.show('home');
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private topbar(): HTMLElement {
    const brand = el('button', { class: 'brand' }, [
      el('span', { class: 'brand__mark' }, ['◭']),
      el('span', {}, ['WhittleGuide']),
    ]);
    brand.addEventListener('click', () => this.show('home'));

    const nav = el('nav', { class: 'nav' }, [
      this.navBtn('Museum Library', () => this.show('home')),
      this.navBtn('Upload', () => this.pickFile()),
      this.navBtn('About', () => this.show('about')),
      el('a', { class: 'nav__link', href: 'https://github.com/jFriedli/whittle-guide', target: '_blank', rel: 'noopener' }, ['GitHub']),
    ]);
    return el('header', { class: 'topbar' }, [brand, nav]);
  }

  private navBtn(label: string, on: () => void): HTMLElement {
    const b = el('button', { class: 'nav__btn' }, [label]);
    b.addEventListener('click', on);
    return b;
  }

  private show(screen: Screen) {
    clear(this.main);
    if (screen !== 'workspace') {
      this.workspace?.destroy();
      this.workspace = null;
    }
    if (screen === 'home') {
      this.main.append(
        renderLibrary(this.library, {
          onOpen: (o) => this.openMuseum(o),
          onUpload: (f) => this.openUpload(f),
          onDemo: (id) => this.openDemo(id),
        }),
      );
      this.main.append(this.footer());
    } else if (screen === 'about') {
      this.main.append(this.about());
    } else if (screen === 'loading') {
      this.main.append(
        el('div', { class: 'bigloader' }, [el('span', { class: 'spinner spinner--lg' }), el('p', {}, ['Loading model…'])]),
      );
    }
  }

  private pickFile() {
    const fi = el('input', { type: 'file', accept: '.glb,.gltf,.obj,.stl', style: 'display:none' }) as HTMLInputElement;
    fi.addEventListener('change', () => {
      if (fi.files?.[0]) this.openUpload(fi.files[0]);
    });
    document.body.append(fi);
    fi.click();
    fi.remove();
  }

  private async openMuseum(obj: MuseumObject) {
    this.show('loading');
    try {
      const loaded = await loadModelFromUrl(obj.modelUrl, obj.modelFormat);
      const source: ProjectSource = {
        title: obj.title,
        institution: obj.institution,
        period: obj.period,
        license: obj.license,
        sourceUrl: obj.sourceUrl,
        provider: obj.provider,
      };
      this.enterWorkspace(loaded, source);
    } catch (e) {
      const msg = (e as Error).message;
      const networkish = /failed|fetch|network|load|cors|blocked|\b\d{3}\b/i.test(msg);
      this.showLoadError(obj, networkish ? msg : msg);
    }
  }

  private showLoadError(obj: MuseumObject, detail: string) {
    clear(this.main);
    this.main.append(
      el('div', { class: 'loaderror' }, [
        el('h2', {}, [`Couldn't load “${obj.title}”`]),
        el('p', {}, [detail]),
        el('p', { class: 'muted' }, [
          'The model file is fetched directly from ',
          el('a', { href: obj.sourceUrl ?? 'https://3d.si.edu', target: '_blank', rel: 'noopener' }, ['the museum']),
          '. This usually means a temporary network problem or that your connection blocks the request. The rest of WhittleGuide works offline.',
        ]),
        el('div', { class: 'btnrow' }, [
          (() => { const b = el('button', { class: 'btn btn--primary' }, ['Try again']); b.addEventListener('click', () => this.openMuseum(obj)); return b; })(),
          (() => { const b = el('button', { class: 'btn' }, ['Open a demo model']); b.addEventListener('click', () => this.openDemo('figure')); return b; })(),
          (() => { const b = el('button', { class: 'btn' }, ['Upload a file']); b.addEventListener('click', () => this.pickFile()); return b; })(),
          (() => { const b = el('button', { class: 'btn' }, ['Back to library']); b.addEventListener('click', () => this.show('home')); return b; })(),
        ]),
      ]),
    );
  }

  private openDemo(id: string) {
    clear(this.main);
    this.workspace?.destroy();
    const loaded = demoModel(id);
    this.enterWorkspace(loaded, {
      title: id === 'bird' ? 'Perched bird (demo)' : 'Standing figure (demo)',
      license: 'Synthetic demo model — public domain',
      provider: 'WhittleGuide demo',
    });
  }

  private async openUpload(file: File) {
    this.show('loading');
    try {
      const loaded = await loadModelFromFile(file);
      this.enterWorkspace(loaded, {
        title: file.name.replace(/\.[^.]+$/, ''),
        license: 'Your file — kept on this device',
        provider: 'Local upload',
      });
    } catch (e) {
      toast((e as Error).message, 'error');
      this.show('home');
    }
  }

  private enterWorkspace(loaded: LoadedModel, source: ProjectSource) {
    clear(this.main);
    this.workspace = new Workspace(loaded, source, this.client);
    this.main.append(this.workspace.root);
    this.workspace.mount();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.workspace) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'ArrowRight' || e.key === ']') this.workspace.cycleStage(1);
    if (e.key === 'ArrowLeft' || e.key === '[') this.workspace.cycleStage(-1);
  }

  private footer(): HTMLElement {
    return el('footer', { class: 'sitefoot' }, [
      el('p', {}, [
        '3D models courtesy of ',
        el('a', { href: 'https://3d.si.edu', target: '_blank', rel: 'noopener' }, ['Smithsonian Open Access']),
        ' (CC0). WhittleGuide is open source and runs entirely in your browser — uploaded models never leave your device.',
      ]),
    ]);
  }

  private about(): HTMLElement {
    return el('div', { class: 'about' }, [
      el('h1', {}, ['About WhittleGuide']),
      el('p', {}, [
        'WhittleGuide is a browser tool that turns a 3D model — a museum sculpture or your own file — into a practical hand-carving guide: orthographic templates, depth maps, topographic contour maps and a safe, progressive roughing sequence for a rectangular wooden blank. Think of it as an early "slicer" for subtractive hand carving.',
      ]),
      el('h2', {}, ['What it does today']),
      el('ul', {}, [
        el('li', {}, ['Browse real Smithsonian Open Access 3D scans, or load your own .glb / .gltf / .obj / .stl.']),
        el('li', {}, ['Place and scale the model inside a wooden blank with real millimetre dimensions and auto-fit.']),
        el('li', {}, ['Generate 1:1 printable SVG templates for all six faces.']),
        el('li', {}, ['Compute orthographic depth maps and 2 / 5 / 10 mm contour maps.']),
        el('li', {}, ['Build progressive carving stages with a guaranteed "never cut into the final model" invariant.']),
        el('li', {}, ['Score carvability (undercuts, thin features, symmetry, …) and flag unsuitable models.']),
        el('li', {}, ['Export a complete printable guide with a print-calibration square.']),
      ]),
      el('h2', {}, ['What it does NOT do (yet)']),
      el('p', {}, [
        'This is geometry-based assistance. It does not plan individual knife strokes, choose gouges, reason about wood grain, or work out a grain-aware order of operations. Treat the generated cuts and stages as guidance, not instructions — and always carve within your own judgement.',
      ]),
      el('h2', {}, ['Privacy']),
      el('p', {}, ['Everything runs client-side. Museum models are fetched directly from the Smithsonian; uploaded files are read in-page and never transmitted.']),
      el('p', {}, [el('a', { class: 'btn', href: 'https://github.com/jFriedli/whittle-guide', target: '_blank', rel: 'noopener' }, ['Source & documentation on GitHub'])]),
    ]);
  }
}
