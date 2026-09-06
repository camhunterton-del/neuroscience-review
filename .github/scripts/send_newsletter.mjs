// Send (or draft, or preview) a published post as a Buttondown email.
//
// Env:
//   BUTTONDOWN_API_KEY  required unless NEWSLETTER_MODE=preview
//   POST_SLUG           optional; default = newest post from feed.xml
//   NEWSLETTER_MODE     preview (default, prints the email, no API call)
//                       | draft (creates a Buttondown draft, does NOT send)
//                       | send  (queues the email to go to all subscribers)
//
// Safe by design: default is preview, and "draft" never sends. Only "send" mails people.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // repo root from .github/scripts/
const SITE = 'https://theneuroreview.com';
const MODE = (process.env.NEWSLETTER_MODE || 'preview').toLowerCase();
const API_KEY = process.env.BUTTONDOWN_API_KEY;

if (MODE !== 'preview' && !API_KEY) {
  console.error('Missing BUTTONDOWN_API_KEY (required for draft/send).');
  process.exit(1);
}

// ---------- helpers ----------
const ENTITIES = {
  '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’',
  '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&middot;': '·',
  '&rarr;': '→', '&larr;': '←', '&amp;': '&', '&nbsp;': ' ', '&percnt;': '%',
  '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>',
};
function decode(s) {
  return (s || '').replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m] ?? m);
}
function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '');
}
function absolutize(url) {
  if (/^(https?:|mailto:|#)/i.test(url)) return url;
  if (url.startsWith('../')) return SITE + '/' + url.replace(/^\.\.\//, '');
  return SITE + '/posts/' + url; // sibling links inside posts/
}
// Convert inline HTML (links, bold, italic) to Markdown.
function inline(s) {
  return decode(
    (s || '')
      .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
        (_, href, txt) => `[${stripTags(txt).trim()}](${absolutize(href)})`)
      .replace(/<strong>([\s\S]*?)<\/strong>/gi, (_, t) => `**${stripTags(t)}**`)
      .replace(/<b>([\s\S]*?)<\/b>/gi, (_, t) => `**${stripTags(t)}**`)
      .replace(/<em>([\s\S]*?)<\/em>/gi, (_, t) => `*${stripTags(t)}*`)
      .replace(/<i>([\s\S]*?)<\/i>/gi, (_, t) => `*${stripTags(t)}*`)
      .replace(/<[^>]+>/g, '') // drop any leftover tags
  ).replace(/[ \t]+/g, ' ').trim();
}
function listItems(ulHtml, ordered) {
  const items = [...ulHtml.matchAll(/<li>([\s\S]*?)<\/li>/gi)].map((m) => inline(m[1]));
  return items.map((t, i) => (ordered ? `${i + 1}. ${t}` : `- ${t}`)).join('\n');
}

// ---------- HTML block -> Markdown ----------
function toMarkdown(bodyHtml) {
  let h = bodyHtml;
  h = h.replace(/<aside class="cta[\s\S]*?<\/aside>/gi, ''); // strip inline subscribe boxes

  const out = [];
  // Walk the known top-level blocks in order.
  const blockRe = /<figure[^>]*>([\s\S]*?)<\/figure>|<aside class="callout[^"]*">([\s\S]*?)<\/aside>|<h2>([\s\S]*?)<\/h2>|<h3>([\s\S]*?)<\/h3>|<p class="pull-quote">([\s\S]*?)<\/p>|<ul>([\s\S]*?)<\/ul>|<ol>([\s\S]*?)<\/ol>|<p>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = blockRe.exec(h)) !== null) {
    if (m[1] !== undefined) { // figure
      const fig = m[1];
      let src = (fig.match(/<img[^>]*\bsrc="([^"]*)"/i) || [])[1] || '';
      const alt = (fig.match(/<img[^>]*\balt="([^"]*)"/i) || [])[1] || '';
      const cap = inline((fig.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i) || [])[1] || '');
      // Email clients don't render SVG. If an SVG figure has a same-named PNG in
      // the repo, use the PNG; otherwise drop the image (raster only) so no broken
      // figure ships, and the caption still carries the point.
      if (/\.svg(\?|$)/i.test(src)) {
        const pngRel = src.replace(/\.svg(\?|$)/i, '.png$1');
        const localPng = join(ROOT, pngRel.replace(/^(\.\.\/)+/, ''));
        src = existsSync(localPng) ? pngRel : '';
      }
      if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(src)) out.push(`![${decode(alt)}](${absolutize(src)})`);
      if (cap) out.push(`*${cap}*`);
    } else if (m[2] !== undefined) { // callout
      const label = stripTags((m[2].match(/<span class="callout__label">([\s\S]*?)<\/span>/i) || [])[1] || 'Key takeaways');
      const ul = (m[2].match(/<ul>([\s\S]*?)<\/ul>/i) || [])[1] || '';
      const lines = [`> **${decode(label)}**`, ...listItems(ul, false).split('\n').map((l) => '> ' + l)];
      out.push(lines.join('\n'));
    } else if (m[3] !== undefined) { out.push(`## ${inline(m[3])}`); }
    else if (m[4] !== undefined) { out.push(`### ${inline(m[4])}`); }
    else if (m[5] !== undefined) { out.push(`> *${inline(m[5])}*`); } // pull-quote
    else if (m[6] !== undefined) { out.push(listItems(m[6], false)); }
    else if (m[7] !== undefined) { out.push(listItems(m[7], true)); }
    else if (m[8] !== undefined) { out.push(inline(m[8])); }
  }
  return out.filter(Boolean).join('\n\n');
}

