import { el, clear, toast, fmtMm } from '../app/dom';
import { Viewer, ViewMode } from '../viewer/viewer';
import { LoadedModel } from '../viewer/loaders';
import type { NormalizeReport } from '../geometry/normalize';
import {
  Blank, Placement, defaultBlank, autoFit, placementMatrix, defaultPlacement, rotatedBoxSize,
} from '../geometry/blank';
import { applyMatrix4, multiply, boxSize, computeBounds, identity, Box3, Mat4, Vec3 } from '../geometry/mesh';
import { AnalysisClient, PreparedMesh } from '../workers/analysisClient';
import { AnalysisResult } from '../geometry/analysis';
import { renderPanel, PanelTab, stageRemovedMask } from './panels';
import { buildGuideHtml } from '../export/guide';

export interface ProjectSource {
  title: string;
  institution?: string;
  period?: string;
  license: string;
  sourceUrl?: string;
  provider?: string;
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'silhouette', label: 'Silhouette' },
  { id: 'depth', label: 'Depth' },
  { id: 'contours', label: 'Contours' },
  { id: 'sections', label: 'Sections' },
  { id: 'roughing', label: 'Roughing' },
  { id: 'guide', label: 'Guide / Print' },
];

// Voxel cells along the longest blank axis. The WASM kernel makes ~84 as cheap
// as ~50 was in pure JS; falls back gracefully if the kernel doesn't load.
const RESOLUTION = 84;

export class Workspace {
  readonly root: HTMLElement;
  private viewer!: Viewer;
  private client: AnalysisClient;
  private norm: { mesh: { positions: Float32Array }; bounds: Box3; matrix: number[]; report: NormalizeReport } | null = null;
  private source: ProjectSource;
  private loaded: LoadedModel;

  private blank: Blank = defaultBlank();
  private units: 'mm' | 'cm' = 'mm';
  private rotation: Vec3 = [0, 0, 0];
  private margin = 4;
  private userScale = 1;
  private placement: Placement = defaultPlacement();

  private analysis: AnalysisResult | null = null;
  private analyzing = false;
  private recomputeTimer = 0;

  private orientAggressive = false;
  private baseRot: Mat4 = identity();
  private oriented: { positions: Float32Array; bounds: Box3 } | null = null;
  private grainAxis: 0 | 1 | 2 = 1;
  private stageCount = 9;
  /** When set, analysis geometry is mirrored across this axis's mid-plane. */
  private symmetryAxis: 0 | 1 | 2 | null = null;
  private tab: PanelTab = 'silhouette';
  private stageIndex = 4;
  private contourInterval = 5;
  private showRoughCuts = false;
  private viewMode: ViewMode = 'blankModel';

  private panelHost!: HTMLElement;
  private statsHost!: HTMLElement;
  private viewerHost!: HTMLElement;

  constructor(loaded: LoadedModel, source: ProjectSource, client: AnalysisClient) {
    this.loaded = loaded;
    this.source = source;
    this.client = client;
    this.root = el('div', { class: 'workspace' });
    this.build();
  }

