// Autonomous daily neuroscience-news pipeline.
// Runs in GitHub Actions, calls the Claude API (with web search) to scout recent
// neuroscience news, vet each candidate with 4 independent checkers, draft the
// survivors, and inject them into news.html. Only touches news.html so it never
// collides with the scheduled depression-post merge.
//
// Requires env ANTHROPIC_API_KEY. Writes `count=<n>` to GITHUB_OUTPUT.

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.NEWS_MODEL || 'claude-sonnet-5'
const NEWS_FILE = 'news.html'
const MAX_ITEMS_ON_PAGE = 40
const MAX_CANDIDATES_TO_CHECK = 10
const MAX_TO_PUBLISH = 3
const MAX_SCOUT_ROUNDS = 8
// Goal: at least 1 item every day, up to 3. We keep scouting in rounds, each
// round searching a WIDER time window than the last (a few days, then a couple
// weeks, then a month-plus) and excluding what we already weighed, and we keep
// going until we reach 3 or the search is genuinely exhausted (two straight
// rounds surface nothing new). The round cap is only a runaway safety valve so
// one run cannot loop forever — NOT a belief that neuroscience news runs out;
// the window rolls forward every day, so there is always fresh material. The one
// thing we never do is lower the four-check bar to force a post: on the rare day
// nothing real clears even a month-wide search, publishing nothing beats hype.
// (web search tool is built inline in ask() so max_uses can vary per call)

const now = new Date()
const isoDate = now.toISOString().slice(0, 10)
const niceDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
const targetMin = (now.getUTCDay() === 0 || now.getUTCDay() === 6) ? 1 : 2 // weekends 1, weekdays 2

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fence ? fence[1] : (text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/) || [])[1]
  if (!raw) throw new Error('no JSON found: ' + text.slice(0, 200))
  return JSON.parse(raw)
}

async function ask(prompt, { web = false, maxTokens = 1500, maxUses = 4 } = {}) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    ...(web ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }] } : {}),
    messages: [{ role: 'user', content: prompt }],
  })
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  if (!text) console.error(`empty text (stop_reason=${msg.stop_reason}, blocks=${msg.content.map((b) => b.type).join(',')})`)
  return text
}

// Fetch the source page's own preview image (og:image / twitter:image). Returns
// null on any failure, so items whose source has no shareable image stay text-only.
async function ogImage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TheNeuroReview/1.0; +https://theneuroreview.com)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return null
    const html = await res.text()
    const pats = [
      /<meta[^>]+property=["']og:image(?::secure_url|:url)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
    ]
    for (const p of pats) {
      const m = html.match(p)
      if (m && /^https?:\/\//.test(m[1])) return m[1].replace(/&amp;/g, '&')
    }
    return null
  } catch (e) {
    return null
  }
}

// --- read existing page + already-published URLs (avoid dupes) ---
const page = fs.readFileSync(NEWS_FILE, 'utf8')
const normUrl = (u) => String(u || '').replace(/&amp;/g, '&').trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '')
const existingUrls = new Set([...page.matchAll(/<p class="news-item__meta">[\s\S]*?href="([^"]+)"/g)].map((m) => normUrl(m[1])))
const existingHeadlines = [...page.matchAll(/<h[23]><a[^>]*>([^<]+)<\/a><\/h[23]>/g)].map((m) => m[1])

// Near-duplicate guard: the same study often gets covered by several outlets on
// different days (different URLs), so URL-dedup alone lets it re-post (this is how
// one dementia study landed on the feed three times). Compare headlines by their
// significant words; if a strong majority of the shorter headline's key words are
// already in an existing one, treat it as the same story and skip it.
// STOP holds only GENERIC report words. Topic/subject nouns (brain, dementia,
// pregnancy, parkinson, human...) are deliberately KEPT so they carry the
// same-study signal — stripping "brain" is what let a pregnancy study repost.
const STOP = new Set('study studies finds find found large small global first shows show suggests suggest reveals reveal could would may might research report reports about across after over with from have been more most into their they when what which some also than that this using used other can new says say according scientists scientist researchers'.split(' '))
const keyTokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)))
// A candidate is a near-duplicate only when it shares at least THREE significant
// words with an existing headline AND half of the smaller set. The absolute
// floor of 3 avoids over-blocking short/distinct headlines that happen to share
// one or two words, while the trimmed STOP list keeps the real same-study signal.
function nearDup(headline, list) {
  const a = keyTokens(headline)
  if (a.size < 3) return false
  for (const h of list) {
    const b = keyTokens(h)
    if (b.size < 3) continue
    let inter = 0
    for (const w of a) if (b.has(w)) inter++
    if (inter >= 3 && inter / Math.min(a.size, b.size) >= 0.5) return true
  }
  return false
}

