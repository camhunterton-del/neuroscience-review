// Lab 3D smoke tests (Codex Lab audit P1 #4).
//
// The HTTP/content watchdog (site-watchdog.yml) only proves pages return 200 and
// the news order is right. It can't see whether the interactive 3D actually boots:
// Three.js could fail to import, WebGL could fail to start, a click handler could
// throw, or the CDN-blocked fallback could silently not appear. This drives a real
// headless browser through each explorer and asserts the things that matter.
//
// Runs against a locally served checkout (BASE, default http://localhost:8000) so it
// tests HEAD, not the lagging Pages deploy. Exit 0 = all passed, 1 = a check failed.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8000';
const EXPLORERS = [
  { slug: 'brain',   file: 'brain.html',   minChips: 10 },
  { slug: 'neuron',  file: 'neuron.html',  minChips: 6 },
  { slug: 'synapse', file: 'synapse.html', minChips: 5 },
];

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const browser = await chromium.launch({
  headless: true,
  // Software WebGL so the 3D actually initializes on a GPU-less CI runner.
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
  ],
});

try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });

  for (const ex of EXPLORERS) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    try {
      await page.goto(`${BASE}/${ex.file}`, { waitUntil: 'load', timeout: 30000 });

      // 1) The module imported Three.js from the CDN and ran.
      await page.waitForFunction(() => window.__labReady === true, { timeout: 25000 });
      check(`${ex.slug}: module ready (__labReady)`, true);

      // 2) Loading overlay gone, fallback not shown on the success path.
      const vis = await page.evaluate(() => {
        const disp = id => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'MISSING'; };
        return { loading: disp('brain-loading'), fallback: disp('brain-fallback') };
      });
      check(`${ex.slug}: loading overlay hidden`, vis.loading === 'none', `display=${vis.loading}`);
      check(`${ex.slug}: fallback hidden on success`, vis.fallback === 'none', `display=${vis.fallback}`);

      // 3) A real WebGL canvas was created and sized (proves initGL succeeded).
      const canvas = await page.evaluate(() => {
        const c = document.querySelector('#brain-canvas canvas');
        return c ? { has: true, w: c.width, h: c.height } : { has: false };
      });
      check(`${ex.slug}: WebGL canvas present + sized`, canvas.has && canvas.w > 0 && canvas.h > 0, JSON.stringify(canvas));

      // 4) Region/part chips exist, and clicking one opens the info panel + updates the hash.
      const chipN = await page.evaluate(() =>
        [...document.querySelectorAll('button')].filter(b => /chip/i.test(b.className)).length);
      check(`${ex.slug}: has region/part chips`, chipN >= ex.minChips, `chips=${chipN}`);

      await page.evaluate(() => {
        const c = [...document.querySelectorAll('button')].filter(b => /chip/i.test(b.className));
        (c[1] || c[0]).click();
      });
      await page.waitForFunction(
        () => document.getElementById('brain-info')?.classList.contains('is-visible'),
        { timeout: 8000 });
      const clicked = await page.evaluate(() => ({
        info: !!document.getElementById('brain-info')?.classList.contains('is-visible'),
        len: (document.getElementById('brain-info')?.textContent || '').trim().length,
        hash: location.hash,
      }));
      check(`${ex.slug}: click opens info panel with content`, clicked.info && clicked.len > 20, JSON.stringify(clicked));
      check(`${ex.slug}: selection updates URL hash`, /part=|region=/.test(clicked.hash), clicked.hash);

      check(`${ex.slug}: no uncaught page errors`, errors.length === 0, errors.join(' | '));
    } catch (e) {
      check(`${ex.slug}: loads and boots without throwing`, false, `${e} | pageerrors: ${errors.join(' | ')}`);
    } finally {
      await page.close();
    }
  }

  // 5) CDN-block fallback: block jsdelivr, expect the graceful fallback (image + message)
  //    to appear instead of an endless "Loading…". This is the P1 #1 bug's regression guard.
  {
    const page = await ctx.newPage();
    await page.route(/cdn\.jsdelivr\.net/, r => r.abort());  // regex: a '**...**' glob matches nothing here
    try {
      await page.goto(`${BASE}/neuron.html`, { waitUntil: 'load', timeout: 30000 });
      await page.waitForFunction(() => {
        const el = document.getElementById('brain-fallback');
        return el && getComputedStyle(el).display !== 'none';
      }, { timeout: 15000 });
      const fb = await page.evaluate(() => {
        const el = document.getElementById('brain-fallback');
        return {
          visible: !!(el && getComputedStyle(el).display !== 'none'),
          hasImg: !!(el && el.querySelector('img')),
          loadingHidden: getComputedStyle(document.getElementById('brain-loading')).display === 'none',
        };
      });
      check('cdn-block: fallback becomes visible', fb.visible, JSON.stringify(fb));
      check('cdn-block: fallback shows the preview image', fb.hasImg, JSON.stringify(fb));
      check('cdn-block: endless loader is hidden', fb.loadingHidden, JSON.stringify(fb));
    } catch (e) {
      check('cdn-block: fallback appears when CDN blocked', false, String(e));
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) { console.error(`${failed} Lab smoke check(s) FAILED`); process.exit(1); }
console.log('All Lab smoke tests passed.');
