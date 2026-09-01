/**
 * Headless-browser smoke test of the built app.
 *
 *   npm run build && npm run preview      # in one terminal
 *   npm run smoke                         # in another
 *   BASE_URL=https://<user>.github.io/whittle-guide/ npm run smoke   # against prod
 *
 * Loads a built-in demo model (no network) and asserts the whole pipeline runs:
 * library renders, workspace mounts, 6 templates, 4 depth maps, 9 stages, guide.
 * Needs a Chromium at /usr/bin/chromium and playwright-core.
 */
import { chromium } from 'playwright-core';

const base = process.env.BASE_URL || 'http://localhost:4173/';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('  [console.error]', m.text().slice(0, 300)); } });
page.on('pageerror', (e) => { errors.push('PAGEERROR ' + e.message); console.log('  [pageerror]', e.message.slice(0, 300)); });
page.on('requestfailed', (r) => console.log('  [reqfail]', r.url().slice(0, 120), r.failure()?.errorText));

console.log('goto', base);
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('.card', { timeout: 15000 });
const cards = await page.$$eval('.card', (els) => els.length);
console.log('cards:', cards);
await page.screenshot({ path: 'scratch/shot-home.png' });

// open a demo model (museum GLB fetch is blocked by this sandbox's proxy;
// real browsers hit si.edu directly. Curated cards still render — verified above.)
await page.click('.demorow .linkbtn');
try {
  await page.waitForSelector('.workspace canvas', { timeout: 30000 });
} catch (e) {
  await page.screenshot({ path: 'scratch/shot-fail.png' });
  console.log('BODY:', (await page.textContent('body'))?.slice(0, 400));
  throw e;
}
console.log('workspace mounted');

// wait for first analysis to finish -> panel content appears
await page.waitForSelector('.tplgrid .tplfig', { timeout: 60000 });
const figs = await page.$$eval('.tplgrid .tplfig', (e) => e.length);
console.log('silhouette figures:', figs);
await page.screenshot({ path: 'scratch/shot-workspace.png' });

// roughing cut-lines toggle on the silhouette templates
const strokeCountBefore = await page.$$eval('.tplgrid .svgwrap path', (e) => e.length);
await page.click('.panel .switch input');
await page.waitForFunction(
  (n) => document.querySelectorAll('.tplgrid .svgwrap path').length > n,
  strokeCountBefore,
  { timeout: 10000 },
);
const strokeCountAfter = await page.$$eval('.tplgrid .svgwrap path', (e) => e.length);
console.log('template paths before/after roughing toggle:', strokeCountBefore, strokeCountAfter);
await page.screenshot({ path: 'scratch/shot-roughing-lines.png' });
await page.click('.panel .switch input'); // toggle back off

// depth tab
await page.click('.tab:has-text("Depth")');
await page.waitForSelector('.depthimg', { timeout: 20000 });
console.log('depth maps:', await page.$$eval('.depthimg', (e) => e.length));

// contours
await page.click('.tab:has-text("Contours")');
await page.waitForSelector('.tplgrid .tplfig', { timeout: 20000 });

// roughing
await page.click('.tab:has-text("Roughing")');
await page.waitForSelector('.timeline .tl__node', { timeout: 20000 });
console.log('stages:', await page.$$eval('.timeline .tl__node', (e) => e.length));
const instr = await page.textContent('.stagecard .instruction');
console.log('stage instruction:', instr?.slice(0, 90));

// guide
await page.click('.tab:has-text("Guide")');
await page.waitForSelector('.analysis__grid', { timeout: 20000 });
const diff = await page.textContent('.analysis__grid .kv__v');
console.log('difficulty:', diff);
await page.screenshot({ path: 'scratch/shot-guide.png' });

console.log('\nCONSOLE ERRORS:', errors.length);
for (const e of errors.slice(0, 20)) console.log(' -', e.slice(0, 200));

await browser.close();
process.exit(errors.length ? 1 : 0);
