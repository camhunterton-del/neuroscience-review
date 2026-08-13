// The Neuroscience Review — single morning "daily digest".
// One email per weekday that folds every autonomous system into one report so the
// inbox is not flooded with several separate morning emails. It:
//   1. OUTREACH   — runs the vetted contributor-outreach engine (research, dedup,
//                   draft, double-verify, gated live send) and reports the result.
//   2. CONCIERGE  — reads the last ~26h of INBOX and DRAFTS (never sends) replies
//                   that need Cameron, in his voice.
//   3. WEDNESDAY  — checks that this week's Wednesday post is scheduled, else flags.
//   4. NUMBERS    — Buttondown subscribers + Bluesky followers/posts.
//   5. EMAIL      — composes and sends ONE plain-text digest to DIGEST_TO.
//
// Every section is wrapped so one failure still lets the others AND the email
// through. Never throws, never exits non-zero.
//
// Env: ANTHROPIC_API_KEY, GMAIL_APP_PASSWORD, GMAIL_USER, DIGEST_TO,
// BUTTONDOWN_API_KEY, BLUESKY_HANDLE, BLUESKY_APP_PASSWORD, DRY_RUN, MAX_SENDS.
// Deps: @anthropic-ai/sdk, nodemailer, imapflow.

import { runOutreach } from './outreach_pipeline.mjs'
import Anthropic from '@anthropic-ai/sdk'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import fs from 'fs'

const MODEL = process.env.DIGEST_MODEL || 'claude-sonnet-5'
const GMAIL_USER = process.env.GMAIL_USER || 'theneuroreview@gmail.com'
const DIGEST_TO = process.env.DIGEST_TO || 'theneuroreview@gmail.com'
// App passwords show with spaces in Google's UI; strip them before use.
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')
// Any value other than the exact string 'false' keeps outreach in dry-run (fail safe).
const DRY_RUN = process.env.DRY_RUN !== 'false'
const MAX_SENDS = process.env.MAX_SENDS || '3'
const BUTTONDOWN_API_KEY = process.env.BUTTONDOWN_API_KEY || ''
const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE || 'theneuroreview.bsky.social'
const BLUESKY_APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD || ''

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const now = new Date()
const niceDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
const monthDay = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fence ? fence[1] : (text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/) || [])[1]
  if (!raw) throw new Error('no JSON found: ' + String(text).slice(0, 200))
  return JSON.parse(raw)
}

async function ask(prompt, { maxTokens = 1500 } = {}) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  if (!text) console.error(`empty text (stop_reason=${msg.stop_reason}, blocks=${msg.content.map((b) => b.type).join(',')})`)
  return text
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()

// Run a named section in isolation. A thrown/failed section returns its fallback
// so the rest of the digest AND the email still go out.
async function section(name, fn, fallback) {
  try {
    return await fn()
  } catch (e) {
    console.error(`[${name}] failed:`, e && e.message ? e.message : e)
    return fallback
  }
}

// --- 2. INBOX CONCIERGE — draft-only, NEVER sends ----------------------------
// Reads the last ~26h of INBOX read-only, skips self / automated / no-reply mail,
// and asks the model to classify + draft a reply (in Cameron's voice) for anything
// that needs one. Returns { needsYou: [{from, subject, category, draftReply}], error }.
function shouldSkip(m) {
  const fromAddr = m.fromAddr
  if (!fromAddr) return true
  if (fromAddr === GMAIL_USER.toLowerCase()) return true
  if (fromAddr.includes('no-reply') || fromAddr.includes('noreply') ||
      fromAddr.includes('mailer-daemon') || fromAddr.includes('notifications@')) return true
  const subj = (m.subject || '').trim().toLowerCase()
  if (subj.startsWith('outreach run')) return true
  if (subj.startsWith('daily digest')) return true
  return false
}

// Best-effort plain-text snippet from a raw RFC822 source buffer: take the body
// after the first blank line, strip HTML tags, collapse whitespace, truncate.
function snippetFromSource(source) {
  try {
    const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source || '')
    const sep = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') + 4 : (raw.indexOf('\n\n') >= 0 ? raw.indexOf('\n\n') + 2 : 0)
    let body = raw.slice(sep)
    body = body.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    body = body.replace(/<[^>]+>/g, ' ')
    return clean(body).slice(0, 800)
  } catch {
    return ''
  }
}

