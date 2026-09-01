import { el, download } from '../app/dom';
import { AnalysisResult } from '../geometry/analysis';
import { buildTemplateSvg, calibrationSvg } from '../export/svgTemplate';
import { depthToDataUrl, depthLegend } from './depthRaster';
import { ViewName } from '../geometry/projection';
import { horizontalSlice } from '../geometry/slice';

export type PanelTab = 'silhouette' | 'depth' | 'contours' | 'sections' | 'roughing' | 'guide';

export interface PanelContext {
  analysis: AnalysisResult;
  title: string;
  contourInterval: number;
  stageIndex: number;
  stageCount: number;
  showRoughCuts: boolean;
  onContourInterval: (mm: number) => void;
  onStage: (i: number) => void;
  onStageCount: (n: number) => void;
  onToggleRoughCuts: (v: boolean) => void;
  onOpenGuide: () => void;
}

function modal(content: HTMLElement) {
  const overlay = el('div', { class: 'modal' }, [
    el('div', { class: 'modal__box' }, [
      (() => {
        const x = el('button', { class: 'modal__close', 'aria-label': 'Close' }, ['✕']);
        x.addEventListener('click', () => overlay.remove());
        return x;
      })(),
      content,
    ]),
  ]);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
}

function svgEl(svg: string): HTMLElement {
  const wrap = el('div', { class: 'svgwrap', html: svg });
  return wrap;
}

function templateFigure(ctx: PanelContext, view: ViewName, withContours = false, withRoughing = false): HTMLElement {
  const a = ctx.analysis;
  const proj = a.projections.find((p) => p.view === view)!;
  const contours = withContours
    ? a.contours.find((c) => c.view === view && c.intervalMm === ctx.contourInterval)?.levels
    : undefined;
  const stageLines = withRoughing
    ? a.stageOutlines.find((s) => s.view === view)?.stages.map((s) => ({
        name: s.name,
        marginMm: s.marginMm,
        polylines: s.polylines,
      }))
    : undefined;
  const svg = buildTemplateSvg({
    view,
    widthMm: proj.widthMm,
    heightMm: proj.heightMm,
    outline: proj.outline,
    contours,
    stageLines,
    title: '',
    subtitle: `${proj.widthMm.toFixed(0)} × ${proj.heightMm.toFixed(0)} mm${withContours ? ` · ${ctx.contourInterval} mm contours` : ''}${withRoughing ? ' · roughing lines' : ''}`,
  });
  const fig = el('figure', { class: 'tplfig' }, [
    svgEl(svg),
    el('figcaption', {}, [
      `${view.toUpperCase()} · ${proj.widthMm.toFixed(0)}×${proj.heightMm.toFixed(0)} mm`,
      (() => {
        const dl = el('button', { class: 'linkbtn' }, ['SVG']);
        dl.addEventListener('click', () =>
          download(`whittleguide-${view}${withContours ? '-contours' : ''}${withRoughing ? '-roughing' : ''}.svg`, new Blob([svg], { type: 'image/svg+xml' })),
        );
        return dl;
      })(),
    ]),
  ]);
  fig.querySelector('.svgwrap')?.addEventListener('click', () => modal(svgEl(svg)));
  return fig;
}