  private build() {
    // Viewer area
    this.viewerHost = el('div', { class: 'viewer' });
    const overlay = el('div', { class: 'viewer__overlay' });

    // Blank card
    const blankCard = el('div', { class: 'ctrlcard' }, [
      el('div', { class: 'ctrlcard__title' }, ['Wooden blank']),
      this.dimRow(),
      this.unitRow(),
      this.grainRow(),
      this.marginRow(),
      this.scaleRow(),
      el('div', { class: 'btnrow' }, [
        this.button('Auto-fit', () => { this.userScale = 1; this.applyPlacement(); this.recompute(); }),
        this.button('Swap W/D', () => { const b = this.blank; this.setBlank({ ...b, width: b.depth, depth: b.width }); }),
      ]),
    ]);

    const orientCard = el('div', { class: 'ctrlcard' }, [
      el('div', { class: 'ctrlcard__title' }, ['Orientation']),
      el('div', { class: 'btngrid' }, [
        this.button('Tip ⭯ X+', () => this.rotate(0, 90)),
        this.button('Tip ⭯ X−', () => this.rotate(0, -90)),
        this.button('Turn ⭯ Y+', () => this.rotate(1, 90)),
        this.button('Turn ⭯ Y−', () => this.rotate(1, -90)),
        this.button('Roll ⭯ Z+', () => this.rotate(2, 90)),
        this.button('Roll ⭯ Z−', () => this.rotate(2, -90)),
      ]),
      el('div', { class: 'btnrow' }, [
        this.button('Auto-orient', () => this.reprepare(!this.orientAggressive)),
        this.button('Best for carving', () => void this.findBestOrientation()),
      ]),
      el('div', { class: 'btnrow' }, [
        this.button('Centre & reset', () => { this.baseRot = identity(); this.rotation = [0, 0, 0]; this.userScale = 1; this.symmetryAxis = null; this.rebuildOriented(); this.applyPlacement(); this.recompute(); }),
        this.button('Reset camera', () => this.viewer.resetCamera()),
      ]),
      this.symmetryRow(),
    ]);

    const modeCard = el('div', { class: 'ctrlcard' }, [
      el('div', { class: 'ctrlcard__title' }, ['View']),
      this.modeRow(),
    ]);

    this.statsHost = el('div', { class: 'ctrlcard ctrlcard--stats' });

    overlay.append(blankCard, orientCard, modeCard, this.statsHost);
    this.viewerHost.append(overlay);

    // Tabs + panel
    const tabbar = el('div', { class: 'tabbar' });
    for (const t of TABS) {
      const b = el('button', { class: `tab ${t.id === this.tab ? 'tab--on' : ''}` }, [t.label]);
      b.addEventListener('click', () => {
        this.tab = t.id;
        tabbar.querySelectorAll('.tab').forEach((x) => x.classList.remove('tab--on'));
        b.classList.add('tab--on');
        this.syncViewerToTab();
        this.renderPanelArea();
      });
      tabbar.append(b);
    }
    this.panelHost = el('div', { class: 'panelhost' });

    this.root.append(this.viewerHost, tabbar, this.panelHost);

    // Instantiate viewer after host is in DOM-ish; caller appends root then calls mount()
  }

  async mount() {
    this.viewer = new Viewer(this.viewerHost);
    this.viewer.setModel(this.loaded.object);
    this.viewer.setBlank(this.blank);
    this.viewer.setGrainAxis(this.grainAxis);
    this.viewer.setMode(this.viewMode);
    this.viewer.resetCamera();
    await this.prepareMesh();
  }

  /** Re-run mesh preparation (used by the "Auto-orient" button). */
  private reprepare(aggressive: boolean) {
    this.orientAggressive = aggressive;
    this.rotation = [0, 0, 0];
    this.userScale = 1;
    void this.prepareMesh();
  }

  private async prepareMesh() {
    clear(this.panelHost);
    this.panelHost.append(
      el('div', { class: 'panel panel--loading' }, [
        el('span', { class: 'spinner' }),
        ` Preparing ${this.loaded.triangleCount.toLocaleString()}-triangle mesh (clean · decimate · orient)…`,
      ]),
    );
    try {
      const prep: PreparedMesh = await this.client.prepare(this.loaded.mesh.positions, {
        targetSize: 100,
        maxTriangles: 40000,
        autoOrient: true,
        orientAggressive: this.orientAggressive,
      });
      this.norm = { mesh: { positions: prep.positions }, bounds: prep.bounds, matrix: prep.matrix, report: prep.report };
    } catch (e) {
      toast(`Mesh preparation failed: ${(e as Error).message}`, 'error');
      return;
    }
    this.baseRot = identity();
    this.symmetryAxis = null;
    this.rebuildOriented();
    this.applyPlacement();
    this.recompute(true);
  }