// --- 1. SCOUT (one round; called repeatedly until the feed hits its floor) ---
const seen = new Set() // every url/headline we have already weighed this run
function windowForRound(round) {
  if (round <= 1) return 'published or covered in the last 3 to 4 days'
  if (round <= 3) return 'published or covered in the last 7 to 10 days'
  if (round <= 5) return 'published or covered in the last 2 to 3 weeks'
  return 'published or covered in the last 4 to 6 weeks'
}
async function scoutRound(round) {
  const windowText = windowForRound(round)
  const already = [...seen].slice(-40)
  const excludeText = already.length
    ? ` Do NOT return any of these already-considered items, by URL or by headline: ${already.join(' | ')}.`
    : ''
  const scoutPrompt = `You are scouting REAL, recent neuroscience and brain-science news for a rigorous plain-English publication. Today is ${niceDate}. Use web search to find up to 10 notable and genuinely real findings or reports ${windowText}, from reputable sources only (peer-reviewed journals, university press offices, and established science outlets such as Nature, Science, Quanta, The Transmitter, STAT, Scientific American, New Scientist). Exclude tabloids, content farms, product or supplement marketing, and anything without a real working URL. Do not invent anything.${excludeText}
Return ONLY a JSON array, each element {"headline":..., "sourceName":..., "url":..., "imageUrl":"a public, non-paywalled page covering this SAME story (a press release, a ScienceDaily item, or a university news page) that is likely to have a share image — repeat the main url if you have no better one", "finding":"one to two sentence plain statement of what was actually found", "date":..., "isPreprint":true|false}. No prose outside the JSON.`
  let batch = []
  try {
    batch = extractJson(await ask(scoutPrompt, { web: true, maxTokens: 8000, maxUses: 6 }))
  } catch (e) {
    console.error(`Scout round ${round} failed:`, e.message)
  }
  const fresh = (Array.isArray(batch) ? batch : []).filter((c) => {
    const k = String(c.url || c.headline || '').trim().toLowerCase()
    if (!k || seen.has(k) || existingUrls.has(normUrl(c.url))) return false
    if (nearDup(c.headline, existingHeadlines)) { console.log('skip near-dup of a card already on the feed:', c.headline); return false }
    seen.add(k)
    return true
  }).slice(0, MAX_CANDIDATES_TO_CHECK)
  console.log(`Scout round ${round}: ${fresh.length} fresh candidates`)
  return fresh
}

// --- 2 + 3. CHECK (4 independent lenses) then CONVENE ---
// Only the two lenses that must check against the live source use web search;
// the other two are judgment calls on the claim itself (cheaper, faster, no bloat).
const lenses = [
  { web: true, focus: 'SOURCE INTEGRITY. Inspect the source. Is it reputable and real with a working link, and a primary report or legitimate established outlet rather than a content farm or pure hype.' },
  { web: true, focus: 'ACCURACY. Check the stated finding against what the source actually reports. Flag any misrepresentation, exaggeration, wrong numbers, or details that do not match.' },
  { web: false, focus: 'HYPE AND OVERREACH. Look for causal overreach, animal-to-human overextension, cure or breakthrough language, or sensationalism the data does not support.' },
  { web: false, focus: 'LIMITS AND CONTEXT. Is this a small, preliminary, or single study, and what does it not show. Fail only if it is too weak or preliminary to responsibly feature.' },
]