export function renderPanel(tab: PanelTab, ctx: PanelContext): HTMLElement {
  const a = ctx.analysis;
  const root = el('div', { class: 'panel' });

  if (!a.stageInvariant.ok) {
    root.append(
      el('div', { class: 'banner banner--warn' }, [
        `Stage containment check reported: ${a.stageInvariant.violations.join('; ')}. Increase blank size or resolution.`,
      ]),
    );
  }

  if (tab === 'silhouette') {
    root.append(el('p', { class: 'panel__lead' }, [
      'True orthographic outlines of the positioned model — trace these straight onto the matching face of the wood. Every template prints 1:1.',
    ]));

    let roughing = false;
    const grid = el('div', { class: 'tplgrid' });
    const views = ['front', 'back', 'left', 'right', 'top', 'bottom'] as ViewName[];
    const roughingViews = new Set(a.stageOutlines.map((s) => s.view));
    const fillGrid = () => {
      grid.replaceChildren(...views.map((v) => templateFigure(ctx, v, false, roughing && roughingViews.has(v))));
    };

    const toggle = el('label', { class: 'switch' }, [
      (() => {
        const c = el('input', { type: 'checkbox' }) as HTMLInputElement;
        c.addEventListener('change', () => {
          roughing = c.checked;
          fillGrid();
        });
        return c;
      })(),
      el('span', {}, ['Show roughing cut-lines (block → coarse → near → final)']),
    ]);
    root.append(toggle);

    fillGrid();
    root.append(grid);
    const all = el('button', { class: 'btn' }, ['Download all 6 as SVG']);
    all.addEventListener('click', () => {
      for (const v of views) {
        const p = a.projections.find((x) => x.view === v)!;
        const stageLines = roughing
          ? a.stageOutlines.find((s) => s.view === v)?.stages.map((s) => ({ name: s.name, marginMm: s.marginMm, polylines: s.polylines }))
          : undefined;
        const svg = buildTemplateSvg({ view: v, widthMm: p.widthMm, heightMm: p.heightMm, outline: p.outline, stageLines, title: `${ctx.title} — ${v.toUpperCase()}` });
        download(`whittleguide-${v}${roughing ? '-roughing' : ''}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
      }
    });
    root.append(all);
  }

  if (tab === 'depth') {
    root.append(el('p', { class: 'panel__lead' }, [
      'How deep to carve at each point, measured inward from that face of the blank. Values are quantised to ' +
        `${a.depthMaps[0]?.stepMm ?? 1} mm — treat them as a guide, not a micrometer.`,
    ]));
    const grid = el('div', { class: 'depthgrid' });
    for (const d of a.depthMaps) {
      const url = depthToDataUrl(d, 2);
      const img = el('img', { src: url, alt: `${d.view} depth map`, class: 'depthimg' }) as HTMLImageElement;
      const readout = el('span', { class: 'depthreadout' }, ['hover the map']);
      img.addEventListener('mousemove', (ev) => {
        const r = img.getBoundingClientRect();
        const me = ev as MouseEvent;
        const cx = Math.floor(((me.clientX - r.left) / r.width) * d.cols);
        const cy = Math.floor((1 - (me.clientY - r.top) / r.height) * d.rows);
        if (cx < 0 || cy < 0 || cx >= d.cols || cy >= d.rows) return;
        const v = d.depth[cy * d.cols + cx];
        readout.textContent = v < 0 ? 'outside outline' : `${v.toFixed(0)} mm deep`;
      });
      const legend = el('div', { class: 'legend' },
        depthLegend(d.maxDepthMm, d.stepMm).map((s) =>
          el('span', { class: 'legend__item' }, [el('i', { style: `background:${s.css}` }), `${s.mm}`]),
        ),
      );
      grid.append(el('figure', { class: 'depthfig' }, [
        img,
        el('figcaption', {}, [`${d.view.toUpperCase()} · max ${d.maxDepthMm.toFixed(0)} mm · `, readout]),
        legend,
      ]));
    }
    root.append(grid);
  }

  if (tab === 'contours') {
    const sel = el('div', { class: 'segmented' });
    for (const mm of [2, 5, 10]) {
      const b = el('button', { class: `seg ${ctx.contourInterval === mm ? 'seg--on' : ''}` }, [`${mm} mm`]);
      b.addEventListener('click', () => ctx.onContourInterval(mm));
      sel.append(b);
    }
    root.append(
      el('div', { class: 'panel__toolbar' }, [el('span', {}, ['Contour interval']), sel]),
      el('p', { class: 'panel__lead' }, ['A topographic map of the sculpture from each side. Each line marks another step of depth from the face.']),
    );
    const grid = el('div', { class: 'tplgrid' });
    for (const v of ['front', 'back', 'left', 'right'] as ViewName[]) grid.append(templateFigure(ctx, v, true));
    root.append(grid);
  }

  if (tab === 'sections') {
    root.append(el('p', { class: 'panel__lead' }, [
      'Horizontal cross-sections of the finished form, bottom to top — the way carvers gauge a piece. Each is drawn at 1:1 on the blank’s top face (width × depth).',
    ]));
    const dims = {
      nx: a.grid.nx, ny: a.grid.ny, nz: a.grid.nz, d: a.grid.d, origin: a.grid.origin,
    };
    const finalData = a.stages[a.stages.length - 1].data;
    // Confine the slices to the model's own vertical span, not the whole blank.
    let jLo = dims.ny, jHi = -1;
    for (let j = 0; j < dims.ny; j++) {
      for (let k = 0; k < dims.nz && jHi < j; k++)
        for (let i = 0; i < dims.nx; i++)
          if (finalData[i + dims.nx * (j + dims.ny * k)]) { if (j < jLo) jLo = j; jHi = j; break; }
    }
    const span = Math.max(1, jHi - jLo);
    const fracs = [0.08, 0.24, 0.4, 0.56, 0.72, 0.9].map((t) => (jLo + t * span) / (dims.ny - 1));

    const grid = el('div', { class: 'tplgrid' });
    for (const f of fracs) {
      const s = horizontalSlice(finalData, dims, f);
      if (s.areaMm2 <= 0) continue;
      const w = s.extentMm[2] - s.extentMm[0];
      const dpt = s.extentMm[3] - s.extentMm[1];
      const svg = buildTemplateSvg({
        view: `${s.heightMm.toFixed(0)} mm up`,
        widthMm: s.widthMm,
        heightMm: s.depthMm,
        outline: s.polylines,
        title: '',
        subtitle: `at ${s.heightMm.toFixed(0)} mm · ${w.toFixed(0)} × ${dpt.toFixed(0)} mm · ${(s.areaMm2 / 100).toFixed(1)} cm²`,
      });
      const fig = el('figure', { class: 'tplfig' }, [
        svgEl(svg),
        el('figcaption', {}, [
          `${s.heightMm.toFixed(0)} mm up · ${w.toFixed(0)}×${dpt.toFixed(0)} mm`,
          (() => {
            const dl = el('button', { class: 'linkbtn' }, ['SVG']);
            dl.addEventListener('click', () => download(`whittleguide-section-${s.heightMm.toFixed(0)}mm.svg`, new Blob([svg], { type: 'image/svg+xml' })));
            return dl;
          })(),
        ]),
      ]);
      fig.querySelector('.svgwrap')?.addEventListener('click', () => modal(svgEl(svg)));
      grid.append(fig);
    }
    root.append(grid);
  }

  if (tab === 'roughing') {
    const stages = a.stages;
    const s = stages[ctx.stageIndex];
    const timeline = el('div', { class: 'timeline' });
    stages.forEach((st, i) => {
      const node = el('button', {
        class: `tl__node ${i === ctx.stageIndex ? 'tl__node--on' : ''} ${i === 0 ? 'tl__node--start' : ''} ${i === stages.length - 1 ? 'tl__node--end' : ''}`,
        title: st.name,
      }, [i === 0 ? 'Blank' : i === stages.length - 1 ? 'Final' : String(i)]);
      node.addEventListener('click', () => ctx.onStage(i));
      timeline.append(node);
    });
    const countSel = el('div', { class: 'segmented' });
    for (const n of [4, 6, 9]) {
      const b = el('button', { class: `seg ${ctx.stageCount === n ? 'seg--on' : ''}` }, [`${n}`]);
      b.addEventListener('click', () => ctx.onStageCount(n));
      countSel.append(b);
    }
    root.append(
      el('div', { class: 'panel__toolbar' }, [el('span', {}, ['Stages']), countSel]),
      el('div', { class: 'tl__labels' }, [el('span', {}, ['ROUGH']), el('span', {}, ['DETAIL'])]),
      timeline,
    );

    root.append(
      el('div', { class: 'stagecard' }, [
        el('h3', {}, [`Stage ${s.index} — ${s.name}`]),
        el('p', { class: 'instruction' }, [s.instruction]),
        el('div', { class: 'stagefacts' }, [
          fact('Safety margin', s.marginMm === Infinity ? '—' : `${s.marginMm.toFixed(1)} mm`),
          fact('Wood remaining', `${s.volumeCm3.toFixed(0)} cm³`),
          fact('Removed this stage', `${s.removedCm3.toFixed(0)} cm³ (${s.removedPct.toFixed(0)}%)`),
          fact('Total removed', `${s.cumulativeRemovedPct.toFixed(0)}%`),
        ]),
        el('p', { class: 'muted' }, [
          'Red = wood to take off in this step. The ghosted block is where you stop. Every stage is guaranteed to still contain the finished carving.',
        ]),
      ]),
    );

    const rc = el('div', { class: 'roughcuts' });
    const toggle = el('label', { class: 'switch' }, [
      (() => {
        const c = el('input', { type: 'checkbox' }) as HTMLInputElement;
        c.checked = ctx.showRoughCuts;
        c.addEventListener('change', () => ctx.onToggleRoughCuts(c.checked));
        return c;
      })(),
      ' Experimental rough cuts',
    ]);
    rc.append(toggle);
    if (ctx.showRoughCuts) {
      if (a.roughCuts.length === 0) {
        rc.append(el('p', { class: 'muted' }, ['No whole-slab straight cuts are safe for this model — the figure reaches every face.']));
      } else {
        const ul = el('ul', { class: 'cutlist' });
        for (const c of a.roughCuts) {
          ul.append(el('li', {}, [`${c.side.toUpperCase()}: ${c.note} ≈ ${c.approxVolumeCm3} cm³`]));
        }
        rc.append(ul);
      }
    }
    root.append(rc);
  }

  if (tab === 'guide') {
    const cav = a.carvability;
    root.append(
      el('div', { class: 'analysis' }, [
        el('h3', {}, ['Carving analysis']),
        el('div', { class: 'analysis__grid' }, [
          fact('Difficulty', `${cav.stars}`),
          fact('Suggested skill', cav.skillLevel),
          fact('Undercuts', `${cav.metrics.undercuts} (${Math.round(a.undercuts.fraction * 100)}% of surface — see the Undercuts view)`),
          fact('Thinnest feature', `${a.fragility.minThicknessMm} mm${a.fragility.crossGrainFraction > 0.05 ? ` · ${Math.round(a.fragility.crossGrainFraction * 100)}% across the grain` : ''} — see the Fragile features view`),
          fact('Thin features', `${cav.metrics.thinFeatures} (min ≈ ${cav.metrics.minFeatureMm} mm)`),
          fact('Silhouette complexity', cav.metrics.silhouetteComplexity),
          fact('Deep recesses', cav.metrics.deepRecesses),
          fact('Symmetry', cav.metrics.symmetry),
          fact('Excess material', cav.metrics.excessMaterial),
          fact('Separate parts', String(cav.metrics.disconnectedParts)),
        ]),
        ...cav.warnings.map((w) => el('div', { class: 'banner banner--warn' }, [w])),
        ...cav.notes.map((n) => el('div', { class: 'banner banner--note' }, [n])),
      ]),
    );

    const openBtn = el('button', { class: 'btn btn--primary' }, ['Open printable guide']);
    openBtn.addEventListener('click', ctx.onOpenGuide);
    root.append(
      el('div', { class: 'guidebox' }, [
        el('p', {}, [
          'The printable guide collects the project sheet, all templates, depth & contour maps and every carving stage into A4 pages with 1:1 scaling. Use your browser’s print dialog to print or "Save as PDF".',
        ]),
        openBtn,
        el('div', { class: 'calib' }, [el('strong', {}, ['Print calibration']), svgEl(calibrationSvg(50))]),
      ]),
    );
    root.append(
      el('p', { class: 'muted disclaimer' }, [
        'WhittleGuide provides geometry-based carving assistance — orthographic templates, depth fields and safe removal envelopes. It does not plan knife strokes, tool choice or grain-aware order of operations; that is a future goal.',
      ]),
    );
  }

  return root;
}

function fact(label: string, value: string): HTMLElement {
  return el('div', { class: 'kv' }, [el('span', { class: 'kv__k' }, [label]), el('span', { class: 'kv__v' }, [value])]);
}

export function stageRemovedMask(prev: Uint8Array | null, cur: Uint8Array): Uint8Array | null {
  if (!prev) return null;
  const out = new Uint8Array(cur.length);
  let any = 0;
  for (let i = 0; i < cur.length; i++) {
    if (prev[i] && !cur[i]) {
      out[i] = 1;
      any++;
    }
  }
  return any ? out : null;
}