  private async findBestOrientation() {
    if (!this.norm || !this.oriented) return;
    toast('Searching orientations…');
    try {
      const res = await this.client.bestOrientation(this.oriented.positions, this.blank);
      if (!res.changed) {
        toast('Current orientation already carves best.');
        return;
      }
      // Compose onto the current base rotation.
      this.baseRot = multiply(res.rotation, this.baseRot);
      this.rotation = [0, 0, 0];
      this.userScale = 1;
      this.rebuildOriented();
      this.applyPlacement();
      this.recompute(true);
      toast(
        `Re-oriented: undercuts ${(res.scores.undercut * 100).toFixed(0)}% → carve-friendly.`,
      );
    } catch (e) {
      toast(`Orientation search failed: ${(e as Error).message}`, 'error');
    }
  }

  private button(label: string, on: () => void): HTMLElement {
    const b = el('button', { class: 'btn btn--sm' }, [label]);
    b.addEventListener('click', on);
    return b;
  }

  private dimRow(): HTMLElement {
    const mk = (key: 'width' | 'height' | 'depth', label: string) => {
      const input = el('input', {
        type: 'number', min: '5', max: '600', step: '1', value: String(this.blank[key]), 'aria-label': label,
      }) as HTMLInputElement;
      input.dataset.key = key;
      input.addEventListener('change', () => {
        const mm = this.units === 'cm' ? parseFloat(input.value) * 10 : parseFloat(input.value);
        if (Number.isFinite(mm) && mm > 0) this.setBlank({ ...this.blank, [key]: mm });
      });
      return el('label', { class: 'dim' }, [el('span', {}, [label]), input]);
    };
    return el('div', { class: 'dimrow' }, [
      mk('width', 'W'), mk('height', 'H'), mk('depth', 'D'),
    ]);
  }

  private unitRow(): HTMLElement {
    const seg = el('div', { class: 'segmented segmented--sm' });
    for (const u of ['mm', 'cm'] as const) {
      const b = el('button', { class: `seg ${this.units === u ? 'seg--on' : ''}` }, [u]);
      b.addEventListener('click', () => {
        this.units = u;
        seg.querySelectorAll('.seg').forEach((x) => x.classList.remove('seg--on'));
        b.classList.add('seg--on');
        this.refreshDimInputs();
      });
      seg.append(b);
    }
    return el('div', { class: 'inline' }, [el('span', { class: 'lbl' }, ['Units']), seg]);
  }

  private marginRow(): HTMLElement {
    const val = el('span', { class: 'sliderval' }, [`${this.margin} mm`]);
    const s = el('input', { type: 'range', min: '0', max: '15', step: '0.5', value: String(this.margin) }) as HTMLInputElement;
    s.addEventListener('input', () => { this.margin = parseFloat(s.value); val.textContent = `${this.margin} mm`; this.applyPlacement(); });
    s.addEventListener('change', () => this.recompute());
    return el('div', { class: 'sliderrow' }, [el('span', { class: 'lbl' }, ['Fit margin']), s, val]);
  }

  private scaleRow(): HTMLElement {
    const val = el('span', { class: 'sliderval' }, ['100%']);
    const s = el('input', { type: 'range', min: '25', max: '100', step: '1', value: '100' }) as HTMLInputElement;
    s.addEventListener('input', () => { this.userScale = parseFloat(s.value) / 100; val.textContent = `${s.value}%`; this.applyPlacement(); });
    s.addEventListener('change', () => this.recompute());
    return el('div', { class: 'sliderrow' }, [el('span', { class: 'lbl' }, ['Scale']), s, val]);
  }

  private grainRow(): HTMLElement {
    const seg = el('div', { class: 'segmented segmented--sm' });
    (['W', 'H', 'D'] as const).forEach((label, axis) => {
      const b = el('button', { class: `seg ${this.grainAxis === axis ? 'seg--on' : ''}` }, [label]);
      b.addEventListener('click', () => {
        this.grainAxis = axis as 0 | 1 | 2;
        seg.querySelectorAll('.seg').forEach((x) => x.classList.remove('seg--on'));
        b.classList.add('seg--on');
        this.viewer?.setGrainAxis(this.grainAxis);
        this.recompute();
      });
      seg.append(b);
    });
    return el('div', { class: 'inline' }, [el('span', { class: 'lbl', title: 'Which blank axis the wood grain runs along' }, ['Grain along']), seg]);
  }