async function vet(c) {
  const checks = await Promise.all(lenses.map((lens) =>
    ask(`You are one of four INDEPENDENT fact-checkers vetting a neuroscience news item before publication. Item headline "${c.headline}", source ${c.sourceName}, URL ${c.url}, stated finding "${c.finding}". YOUR LENS IS ${lens.focus} ${lens.web ? 'Use web search to verify against the actual source.' : 'Judge from the claim itself.'} Return ONLY JSON {"pass":true|false,"issues":[...],"note":"optional one-line honest caveat"}.`,
      { web: lens.web, maxTokens: lens.web ? 4000 : 2500, maxUses: 3 })
      .then((t) => extractJson(t))
      .catch((e) => ({ pass: false, issues: ['checker error: ' + e.message] })))
  )
  try {
    return extractJson(await ask(
      `Four independent checkers reviewed this neuroscience news item. Item headline "${c.headline}", source ${c.sourceName} (${c.url}), stated finding "${c.finding}". Their verdicts as JSON: ${JSON.stringify(checks)}. Decide whether to publish to a rigorous, anti-hype plain-English news feed. Publish ONLY if all four passed with no serious issue. If publishing, write the final item in a plain warm voice with NO colons, NO semicolons, and NO dashes of any kind. Use specific figures and precise words. Never use vague filler like "a lot", "a bit", "many", "several", "huge", "sort of", or "kind of". If you mean a quantity or a degree, state the real number or a concrete comparison, or cut the word. This is a rigorous review, not casual writing. Return ONLY JSON {"publish":true|false,"headline":"accurate, no hype","summary":"one to two sentences","caveat":"one line on what it does not show","sourceName":...,"sourceUrl":...,"date":"${niceDate} or the source date","reason":...}.`,
      { maxTokens: 3000 }))
  } catch (e) {
    console.error('Convene failed for', c.headline, e.message)
    return null
  }
}

// Scout + vet in rounds. Keep scouting a fresh, ever-wider batch and keep going
// until we have up to MAX_TO_PUBLISH, or two straight rounds turn up nothing new
// (the space is exhausted). A single weak batch can never leave the feed empty:
// if the last few days are thin, later rounds widen to weeks and then a month.
// Only items that clear all four checks are ever published.
const finalItems = []
let emptyStreak = 0
for (let round = 1; round <= MAX_SCOUT_ROUNDS && finalItems.length < MAX_TO_PUBLISH; round++) {
  const candidates = await scoutRound(round)
  if (candidates.length === 0) {
    emptyStreak += 1
    if (emptyStreak >= 2) { console.log('Two rounds in a row surfaced nothing new; stopping the search.'); break }
    continue
  }
  emptyStreak = 0
  for (const c of candidates) {
    if (finalItems.length >= MAX_TO_PUBLISH) break
    const decision = await vet(c)
    if (decision && decision.publish) {
      if (nearDup(decision.headline, [...existingHeadlines, ...finalItems.map((f) => f.headline)])) {
        console.log('SKIP (near-dup of an existing or already-chosen item):', decision.headline)
        continue
      }
      // Same-URL guard: two items can share a source URL under different headlines
      // (the headline near-dup check above can miss that), so also dedup by URL
      // against both the live page and everything chosen this run.
      const durl = normUrl(decision.sourceUrl || c.url)
      if (durl && (existingUrls.has(durl) || finalItems.some((f) => normUrl(f.sourceUrl) === durl))) {
        console.log('SKIP (same source URL as an existing or already-chosen item):', decision.headline)
        continue
      }
      decision.imageUrl = c.imageUrl || null // public coverage page for the image fallback
      // Normalize the date to "Month DD, YYYY" so the feed's date-sort (which only
      // reads that format) can never bury a card that the model dated as ISO etc.
      if (decision.date) {
        const parsed = new Date(decision.date)
        decision.date = Number.isNaN(parsed.getTime())
          ? niceDate
          : parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      }
      finalItems.push(decision)
      console.log('PUBLISH:', decision.headline)
    } else {
      console.log('SKIP:', c.headline, '-', decision && decision.reason)
    }
  }
  if (finalItems.length === 0 && round < MAX_SCOUT_ROUNDS) {
    console.log(`Round ${round}: still nothing cleared; widening the window and going again.`)
  }
}

if (finalItems.length === 0) {
  console.log('No items cleared all four checks today. Leaving the page unchanged.')
  try { fs.writeFileSync('.github/news-latest.json', '[]') } catch (e) { /* non-fatal */ }
  fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/stdout', 'count=0\n')
  process.exit(0)
}

