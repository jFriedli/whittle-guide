/**
 * Printable carving guide — a self-contained HTML document with A4 print styling
 * and 1:1 SVG templates. Opened in a new tab; the user prints or saves as PDF.
 */

import { AnalysisResult } from '../geometry/analysis';
import { Blank } from '../geometry/blank';
import { buildTemplateSvg, calibrationSvg } from './svgTemplate';
import { ViewName } from '../geometry/projection';
import { depthToDataUrl } from '../components/depthRaster';

export interface GuideProject {
  title: string;
  institution?: string;
  period?: string;
  license: string;
  sourceUrl?: string;
  provider?: string;
  blank: Blank;
  units: 'mm' | 'cm';
  modelSizeMm: [number, number, number];
  snapshotDataUrl?: string;
  contourIntervalMm: number;
}

const TEMPLATE_VIEWS: ViewName[] = ['front', 'back', 'left', 'right', 'top'];

export function buildGuideHtml(project: GuideProject, analysis: AnalysisResult): string {
  const p = analysis.projections;
  const byView = (v: string) => p.find((x) => x.view === v)!;

  const templates = TEMPLATE_VIEWS.map((v) => {
    const proj = byView(v);
    const svg = buildTemplateSvg({
      view: v,
      widthMm: proj.widthMm,
      heightMm: proj.heightMm,
      outline: proj.outline,
      title: `${project.title} — ${v.toUpperCase()}`,
      subtitle: `${proj.widthMm.toFixed(0)} × ${proj.heightMm.toFixed(0)} mm · print at 100% (Actual Size)`,
    });
    return `<section class="page"><h2>Template — ${v.toUpperCase()}</h2>${svg}</section>`;
  }).join('\n');

  const contourSections = analysis.contours
    .filter((c) => c.intervalMm === project.contourIntervalMm && (c.view === 'front' || c.view === 'left'))
    .map((c) => {
      const proj = byView(c.view);
      const svg = buildTemplateSvg({
        view: `${c.view} — contours ${c.intervalMm}mm`,
        widthMm: c.widthMm,
        heightMm: c.heightMm,
        outline: proj.outline,
        contours: c.levels,
        title: `${project.title} — ${c.view.toUpperCase()} depth contours (${c.intervalMm} mm)`,
        subtitle: `Each line is ${c.intervalMm} mm deeper than the last, measured from the ${c.view} face.`,
      });
      return `<section class="page"><h2>Depth contours — ${c.view.toUpperCase()}</h2>${svg}</section>`;
    })
    .join('\n');

  const depthSections = analysis.depthMaps
    .filter((d) => d.view === 'front' || d.view === 'left')
    .map((d) => {
      const url = depthToDataUrl(d, 6);
      return `<div class="depthfig">
        <img src="${url}" alt="${d.view} depth map"/>
        <p>${d.view.toUpperCase()} — max depth ${d.maxDepthMm.toFixed(0)} mm, values quantised to ${d.stepMm} mm.</p>
      </div>`;
    })
    .join('\n');

  const stageRows = analysis.stages
    .map((s) => {
      const proj = byView('front');
      let svg = '';
      if (s.index > 0 && s.index < analysis.stages.length - 1) {
        svg = buildTemplateSvg({
          view: `stage ${s.index}`,
          widthMm: proj.widthMm,
          heightMm: proj.heightMm,
          outline: proj.outline,
          title: `Stage ${s.index}: ${s.name}`,
          subtitle: `Aim to stay ~${s.marginMm.toFixed(1)} mm outside the final outline.`,
        });
      }
      return `<section class="page stage">
        <h2>Stage ${s.index} — ${s.name}</h2>
        <p class="instruction">${s.instruction}</p>
        <ul class="facts">
          <li>Safety margin: ${s.marginMm === Infinity ? '—' : s.marginMm.toFixed(1) + ' mm'}</li>
          <li>Wood remaining: ${s.volumeCm3.toFixed(0)} cm³</li>
          <li>Removed this stage: ${s.removedCm3.toFixed(0)} cm³ (${s.removedPct.toFixed(0)}%)</li>
          <li>Total removed so far: ${s.cumulativeRemovedPct.toFixed(0)}%</li>
        </ul>
        ${svg}
      </section>`;
    })
    .join('\n');

  const cav = analysis.carvability;
  const warnings = cav.warnings.length
    ? `<div class="warn"><h3>Watch out</h3><ul>${cav.warnings.map((w) => `<li>${w}</li>`).join('')}</ul></div>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>WhittleGuide — ${escapeHtml(project.title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #241c12; margin: 0; background: #f4efe6; }
  .sheet { max-width: 210mm; margin: 0 auto; padding: 16mm 14mm; background: #fff; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 16px; border-bottom: 2px solid #c8a06a; padding-bottom: 3px; margin: 0 0 10px; }
  h3 { font-size: 13px; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
  svg { max-width: 100%; height: auto; border: 1px solid #e6ddcc; background: #fff; }
  .page { page-break-inside: avoid; margin-bottom: 14mm; }
  .meta td { padding: 2px 10px 2px 0; vertical-align: top; }
  .meta td:first-child { color: #7a6a52; white-space: nowrap; }
  .instruction { font-size: 15px; background: #f7f1e6; border-left: 3px solid #c8a06a; padding: 8px 10px; }
  .facts { columns: 2; font-size: 12px; color: #4a3d29; padding-left: 16px; }
  .warn { background: #fbeceb; border: 1px solid #e0a19c; border-radius: 6px; padding: 8px 12px; }
  .warn li { margin: 4px 0; }
  .depthfig { display: inline-block; width: 48%; margin: 1%; vertical-align: top; font-size: 11px; }
  .depthfig img { width: 100%; image-rendering: pixelated; border: 1px solid #ddd; }
  .safety { font-size: 12px; color: #4a3d29; background: #f2ede2; padding: 10px 12px; border-radius: 6px; }
  .snapshot { max-width: 90mm; border: 1px solid #ddd; border-radius: 6px; }
  @media print {
    body { background: #fff; }
    .sheet { max-width: none; padding: 0; }
    .page { margin-bottom: 0; }
    section.page { page-break-after: always; }
    .no-print { display: none; }
  }
</style></head><body><div class="sheet">

<section class="page">
  <h1>WhittleGuide</h1>
  <p class="no-print" style="color:#7a6a52">Print at <strong>100% / Actual Size</strong>. Check the calibration square below before cutting.</p>
  <h2>${escapeHtml(project.title)}</h2>
  ${project.snapshotDataUrl ? `<img class="snapshot" src="${project.snapshotDataUrl}" alt="model preview"/>` : ''}
  <table class="meta">
    <tr><td>Source</td><td>${escapeHtml(project.institution ?? project.provider ?? 'Uploaded model')}${project.period ? ` · ${escapeHtml(project.period)}` : ''}</td></tr>
    <tr><td>Licence</td><td>${escapeHtml(project.license)}${project.sourceUrl ? ` · <a href="${project.sourceUrl}">record</a>` : ''}</td></tr>
    <tr><td>Blank</td><td>${project.blank.width} × ${project.blank.height} × ${project.blank.depth} mm</td></tr>
    <tr><td>Final size</td><td>${project.modelSizeMm.map((n) => n.toFixed(0)).join(' × ')} mm</td></tr>
    <tr><td>Wood to remove</td><td>${(analysis.blankVolumeCm3 - analysis.solidVolumeCm3).toFixed(0)} cm³ of ${analysis.blankVolumeCm3.toFixed(0)} cm³ (${(100 * (1 - analysis.solidVolumeCm3 / analysis.blankVolumeCm3)).toFixed(0)}%)</td></tr>
    <tr><td>Difficulty</td><td>${cav.stars} — ${cav.skillLevel}</td></tr>
  </table>
  ${warnings}
</section>

<section class="page">
  <h2>Print calibration</h2>
  ${calibrationSvg(50)}
</section>

<section class="page">
  <h2>Preparation</h2>
  <ul>
    <li>Mark centre lines on all four long faces and both ends of the blank.</li>
    <li>Orient the blank so the FRONT template faces you and grain runs top-to-bottom (along the ${project.blank.height} mm axis).</li>
    <li>Transfer each template with carbon paper or by pricking through the outline.</li>
    <li>Work through the stages in order. Never cut inside the final outline plus its safety margin.</li>
  </ul>
</section>

${templates}

<section class="page">
  <h2>Depth maps</h2>
  ${depthSections}
</section>

${contourSections}

<h2 style="margin-top:10mm">Carving stages</h2>
${stageRows}

<section class="page">
  <h2>Safety</h2>
  <div class="safety">
    <ul>
      <li>Use sharp tools appropriate for carving — a dull blade slips.</li>
      <li>Keep both hands and your body out of the cutting path; cut away from yourself.</li>
      <li>Secure the workpiece (clamp or bench hook) when sawing or chiselling.</li>
      <li>Wear eye protection when sawing or chipping.</li>
      <li>These templates and stages are geometric guidance, not a substitute for your own judgement about the wood in front of you.</li>
    </ul>
  </div>
  <p style="font-size:11px;color:#7a6a52">Generated by WhittleGuide. Geometry-based carving assistance — not tool-path planning. Model attribution: ${escapeHtml(project.institution ?? project.provider ?? 'user upload')}, ${escapeHtml(project.license)}.</p>
</section>

</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
}