  private symmetryRow(): HTMLElement {
    const seg = el('div', { class: 'segmented segmented--sm' });
    const opts: [string, 0 | 1 | 2 | null][] = [['Off', null], ['L–R', 0], ['F–B', 2]];
    opts.forEach(([label, axis]) => {
      const b = el('button', { class: `seg ${this.symmetryAxis === axis ? 'seg--on' : ''}` }, [label]);
      b.addEventListener('click', () => {
        this.symmetryAxis = axis;
        seg.querySelectorAll('.seg').forEach((x) => x.classList.remove('seg--on'));
        b.classList.add('seg--on');
        this.recompute(true);
        if (axis !== null) toast('Analysis geometry mirrored — templates and stages are now symmetric. The raw 3-D model view is unchanged.', 'info');
      });
      seg.append(b);
    });
    return el('div', { class: 'inline' }, [
      el('span', { class: 'lbl', title: 'Mirror the scan across its mid-plane so templates and stages come out symmetric' }, ['Symmetry']),
      seg,
    ]);
  }

  private modeRow(): HTMLElement {
    const modes: [ViewMode, string][] = [
      ['model', 'Model'], ['blankModel', 'Blank + model'], ['stage', 'Current stage'],
      ['remove', 'Material to remove'], ['undercuts', 'Undercuts'], ['fragile', 'Fragile features'], ['wireframe', 'Wireframe'], ['section', 'Section'],
    ];
    const wrap = el('div', { class: 'modewrap' });
    for (const [m, label] of modes) {
      const b = el('button', { class: `chip chip--xs ${this.viewMode === m ? 'chip--on' : ''}` }, [label]);
      b.addEventListener('click', () => {
        this.viewMode = m;
        wrap.querySelectorAll('.chip').forEach((x) => x.classList.remove('chip--on'));
        b.classList.add('chip--on');
        this.viewer.setMode(m);
        if (m === 'stage' || m === 'remove') this.pushStageToViewer();
      });
      wrap.append(b);
    }
    const sec = el('input', { type: 'range', min: '0', max: '100', value: '50', class: 'sectionslider' }) as HTMLInputElement;
    sec.addEventListener('input', () => this.viewer.setSection(parseFloat(sec.value) / 100));
    wrap.append(sec);
    return wrap;
  }

  private refreshDimInputs() {
    this.root.querySelectorAll<HTMLInputElement>('.dimrow input').forEach((input) => {
      const key = input.dataset.key as 'width' | 'height' | 'depth';
      input.value = this.units === 'cm' ? (this.blank[key] / 10).toFixed(2) : String(Math.round(this.blank[key]));
    });
  }

  private rotate(axis: 0 | 1 | 2, deg: number) {
    this.rotation[axis] = (this.rotation[axis] + (deg * Math.PI) / 180) % (Math.PI * 2);
    this.userScale = 1;
    this.applyPlacement();
    this.recompute();
  }

  private setBlank(b: Blank) {
    this.blank = b;
    this.refreshDimInputs();
    this.viewer?.setBlank(b);
    this.applyPlacement();
    this.recompute();
  }

  private rebuildOriented() {
    if (!this.norm) return;
    const positions = applyMatrix4(this.norm.mesh, this.baseRot).positions;
    this.oriented = { positions, bounds: computeBounds({ positions }) };
  }