// ---------- assemble ----------
let slug = process.env.POST_SLUG;
if (!slug) {
  const feed = readFileSync(join(ROOT, 'feed.xml'), 'utf8');
  const m = feed.match(/posts\/([a-z0-9-]+)\.html/);
  if (!m) { console.error('Could not find newest post in feed.xml'); process.exit(1); }
  slug = m[1];
}
const html = readFileSync(join(ROOT, 'posts', slug + '.html'), 'utf8');
const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };

const title = decode(stripTags(pick(/<h1 class="post-header__title">([\s\S]*?)<\/h1>/))).trim();
const subtitle = inline(pick(/<p class="post-header__subtitle">([\s\S]*?)<\/p>/));
const bodyHtml = pick(/<div class="post-body">([\s\S]*?)<\/div>\s*<div class="post-endmark"/);
const sourcesHtml = pick(/<section class="post-sources">([\s\S]*?)<\/section>/);

if (!title || !bodyHtml) { console.error(`Could not parse title/body from ${slug}.html`); process.exit(1); }

let md = toMarkdown(bodyHtml);
if (sourcesHtml) {
  const h2 = stripTags((sourcesHtml.match(/<h2>([\s\S]*?)<\/h2>/i) || [])[1] || 'The research');
  const ol = (sourcesHtml.match(/<ol>([\s\S]*?)<\/ol>/i) || [])[1] || '';
  md += `\n\n## ${decode(h2)}\n\n` + listItems(ol, true);
}

const body = [
  `*${subtitle}*`,
  '',
  md.trim(),
  '',
  '---',
  '',
  `**[Read this on the web →](${SITE}/posts/${slug}.html)**`,
  '',
  'Best,  \nCameron  \nFounder and Editor  \nThe Neuroscience Review',
  '',
  '---',
  '',
  '*You are getting this because you subscribed to The Neuroscience Review. One brain-science deep dive every Wednesday, no hype.*',
].join('\n');

// ---------- output ----------
if (MODE === 'preview') {
  console.log(`SUBJECT: ${title}\nSLUG: ${slug}\nMODE: preview (no email created)\n`);
  console.log('----- EMAIL BODY (Markdown) -----\n');
  console.log(body);
  process.exit(0);
}

// Idempotency: never send the same post twice (protects the weekly auto-run).
if (MODE === 'send') {
  const list = await fetch('https://api.buttondown.com/v1/emails?ordering=-creation_date', {
    headers: { 'Authorization': `Token ${API_KEY}` },
  });
  if (list.ok) {
    const { results = [] } = await list.json();
    // Skip only if a matching email was already SENT/queued — a leftover draft must not block the real send.
    if (results.some((e) => (e.subject || '').trim() === title && (e.status || '') !== 'draft')) {
      console.log(`SKIP: an email titled "${title}" has already gone out. Not sending again.`);
      process.exit(0);
    }
  }
}

const status = MODE === 'send' ? 'about_to_send' : 'draft';
const HDR = { 'Authorization': `Token ${API_KEY}`, 'Content-Type': 'application/json' };
// Buttondown requires this one-time-per-key confirmation header to actually send
// (create an email with status about_to_send); without it the API returns 400
// "sending_requires_confirmation". Harmless on draft requests, so only add on send.
const CREATE_HDR = status === 'about_to_send' ? { ...HDR, 'X-Buttondown-Live-Dangerously': 'true' } : HDR;

// In draft mode, update an existing draft with the same subject instead of duplicating it.
let existingDraftId = null;
if (MODE === 'draft') {
  const list = await fetch('https://api.buttondown.com/v1/emails?ordering=-creation_date', { headers: HDR });
  if (list.ok) {
    const { results = [] } = await list.json();
    const m = results.find((e) => (e.subject || '').trim() === title && (e.status || '') === 'draft');
    if (m) existingDraftId = m.id;
  }
}

const res = existingDraftId
  ? await fetch(`https://api.buttondown.com/v1/emails/${existingDraftId}`, { method: 'PATCH', headers: HDR, body: JSON.stringify({ subject: title, body }) })
  : await fetch('https://api.buttondown.com/v1/emails', { method: 'POST', headers: CREATE_HDR, body: JSON.stringify({ subject: title, body, status }) });
const text = await res.text();
if (!res.ok) { console.error(`Buttondown API error ${res.status}: ${text}`); process.exit(1); }
const data = JSON.parse(text);
console.log(`OK: "${title}" -> ${existingDraftId ? 'DRAFT updated' : (status === 'draft' ? 'DRAFT created (not sent)' : 'QUEUED TO SEND to subscribers')} (id ${data.id})`);
console.log(`Review at https://buttondown.com/emails`);
