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
const MAX_CANDIDATES_TO_CHECK = 5
const MAX_TO_PUBLISH = 5
const WEB_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }

const now = new Date()
const isoDate = now.toISOString().slice(0, 10)
const niceDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fence ? fence[1] : (text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/) || [])[1]
  if (!raw) throw new Error('no JSON found: ' + text.slice(0, 200))
  return JSON.parse(raw)
}

async function ask(prompt, { web = false, maxTokens = 1200 } = {}) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    ...(web ? { tools: [WEB_TOOL] } : {}),
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

// --- read existing page + already-published URLs (avoid dupes) ---
const page = fs.readFileSync(NEWS_FILE, 'utf8')
const existingUrls = new Set([...page.matchAll(/news-item__meta[\s\S]*?href="([^"]+)"/g)].map((m) => m[1]))

// --- 1. SCOUT ---
const scoutPrompt = `You are scouting REAL, recent neuroscience and brain-science news for a rigorous plain-English publication. Today is ${niceDate}. Use web search to find up to 6 notable and genuinely real findings or reports published or covered in the last 3 to 4 days, from reputable sources only (peer-reviewed journals, university press offices, and established science outlets such as Nature, Science, Quanta, The Transmitter, STAT, Scientific American, New Scientist). Exclude tabloids, content farms, product or supplement marketing, and anything without a real working URL. Do not invent anything.
Return ONLY a JSON array, each element {"headline":..., "sourceName":..., "url":..., "finding":"one to two sentence plain statement of what was actually found", "date":..., "isPreprint":true|false}. No prose outside the JSON.`

let candidates = []
try {
  candidates = extractJson(await ask(scoutPrompt, { web: true, maxTokens: 3500 }))
} catch (e) {
  console.error('Scout failed:', e.message)
}
// dedupe within batch + against the live page
const seen = new Set()
candidates = candidates.filter((c) => {
  const k = String(c.url || c.headline || '').trim().toLowerCase()
  if (!k || seen.has(k) || existingUrls.has(c.url)) return false
  seen.add(k)
  return true
}).slice(0, MAX_CANDIDATES_TO_CHECK)
console.log(`Scouted ${candidates.length} fresh candidates`)

// --- 2 + 3. CHECK (4 independent lenses) then CONVENE ---
const lenses = [
  'SOURCE INTEGRITY. Inspect the source. Is it reputable and real with a working link, and a primary report or legitimate established outlet rather than a content farm or pure hype.',
  'ACCURACY. Check the stated finding against what the source actually reports. Flag any misrepresentation, exaggeration, wrong numbers, or details that do not match.',
  'HYPE AND OVERREACH. Look for causal overreach, animal-to-human overextension, cure or breakthrough language, or sensationalism the data does not support.',
  'LIMITS AND CONTEXT. Is this a small, preliminary, or single study, and what does it not show. Fail only if it is too weak or preliminary to responsibly feature.',
]

const finalItems = []
for (const c of candidates) {
  const checks = await Promise.all(lenses.map((lens) =>
    ask(`You are one of four INDEPENDENT fact-checkers vetting a neuroscience news item before publication. Item headline "${c.headline}", source ${c.sourceName}, URL ${c.url}, stated finding "${c.finding}". YOUR LENS IS ${lens} Use web search to verify. Return ONLY JSON {"pass":true|false,"issues":[...],"note":"optional one-line honest caveat"}.`,
      { web: true, maxTokens: 900 })
      .then((t) => extractJson(t))
      .catch((e) => ({ pass: false, issues: ['checker error: ' + e.message] })))
  )

  let decision
  try {
    decision = extractJson(await ask(
      `Four independent checkers reviewed this neuroscience news item. Item headline "${c.headline}", source ${c.sourceName} (${c.url}), stated finding "${c.finding}". Their verdicts as JSON: ${JSON.stringify(checks)}. Decide whether to publish to a rigorous, anti-hype plain-English news feed. Publish ONLY if all four passed with no serious issue. If publishing, write the final item in a plain warm voice with NO colons, NO semicolons, and NO dashes of any kind. Return ONLY JSON {"publish":true|false,"headline":"accurate, no hype","summary":"one to two sentences","caveat":"one line on what it does not show","sourceName":...,"sourceUrl":...,"date":"${niceDate} or the source date","reason":...}.`,
      { maxTokens: 1200 }))
  } catch (e) {
    console.error('Convene failed for', c.headline, e.message)
    continue
  }
  if (decision && decision.publish) {
    finalItems.push(decision)
    console.log('PUBLISH:', decision.headline)
  } else {
    console.log('SKIP:', c.headline, '-', decision && decision.reason)
  }
  if (finalItems.length >= MAX_TO_PUBLISH) break
}

if (finalItems.length === 0) {
  console.log('No items cleared all four checks today. Leaving the page unchanged.')
  fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/stdout', 'count=0\n')
  process.exit(0)
}

// --- 4. INJECT into news.html (newest first, capped) ---
function itemHtml(it) {
  const url = esc(it.sourceUrl)
  const caveat = it.caveat ? `\n          <p class="news-item__caveat"><em>${esc(it.caveat)}</em></p>` : ''
  return `        <article class="news-item">
          <p class="news-item__meta">${esc(it.date || niceDate)} &middot; via <a href="${url}" target="_blank" rel="noopener">${esc(it.sourceName)}</a></p>
          <h3><a href="${url}" target="_blank" rel="noopener">${esc(it.headline)}</a></h3>
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
const combined = [...newArticles, ...existingArticles].slice(0, MAX_ITEMS_ON_PAGE)

const rebuilt = before + '\n' + combined.join('\n\n') + '\n        ' + after
fs.writeFileSync(NEWS_FILE, rebuilt)

console.log(`Injected ${finalItems.length} new item(s); page now holds ${combined.length}.`)
fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/stdout', `count=${finalItems.length}\n`)