  /** Recompute the fitted placement and update the viewer transform + stats. */
  private applyPlacement() {
    if (!this.norm || !this.oriented) return;
    const fit = autoFit(this.oriented.bounds, this.blank, this.rotation, this.margin);
    this.placement = { translation: [0, 0, 0], rotation: this.rotation, scale: fit.placement.scale * this.userScale };
    const pm = placementMatrix(this.placement, this.oriented.bounds);
    if (this.viewer) this.viewer.setModelMatrix(multiply(multiply(pm, this.baseRot), this.norm.matrix));
    this.renderStats(fit.placement.scale);
  }

  private placedPositions(): Float32Array {
    const pm = placementMatrix(this.placement, this.oriented!.bounds);
    return applyMatrix4({ positions: this.oriented!.positions }, pm).positions;
  }

  private renderStats(autoScale: number) {
    if (!this.statsHost || !this.norm) return;
    clear(this.statsHost);
    const rot = rotatedBoxSize(this.oriented!.bounds, this.rotation).map((v) => v * this.placement.scale) as Vec3;
    const src = boxSize(this.oriented!.bounds);
    const rows: [string, string][] = [
      ['Blank', `${fmtMm(this.blank.width, this.units)} × ${fmtMm(this.blank.height, this.units)} × ${fmtMm(this.blank.depth, this.units)}`],
      ['Final model', `${rot.map((v) => fmtMm(v, this.units)).join(' × ')}`],
      ['Scale', `${(this.placement.scale).toFixed(3)}× (auto ${autoScale.toFixed(3)}×)`],
      ['Source mesh', `${this.loaded.triangleCount.toLocaleString()} tris → ${this.norm.report.outputTriangles.toLocaleString()} for analysis${this.norm.report.simplified ? ' (quadric)' : ''}`],
      ['Orientation', this.norm.report.reoriented ? this.norm.report.orientationNote : 'as supplied'],
      ['Engine', this.analysis ? (this.analysis.engine === 'wasm' ? 'WASM kernel' : 'JavaScript') : '—'],
    ];
    void src;
    const status = this.analyzing
      ? el('div', { class: 'kv' }, [el('span', { class: 'spinner spinner--sm' }), ' analysing…'])
      : this.analysis
        ? el('div', { class: 'kv' }, [el('span', { class: 'kv__k' }, ['Wood removed']), el('span', { class: 'kv__v' }, [`${(100 * (1 - this.analysis.solidVolumeCm3 / this.analysis.blankVolumeCm3)).toFixed(0)}%`])])
        : el('div', { class: 'kv' }, [el('span', { class: 'kv__k' }, ['Status']), el('span', { class: 'kv__v' }, ['ready'])]);
    this.statsHost.append(
      el('div', { class: 'ctrlcard__title' }, ['Dimensions']),
      ...rows.map(([k, v]) => el('div', { class: 'kv' }, [el('span', { class: 'kv__k' }, [k]), el('span', { class: 'kv__v' }, [v])])),
      status,
    );
  }

  private recompute(immediate = false) {
    if (!this.norm) return;
    window.clearTimeout(this.recomputeTimer);
    const go = async () => {
      if (!this.norm) return;
      this.analyzing = true;
      this.renderStats(autoFit(this.oriented!.bounds, this.blank, this.rotation, this.margin).placement.scale);
      try {
        const positions = this.placedPositions();
        const result = await this.client.run(positions, this.blank, {
          approxCells: RESOLUTION,
          contourIntervalMm: undefined,
          depthQuantiseMm: 1,
          grainAxis: this.grainAxis,
          stageCount: this.stageCount,
          symmetryAxis: this.symmetryAxis ?? undefined,
        });
        this.analysis = result;
        this.stageIndex = Math.min(this.stageIndex, result.stages.length - 1);
      } catch (e) {
        toast(`Analysis failed: ${(e as Error).message}`, 'error');
      } finally {
        this.analyzing = false;
        if (this.norm) this.renderStats(autoFit(this.oriented!.bounds, this.blank, this.rotation, this.margin).placement.scale);
        this.pushStageToViewer();
        this.renderPanelArea();
      }
    };
    if (immediate) void go();
    else this.recomputeTimer = window.setTimeout(go, 280);
  }

