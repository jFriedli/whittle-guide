/**
 * SVG generation for carving templates. All coordinates are millimetres and the
 * root <svg> is sized in real mm units, so printing at 100% / "Actual Size"
 * yields a 1:1 template. A calibration square is always available for the guide.
 */

import { ViewName } from '../geometry/projection';

const NS = 'http://www.w3.org/2000/svg';

export interface TemplateInput {
  view: ViewName | string;
  widthMm: number;
  heightMm: number;
  /** Silhouette outline polylines in mm, origin bottom-left. */
  outline: number[][][];
  /** Optional contour polylines grouped by depth. */
  contours?: { depthMm: number; polylines: number[][][] }[];
  title: string;
  subtitle?: string;
}

const MARGIN = 14; // mm around the face for labels

function pathFrom(polylines: number[][][], flipY: number): string {
  return polylines
    .map((line) => line.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${(flipY - y).toFixed(2)}`).join(' '))
    .join(' ');
}

export function buildTemplateSvg(input: TemplateInput): string {
  const { widthMm: w, heightMm: h } = input;
  const totalW = w + MARGIN * 2;
  const totalH = h + MARGIN * 2;
  const flipY = h; // convert bottom-left origin to SVG top-left

  const ticks: string[] = [];
  for (let x = 0; x <= w + 1e-6; x += 10) {
    ticks.push(`<line x1="${x}" y1="0" x2="${x}" y2="${x % 50 === 0 ? -4 : -2.5}" />`);
    ticks.push(`<line x1="${x}" y1="${h}" x2="${x}" y2="${h + (x % 50 === 0 ? 4 : 2.5)}" />`);
  }
  for (let y = 0; y <= h + 1e-6; y += 10) {
    ticks.push(`<line x1="0" y1="${flipY - y}" x2="${y % 50 === 0 ? -4 : -2.5}" y2="${flipY - y}" />`);
    ticks.push(`<line x1="${w}" y1="${flipY - y}" x2="${w + (y % 50 === 0 ? 4 : 2.5)}" y2="${flipY - y}" />`);
  }

  const contourPaths = (input.contours ?? [])
    .map((c) => {
      const opacity = 0.25 + Math.min(0.6, c.depthMm / 40);
      return `<path d="${pathFrom(c.polylines, flipY)}" fill="none" stroke="#1d6fb8" stroke-width="0.3" opacity="${opacity.toFixed(2)}"/>` +
        (c.polylines[0]?.[0]
          ? `<text x="${c.polylines[0][0][0].toFixed(1)}" y="${(flipY - c.polylines[0][0][1]).toFixed(1)}" font-size="2.4" fill="#1d6fb8">${c.depthMm}</text>`
          : '');
    })
    .join('\n');

  return `<svg xmlns="${NS}" width="${totalW}mm" height="${totalH}mm" viewBox="0 0 ${totalW} ${totalH}" font-family="ui-sans-serif, system-ui, sans-serif">
  <g transform="translate(${MARGIN} ${MARGIN})">
    <rect x="0" y="0" width="${w}" height="${h}" fill="#fbf7f0" stroke="#3c2f1e" stroke-width="0.5"/>
    <g stroke="#3c2f1e" stroke-width="0.4">${ticks.join('')}</g>
    <line x1="${w / 2}" y1="0" x2="${w / 2}" y2="${h}" stroke="#c07a3a" stroke-width="0.3" stroke-dasharray="2 1.5"/>
    <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="#c07a3a" stroke-width="0.3" stroke-dasharray="2 1.5"/>
    <path d="${pathFrom(input.outline, flipY)}" fill="#e7d8bf" fill-opacity="0.55" stroke="#3c2f1e" stroke-width="0.6" stroke-linejoin="round"/>
    ${contourPaths}
    <text x="0" y="-6" font-size="4" font-weight="600" fill="#3c2f1e">${escapeXml(input.title)}</text>
    <text x="0" y="${h + 9}" font-size="3" fill="#5b4a33">${escapeXml(input.subtitle ?? `${w.toFixed(0)} × ${h.toFixed(0)} mm — print at 100% (Actual Size)`)}</text>
    <text x="${w}" y="-6" font-size="3" fill="#5b4a33" text-anchor="end">${escapeXml(String(input.view).toUpperCase())}</text>
  </g>
</svg>`;
}

export function calibrationSvg(sizeMm = 50): string {
  const t = sizeMm + 20;
  return `<svg xmlns="${NS}" width="${t}mm" height="${t}mm" viewBox="0 0 ${t} ${t}" font-family="system-ui, sans-serif">
  <rect x="10" y="10" width="${sizeMm}" height="${sizeMm}" fill="none" stroke="#000" stroke-width="0.5"/>
  <text x="${10 + sizeMm / 2}" y="${10 + sizeMm / 2}" font-size="4" text-anchor="middle" dominant-baseline="middle">${sizeMm} mm</text>
  <text x="10" y="${sizeMm + 18}" font-size="3">Measure this square after printing. It must be exactly ${sizeMm} mm. Print at 100% / Actual Size — never "Fit to page".</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function svgToBlobUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
}