async function classify(m) {
  const prompt = `You are triaging one email in the inbox of The Neuroscience Review, a rigorous plain-English neuroscience publication run by Cameron, who studies neuroscience at Columbia.
FROM: ${m.from}
SUBJECT: ${m.subject}
SNIPPET:
${m.snippet || '(no preview available)'}

Decide whether this email needs a personal reply from Cameron. Classify its category as exactly one of: contributor (a writer, collaborator, or pitch), submission (someone offering or submitting a piece), reader (a reader question, comment, or note), or other (anything else, including promotions and pure notifications that need no reply).
If it needs a reply, draft a short reply in Cameron's own voice. VOICE RULES, follow every one:
- No em-dashes anywhere. No colons or semicolons used as prose punctuation.
- Warm, plain, and human. No hype.
- Describe Cameron as "studies neuroscience at Columbia", never "undergrad" or "undergraduate".
- Never call the publication "small" or "a newsletter". It is a review, a publication.
- Do not invent facts. Keep unknown details general.
- Sign off as Cameron.
If it does not need a reply, return an empty string for draftReply.
Return ONLY JSON {"needsReply":true|false,"category":"contributor"|"submission"|"reader"|"other","draftReply":"the reply text, or empty string"}.`
  const out = extractJson(await ask(prompt, { maxTokens: 900 }))
  return {
    needsReply: Boolean(out.needsReply),
    category: ['contributor', 'submission', 'reader', 'other'].includes(out.category) ? out.category : 'other',
    draftReply: String(out.draftReply || '').trim(),
  }
}

async function inboxConcierge() {
  const needsYou = []
  let imap
  try {
    imap = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      logger: false,
    })
    await imap.connect()
    await imap.mailboxOpen('INBOX', { readOnly: true })
    const since = new Date(now.getTime() - 26 * 60 * 60 * 1000)
    let seqs = await imap.search({ since })
    if (!Array.isArray(seqs)) seqs = []
    seqs = seqs.sort((a, b) => b - a).slice(0, 40) // newest first, capped

    const msgs = []
    if (seqs.length > 0) {
      for await (const msg of imap.fetch(seqs, { envelope: true, source: true })) {
        const env = msg.envelope || {}
        const first = Array.isArray(env.from) && env.from[0] ? env.from[0] : {}
        const fromAddr = String(first.address || '').trim().toLowerCase()
        const fromName = clean(first.name || '')
        msgs.push({
          from: fromName ? `${fromName} <${first.address || ''}>` : (first.address || '(unknown)'),
          fromAddr,
          subject: clean(env.subject) || '(no subject)',
          snippet: snippetFromSource(msg.source),
        })
      }
    }

    for (const m of msgs) {
      if (shouldSkip(m)) continue
      try {
        const cls = await classify(m)
        if (cls.needsReply) {
          needsYou.push({ from: m.from, subject: m.subject, category: cls.category, draftReply: cls.draftReply })
        }
      } catch (e) {
        console.error('classify failed for', m.from, e.message)
      }
    }
  } catch (e) {
    return { needsYou, error: e.message }
  } finally {
    try { if (imap) await imap.logout() } catch (e) { /* ignore close errors */ }
  }
  return { needsYou, error: null }
}

// --- 3. WEDNESDAY GUARDIAN ---------------------------------------------------
// Coming Wednesday (>= today). Scheduled if a publish-*.yml has a future-dated
// cron within the next 7 days, OR a post file in posts/ carries a date this week.
function comingWednesday(from = now) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  const diff = (3 - d.getUTCDay() + 7) % 7 // days until Wednesday (0 if today is Wed)
  d.setUTCDate(d.getUTCDate() + diff)
  return d
}