  private pushStageToViewer() {
    if (!this.viewer || !this.analysis) return;
    const dims = {
      nx: this.analysis.grid.nx, ny: this.analysis.grid.ny, nz: this.analysis.grid.nz,
      d: this.analysis.grid.d, origin: this.analysis.grid.origin,
    };
    const cur = this.analysis.stages[this.stageIndex];
    const prev = this.stageIndex > 0 ? this.analysis.stages[this.stageIndex - 1].data : null;
    this.viewer.setStage({ data: cur.data, removed: stageRemovedMask(prev, cur.data) }, dims);
    this.viewer.setUndercuts(this.analysis.undercuts.mask, dims);
    this.viewer.setFragility(this.analysis.fragility.mask, dims);
  }

  private syncViewerToTab() {
    if (this.tab === 'roughing') {
      this.viewMode = 'stage';
      this.viewer.setMode('stage');
      this.pushStageToViewer();
    } else if (this.viewMode === 'stage') {
      this.viewMode = 'blankModel';
      this.viewer.setMode('blankModel');
    }
  }

  private renderPanelArea() {
    clear(this.panelHost);
    if (!this.analysis) {
      this.panelHost.append(el('div', { class: 'panel panel--loading' }, [
        el('span', { class: 'spinner' }), ' Preparing the first analysis…',
      ]));
      return;
    }
    this.panelHost.append(
      renderPanel(this.tab, {
        analysis: this.analysis,
        title: this.source.title,
        contourInterval: this.contourInterval,
        stageIndex: this.stageIndex,
        stageCount: this.stageCount,
        showRoughCuts: this.showRoughCuts,
        onContourInterval: (mm) => { this.contourInterval = mm; this.renderPanelArea(); },
        onStage: (i) => { this.stageIndex = i; this.pushStageToViewer(); this.renderPanelArea(); },
        onStageCount: (n) => { this.stageCount = n; this.stageIndex = Math.min(this.stageIndex, n - 1); this.recompute(true); },
        onToggleRoughCuts: (v) => { this.showRoughCuts = v; this.renderPanelArea(); },
        onOpenGuide: () => this.openGuide(),
      }),
    );
  }

  private openGuide() {
    if (!this.analysis || !this.norm) return;
    const rot = rotatedBoxSize(this.oriented!.bounds, this.rotation).map((v) => v * this.placement.scale) as Vec3;
    const html = buildGuideHtml(
      {
        title: this.source.title,
        institution: this.source.institution,
        period: this.source.period,
        license: this.source.license,
        sourceUrl: this.source.sourceUrl,
        provider: this.source.provider,
        blank: this.blank,
        units: this.units,
        modelSizeMm: rot,
        snapshotDataUrl: this.safeSnapshot(),
        contourIntervalMm: this.contourInterval,
      },
      this.analysis,
    );
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const w = window.open(url, '_blank');
    if (!w) {
      toast('Pop-up blocked — allow pop-ups to open the printable guide.', 'error');
      URL.revokeObjectURL(url);
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  private safeSnapshot(): string | undefined {
    try {
      const prevMode = this.viewMode;
      this.viewer.setMode('blankModel');
      const url = this.viewer.snapshot();
      this.viewer.setMode(prevMode);
      return url;
    } catch {
      return undefined;
    }
  }

  destroy() {
    window.clearTimeout(this.recomputeTimer);
    this.viewer?.dispose();
  }

  // expose for keyboard shortcuts
  cycleStage(delta: number) {
    if (!this.analysis) return;
    this.stageIndex = Math.max(0, Math.min(this.analysis.stages.length - 1, this.stageIndex + delta));
    if (this.tab !== 'roughing') {
      this.tab = 'roughing';
      this.root.querySelectorAll('.tab').forEach((x, i) => x.classList.toggle('tab--on', TABS[i].id === 'roughing'));
      this.syncViewerToTab();
    }
    this.pushStageToViewer();
    this.renderPanelArea();
  }
}
