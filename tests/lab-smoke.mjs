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
  // Release regression gate: all explorers must retain readable content at
  // phone width when scripting, CDN imports, or WebGL are unavailable.
  const expectedParts = { brain: 14, neuron: 8, synapse: 7 };
  for (const mode of ['no-js', 'cdn-blocked', 'no-webgl', 'normal']) {
    const faultCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      javaScriptEnabled: mode !== 'no-js',
    });
    if (mode === 'no-webgl') {
      await faultCtx.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          if (/webgl/i.test(type)) return null;
          return original.call(this, type, ...args);
        };
      });
    }
    try {
      for (const ex of EXPLORERS) {
        const page = await faultCtx.newPage();
        if (mode === 'cdn-blocked') await page.route(/cdn\.jsdelivr\.net/, r => r.abort());
        try {
          await page.goto(`${BASE}/${ex.file}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          if (mode === 'normal') {
            await page.waitForFunction(() => window.__labReady === true && getComputedStyle(document.getElementById('brain-fallback')).display === 'none', null, { timeout: 25000 });
          } else {
            await page.locator('#brain-fallback').waitFor({ state: 'visible', timeout: 20000 });
          }
          const state = await page.evaluate(() => {
            const display = id => {
              const e = document.getElementById(id);
              return e ? getComputedStyle(e).display : 'absent';
            };
            return {
              fallback: display('brain-fallback'), loading: display('brain-loading'),
              toolbar: display('brain-toolbar'), hint: display('brain-hint'),
              parts: document.querySelectorAll('#brain-fallback dt').length,
              descriptions: [...document.querySelectorAll('#brain-fallback dd')].every(e => e.textContent.trim().length > 20),
              width: document.documentElement.scrollWidth, viewport: innerWidth,
            };
          });
          if (mode === 'normal') {
            check(`${mode}/${ex.slug}: working 3D controls at phone width`, state.fallback === 'none' && state.loading === 'none' && state.toolbar !== 'none', JSON.stringify(state));
          } else {
            check(`${mode}/${ex.slug}: readable static explanations`, state.fallback !== 'none' && state.parts === expectedParts[ex.slug] && state.descriptions, JSON.stringify(state));
            check(`${mode}/${ex.slug}: no loader or inert 3D controls`, ['loading','toolbar','hint'].every(k => ['none','absent'].includes(state[k])), JSON.stringify(state));
          }
          check(`${mode}/${ex.slug}: 390px page fits`, state.width <= state.viewport + 1, JSON.stringify(state));
        } catch (e) {
          check(`${mode}/${ex.slug}: failure path works`, false, String(e));
        } finally { await page.close(); }
      }
    } finally { await faultCtx.close(); }
  }
  // Independently exercise user-visible release behavior on the real pages.
  const release = await browser.newContext({viewport:{width:1280,height:900},colorScheme:'light'});
  const page = await release.newPage();
  try {
    for (const query of ['dopamine','ssri']) {
      await page.goto(`${BASE}/search.html?q=${query}`);
      await page.waitForFunction(() => document.querySelectorAll('#search-results a, .post-card a').length > 0);
      const links = await page.locator('a[href^="lab.html#"]').count();
      check(`search: ${query} finds a Lab demo`,links>0,`demo links=${links}`);
    }
    await page.goto(`${BASE}/lab.html#dopamine-rpe-canvas`);
    await page.waitForFunction(() => document.querySelector('[data-labdemo="dopamine-rpe"]').classList.contains('is-open'));
    check('Lab: search anchor opens dopamine demo',true);
    const names=await page.locator('.demo-toggle').evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')));
    check('Lab: demo controls have unique accessible names',names.every(Boolean)&&new Set(names).size===names.length,`${names.length} controls`);
    await page.locator('#lif-current').evaluate(e=>{e.value='30';e.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForTimeout(4500);
    await page.locator('#lif-current').evaluate(e=>{e.value='0';e.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForTimeout(700);
    check('Lab: zero current clears stale firing rate',(await page.locator('#lif-rate').textContent()).trim()==='0');
    await page.goto(`${BASE}/tools/stroop-test.html`);
    await page.locator('#stroop-start').click();
    for(let i=0;i<20;i++){
      await page.waitForTimeout(170);
      await page.evaluate(()=>{
        const w=document.getElementById('stroop-word');
        const color=getComputedStyle(w).color;
        const root=getComputedStyle(document.documentElement);
        const colors=['red','blue','green','orange'];
        const correct=colors.find(n=>{const p=document.createElement('span');p.style.color=root.getPropertyValue('--ink-'+n).trim();document.body.append(p);const equal=getComputedStyle(p).color===color;p.remove();return equal;});
        if(!correct)throw Error('Could not identify stimulus ink');
        [...document.querySelectorAll('#stroop-keys button')].find(b=>b.textContent.toLowerCase()!==correct).click();
      });
    }
    check('Stroop: all-error run is not interpreted',await page.locator('#stroop-stage').textContent().then(t=>t.includes('cannot be scored')&&!t.includes('exactly the reflex winning')));
    for(const file of ['index.html','lab.html','funding.html']){
      await page.goto(`${BASE}/${file}`);
      const ratio=await page.evaluate(()=>{
        const s=getComputedStyle(document.documentElement);
        const rgb=h=>h.trim().replace('#','').match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
        const lum=h=>rgb(h).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
        const a=lum(s.getPropertyValue('--muted')),b=lum(s.getPropertyValue('--bg'));
        return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      });
      check(`${file}: muted text exceeds 4.5:1 on page background`,ratio>=4.5,ratio.toFixed(2));
    }
    await page.setViewportSize({width:390,height:844});
    await page.goto(`${BASE}/index.html`);
    check('privacy notice scrolls with narrow page',await page.locator('#privacy-bar').evaluate(e=>getComputedStyle(e).position==='static'));
  } catch(e){check('release behavior checks complete',false,String(e));}
  finally{await release.close();}
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