function wednesdayGuardian(cwd) {
  const target = comingWednesday()
  const targetLabel = target.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  // (a) a publish-*.yml with a future-dated cron within the next 7 days
  try {
    const dir = `${cwd}/.github/workflows`
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^publish-.*\.ya?ml$/.test(f)) : []
    for (const f of files) {
      const txt = fs.readFileSync(`${dir}/${f}`, 'utf8')
      for (const rawLine of txt.split('\n')) {
        const line = rawLine.trim()
        if (line.startsWith('#')) continue // skip commented-out crons
        const m = line.match(/cron:\s*['"]([^'"]+)['"]/)
        if (!m) continue
        const parts = m[1].trim().split(/\s+/)
        if (parts.length < 5) continue
        const min = parseInt(parts[0], 10) || 0
        const hr = parseInt(parts[1], 10) || 0
        const dom = parseInt(parts[2], 10)
        const mon = parseInt(parts[3], 10)
        if (Number.isNaN(dom) || Number.isNaN(mon)) continue // not a specific date
        const year = now.getUTCFullYear()
        let dt = new Date(Date.UTC(year, mon - 1, dom, hr, min))
        if (dt < now) dt = new Date(Date.UTC(year + 1, mon - 1, dom, hr, min)) // roll to next year if already past
        if (dt >= now && dt <= in7) {
          return { status: `on track (workflow ${f})`, scheduled: true, target: targetLabel }
        }
      }
    }
  } catch (e) {
    console.error('cron scan failed:', e.message)
  }

  // (b) a post file dated this week (the 7 days ending on the coming Wednesday)
  try {
    const postsDir = `${cwd}/posts`
    if (fs.existsSync(postsDir)) {
      const weekStart = new Date(target.getTime() - 6 * 24 * 60 * 60 * 1000)
      for (const f of fs.readdirSync(postsDir).filter((f) => f.endsWith('.html'))) {
        const html = fs.readFileSync(`${postsDir}/${f}`, 'utf8')
        const dates = [...html.matchAll(/datetime=["'](\d{4}-\d{2}-\d{2})/g)].map((mm) => new Date(mm[1] + 'T00:00:00Z'))
        if (dates.some((d) => !Number.isNaN(d.getTime()) && d >= weekStart && d <= target)) {
          return { status: `on track (post file ${f})`, scheduled: true, target: targetLabel }
        }
      }
    }
  } catch (e) {
    console.error('post-file scan failed:', e.message)
  }

  return { status: 'NOT SCHEDULED — flag', scheduled: false, target: targetLabel }
}

// --- 4. NUMBERS --------------------------------------------------------------
async function buttondownCount() {
  if (!BUTTONDOWN_API_KEY) return 'n/a'
  try {
    const res = await fetch('https://api.buttondown.email/v1/subscribers?type=regular', {
      headers: { Authorization: `Token ${BUTTONDOWN_API_KEY}` },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) { console.error('Buttondown HTTP', res.status); return 'n/a' }
    const j = await res.json()
    return typeof j.count === 'number' ? j.count : 'n/a'
  } catch (e) {
    console.error('Buttondown fetch failed:', e.message)
    return 'n/a'
  }
}

async function blueskyStats() {
  if (!BLUESKY_APP_PASSWORD) return { followers: 'n/a', posts: 'n/a' }
  try {
    const s = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: BLUESKY_HANDLE, password: BLUESKY_APP_PASSWORD }),
      signal: AbortSignal.timeout(20000),
    })
    if (!s.ok) { console.error('Bluesky login HTTP', s.status); return { followers: 'n/a', posts: 'n/a' } }
    const sess = await s.json()
    const p = await fetch(`https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(BLUESKY_HANDLE)}`, {
      headers: { authorization: `Bearer ${sess.accessJwt}` },
      signal: AbortSignal.timeout(20000),
    })
    if (!p.ok) { console.error('Bluesky profile HTTP', p.status); return { followers: 'n/a', posts: 'n/a' } }
    const prof = await p.json()
    return {
      followers: typeof prof.followersCount === 'number' ? prof.followersCount : 'n/a',
      posts: typeof prof.postsCount === 'number' ? prof.postsCount : 'n/a',
    }
  } catch (e) {
    console.error('Bluesky stats failed:', e.message)
    return { followers: 'n/a', posts: 'n/a' }
  }
}