// Attach each item's source preview image. Try the primary source first; if it
// blocks us or exposes none (common with paywalled journals like The Lancet, which
// returns 403 to fetches), fall back to a public coverage page (press release /
// ScienceDaily / university news) for the share image. Same mechanism either way:
// only the publisher's own og:image, and the card still links to the primary source.
// Cards render the thumb at 150x100, so ask hosts for a smaller variant than
// full-res where the URL scheme allows. Safe: if a smaller variant 404s, the
// <img onerror> handler already drops the thumbnail.
const shrinkImage = (url) => url
  .replace(/(media\.springernature\.com\/)m\d+(\/)/, '$1m312$2')
  .replace(/([?&]w=)(\d{3,})/, (m, p, n) => (+n > 400 ? p + '400' : m))
for (const it of finalItems) {
  it.image = await ogImage(it.sourceUrl)
  if (!it.image && it.imageUrl && normUrl(it.imageUrl) !== normUrl(it.sourceUrl)) {
    it.image = await ogImage(it.imageUrl)
  }
  if (it.image) it.image = shrinkImage(it.image)
}

// --- 4. INJECT into news.html (newest first, capped) ---
function itemHtml(it) {
  const url = esc(it.sourceUrl)
  const thumb = it.image
    ? `\n          <a class="news-item__thumb" aria-hidden="true" tabindex="-1" href="${url}" target="_blank" rel="noopener"><img src="${esc(it.image)}" alt="" loading="lazy" onerror="this.parentElement.remove()"></a>`
    : ''
  const caveat = it.caveat ? `\n          <p class="news-item__caveat"><em>${esc(it.caveat)}</em></p>` : ''
  return `        <article class="news-item">${thumb}
          <p class="news-item__meta">${esc(it.date || niceDate)} &middot; via <a href="${url}" target="_blank" rel="noopener">${esc(it.sourceName)}</a></p>
          <h2><a href="${url}" target="_blank" rel="noopener">${esc(it.headline)}</a></h2>
          <p>${esc(it.summary)}</p>${caveat}
        </article>`
}

const START = '<!-- NEWS-FEED-START -->'
const END = '<!-- NEWS-FEED-END -->'
const startIdx = page.indexOf(START)
const endIdx = page.indexOf(END)
if (startIdx === -1 || endIdx === -1) throw new Error('feed markers not found in news.html')

const before = page.slice(0, startIdx + START.length)
const after = page.slice(endIdx)
const existingBlock = page.slice(startIdx + START.length, endIdx)

// existing article blocks, oldest kept but capped
const existingArticles = existingBlock.split(/(?=<article class="news-item">)/).map((s) => s.trim()).filter(Boolean)
const newArticles = finalItems.map(itemHtml)
// Keep the whole feed in date order, newest first, so displayed dates never jump around.
// (Sort is stable, so same-date items keep new-before-existing order.)
const articleTime = (html) => {
  const m = html.match(/news-item__meta[^>]*>\s*([A-Za-z]+ \d{1,2}, \d{4})/)
  const t = m ? new Date(m[1]).getTime() : NaN
  return Number.isNaN(t) ? -Infinity : t
}
const combined = [...newArticles, ...existingArticles]
  .sort((a, b) => articleTime(b) - articleTime(a))
  .slice(0, MAX_ITEMS_ON_PAGE)
  .map((s) => s.replace(/^\s*/, '        ')) // uniform 8-space indent on every <article> line

const rebuilt = before + '\n' + combined.join('\n\n') + '\n        ' + after
fs.writeFileSync(NEWS_FILE, rebuilt)

// Hand today's new items to the social poster (Bluesky posts up to 2 of these).
// This file is a transient handoff and is not committed.
try {
  fs.writeFileSync('.github/news-latest.json', JSON.stringify(finalItems.map((it) => ({
    headline: it.headline,
    summary: it.summary,
    caveat: it.caveat || '',
    sourceName: it.sourceName,
    sourceUrl: it.sourceUrl,
    date: it.date || niceDate,
    image: it.image || null,
  })), null, 2))
} catch (e) {
  console.error('Could not write news-latest.json:', e.message)
}

if (finalItems.length < targetMin) console.warn(`Note: published ${finalItems.length}, below today's target of ${targetMin}. Held the quality bar rather than adding filler.`)
console.log(`Injected ${finalItems.length} new item(s); page now holds ${combined.length}.`)
fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/stdout', `count=${finalItems.length}\n`)