// --- 5. COMPOSE the one plain-text email -------------------------------------
function composeBody({ outreach, concierge, wed, subscribers, bluesky }) {
  const L = []
  L.push(`The Neuroscience Review — daily digest ${monthDay}`)
  L.push('')

  // (1) NEEDS YOU — reply drafts + the Wednesday flag if not scheduled.
  L.push('=== NEEDS YOU ===')
  const needs = []
  for (const n of concierge.needsYou) {
    needs.push(`[${n.category}] from ${n.from}`)
    needs.push(`  re "${n.subject}"`)
    needs.push('  suggested reply:')
    for (const ln of (n.draftReply || '(needs a reply, no draft available)').split('\n')) needs.push(`    ${ln}`)
    needs.push('')
  }
  if (!wed.scheduled) {
    needs.push(`Wednesday post for ${wed.target} is ${wed.status}.`)
    needs.push('  No scheduled publish workflow or dated post file was found for the coming week.')
    needs.push('')
  }
  if (needs.length === 0) {
    L.push('Nothing needs you today.')
  } else {
    L.push(...needs)
  }
  if (concierge.error) L.push(`(inbox concierge note: ${concierge.error})`)
  L.push('')

  // (2) OUTREACH
  L.push('=== OUTREACH ===')
  const sentN = (outreach.sent || []).length
  const heldN = (outreach.held || []).length
  const mode = DRY_RUN ? 'dry run, nothing was emailed to targets' : 'live'
  L.push(`${sentN} sent / ${heldN} held (${mode}).`)
  if (outreach.imapOk === false) L.push(`WARNING: IMAP dedup was unavailable, so nothing was sent this run (fail safe). ${outreach.imapError || ''}`.trim())
  L.push('sent:')
  if (sentN === 0) L.push('  (none)')
  for (const s of (outreach.sent || [])) L.push(`  - ${s.name} <${s.email}> [${s.kind}] ${s.subject}`)
  L.push('held:')
  if (heldN === 0) L.push('  (none)')
  for (const h of (outreach.held || [])) L.push(`  - ${h.name}${h.email ? ` <${h.email}>` : ''} ${h.reason}`)
  L.push('')

  // (3) NUMBERS
  L.push('=== NUMBERS ===')
  L.push(`Buttondown subscribers: ${subscribers}`)
  L.push(`Bluesky followers: ${bluesky.followers}, posts: ${bluesky.posts}`)
  L.push('')

  // (4) footer
  L.push('---')
  L.push('Cloudflare traffic stats need an API token added before they can appear here.')
  return L.join('\n')
}

async function sendDigest(body) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  })
  await transporter.sendMail({
    from: GMAIL_USER,
    to: DIGEST_TO,
    subject: `The Neuroscience Review — daily digest ${monthDay}`,
    text: body,
  })
}

async function main() {
  // 1. OUTREACH (the vetted engine, folded in — live on the cron).
  const outreach = await section('outreach',
    () => runOutreach({ dryRun: DRY_RUN, maxSends: MAX_SENDS }),
    { sent: [], held: [], imapOk: null, imapError: null })

  // 2. INBOX CONCIERGE (draft only).
  const concierge = await section('concierge',
    () => inboxConcierge(),
    { needsYou: [], error: 'concierge did not run' })

  // 3. WEDNESDAY GUARDIAN.
  const wed = await section('wednesday',
    async () => wednesdayGuardian(process.cwd()),
    { status: 'could not check', scheduled: true, target: '' })

  // 4. NUMBERS.
  const subscribers = await section('buttondown', () => buttondownCount(), 'n/a')
  const bluesky = await section('bluesky', () => blueskyStats(), { followers: 'n/a', posts: 'n/a' })

  // 5. COMPOSE + SEND one email.
  const body = composeBody({ outreach, concierge, wed, subscribers, bluesky })
  console.log('\n' + body + '\n')

  await section('email', async () => {
    await sendDigest(body)
    console.log('Daily digest emailed to', DIGEST_TO)
  }, null)

  // Structured artifact for inspection / handoff (not committed).
  try {
    fs.writeFileSync('.github/digest-latest.json', JSON.stringify({
      date: niceDate,
      dryRun: DRY_RUN,
      needsYou: concierge.needsYou,
      wednesday: wed,
      outreach: { sent: outreach.sent, held: outreach.held, imapOk: outreach.imapOk, imapError: outreach.imapError },
      numbers: { subscribers, bluesky },
    }, null, 2))
  } catch (e) {
    console.error('Could not write digest-latest.json:', e.message)
  }
}

// Never throw, never exit non-zero.
main().catch((e) => {
  console.error('Daily digest error:', e && e.stack ? e.stack : e)
  process.exit(0)
})
