// Autonomous weekday-morning contributor-outreach engine for The Neuroscience Review.
// Runs in GitHub Actions: researches NEW outreach targets (Feature journalists +
// student "Commons" orgs) with the Claude API + web search, dedups against everyone
// we have ever emailed (via IMAP on the Sent folder), drafts a personalized pitch,
// double-verifies each one, and — unless DRY_RUN — sends up to MAX_SENDS of them,
// then emails a plain-text digest of what was sent and what was held.
//
// Requires env ANTHROPIC_API_KEY, GMAIL_APP_PASSWORD. Never throws, never exits
// non-zero: a failure anywhere degrades to "held" rather than a double-contact.
// Writes sent=<n> to GITHUB_OUTPUT and a structured .github/outreach-latest.json.

import Anthropic from '@anthropic-ai/sdk'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import fs from 'fs'

const MODEL = process.env.OUTREACH_MODEL || 'claude-sonnet-5'
const GMAIL_USER = process.env.GMAIL_USER || 'theneuroreview@gmail.com'
const OUTREACH_TO = process.env.OUTREACH_TO || 'theneuroreview@gmail.com'
// Any value other than the exact string 'false' keeps us in dry-run (fail safe).
const DRY_RUN = process.env.DRY_RUN !== 'false'
const MAX_SENDS = Math.max(0, parseInt(process.env.MAX_SENDS || '3', 10) || 0)
// App passwords are shown with spaces in Google's UI; strip them before use.
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')

// Optional exclusion list injected via the OUTREACH_EXCLUDE repo secret (comma or
// newline separated). Holds emails and/or name fragments of people we have ALREADY
// contacted from OTHER accounts (e.g. the Columbia address, which this run's IMAP
// dedup cannot see). Kept in a secret, never committed, so no contact info lands in
// the public repo. Anyone matching is treated as already contacted.
const EXCLUDE = (process.env.OUTREACH_EXCLUDE || '')
  .split(/[\n,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
const excludeEmails = new Set(EXCLUDE.filter((s) => s.includes('@')))
const excludeNames = EXCLUDE.filter((s) => s && !s.includes('@'))
function onExcludeList(c) {
  const email = String(c.email || '').trim().toLowerCase()
  if (email && excludeEmails.has(email)) return true
  const name = String(c.name || '').toLowerCase()
  return excludeNames.some((n) => n.length >= 4 && name.includes(n))
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const now = new Date()
const niceDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fence ? fence[1] : (text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/) || [])[1]
  if (!raw) throw new Error('no JSON found: ' + String(text).slice(0, 200))
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

const normEmail = (e) => String(e || '').trim().toLowerCase()

// --- 1. RESEARCH: up to 6 fresh targets across two lanes ---------------------
async function research() {
  const prompt = `You are scouting NEW contributor-outreach targets for The Neuroscience Review, a rigorous plain-English neuroscience publication (theneuroreview.com). Today is ${niceDate}. Use web search to find up to 6 real, current targets across TWO lanes:
(a) established freelance science or neuroscience journalists or authors who are NOT students and who have a public professional bio or portfolio — these are for paid Feature commissions. Mark these {"kind":"feature"}.
(b) student science-communication organizations, university science magazines, or neuroscience club journals — these are for "The Commons", our students-welcome community lane. Mark these {"kind":"commons"}.
For every target, find a REAL, PUBLIC, PROFESSIONAL contact email where one is findable (a masthead address, a public "contact" or "pitch" address, or a professional address on their own site). If no genuinely public professional email exists, return an empty string for email rather than guessing or inventing one. Do not invent people, orgs, emails, or URLs.
Return ONLY a JSON array, each element {"name":..., "kind":"feature"|"commons", "email":"public professional email or empty string", "org":..., "beat":"their subject area / what they cover", "bioUrl":"their public bio or portfolio or org page", "whyFit":"one sentence on why they fit this lane"}. No prose outside the JSON.`
  try {
    const batch = extractJson(await ask(prompt, { web: true, maxTokens: 6000, maxUses: 6 }))
    return (Array.isArray(batch) ? batch : []).slice(0, 6).map((c) => ({
      name: String(c.name || '').trim(),
      kind: c.kind === 'commons' ? 'commons' : 'feature',
      email: normEmail(c.email),
      org: String(c.org || '').trim(),
      beat: String(c.beat || '').trim(),
      bioUrl: String(c.bioUrl || '').trim(),
      whyFit: String(c.whyFit || '').trim(),
    })).filter((c) => c.name)
  } catch (e) {
    console.error('Research failed:', e.message)
    return []
  }
}

// --- 2. DEDUP: have we EVER emailed this address? ---------------------------
// Fail safe: if IMAP is unreachable we send NOTHING this run rather than risk a
// double-contact. Returns { ok, error }; sets c.alreadyContacted on each candidate.
async function dedup(candidates) {
  const withEmail = candidates.filter((c) => c.email)
  if (withEmail.length === 0) return { ok: true, error: null }
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
    await imap.mailboxOpen('[Gmail]/Sent Mail', { readOnly: true })
    for (const c of withEmail) {
      try {
        const hits = await imap.search({ to: c.email })
        c.alreadyContacted = Array.isArray(hits) ? hits.length > 0 : Boolean(hits)
      } catch (e) {
        // A single failed search shouldn't fail the whole run, but we must be
        // conservative: treat an unknown result as "already contacted" so we
        // never send to an address we couldn't verify.
        console.error(`search failed for ${c.email}:`, e.message)
        c.alreadyContacted = true
      }
    }
    return { ok: true, error: null }
  } catch (e) {
    console.error('IMAP dedup failed:', e.message)
    return { ok: false, error: e.message }
  } finally {
    try { if (imap) await imap.logout() } catch (e) { /* ignore close errors */ }
  }
}

// --- 3. WRITE: personalized pitch, hard voice rules -------------------------
async function draft(c) {
  const laneBrief = c.kind === 'feature'
    ? `This is a Feature commission pitch to a credentialed, non-student journalist or author. Invite them to write a paid Feature for the publication, but NEVER mention pay, money, rates, or compensation anywhere in the pitch. Focus on their work and the fit.`
    : `This is a Commons invitation to a student science-communication org, university science magazine, or neuroscience club journal. Invite them and their members into The Commons, our students-welcome community lane at theneuroreview.com.`
  const prompt = `Write a short, warm, personalized outreach email as Cameron, who studies neuroscience at Columbia and runs The Neuroscience Review (theneuroreview.com).
Recipient: ${c.name}${c.org ? ` at ${c.org}` : ''}. Lane: ${c.kind}. Their beat/work: ${c.beat || 'unknown'}. Reference for personalizing: ${c.bioUrl || 'n/a'}. Why they fit: ${c.whyFit || 'n/a'}.
${laneBrief}
HARD VOICE RULES (follow every one):
- No em-dashes anywhere. No colons or semicolons used as prose punctuation.
- Contractions are fine. Warm, plain, and human. No hype.
- Describe Cameron as "studies neuroscience at Columbia". Never "undergrad" or "undergraduate".
- Never call the publication "small" or "a newsletter". It is a review, a publication.
- Personalize with the person's actual beat or work above. Do not invent facts about them.
- Feature pitches must NEVER mention pay or money.
- Commons pitches invite them into the students-welcome community lane.
- Sign off as Cameron, then a line "The Neuroscience Review", then "theneuroreview.com".
- No leftover placeholder or bracket text.
Return ONLY JSON {"subject":..., "body":...}. The body is plain text with real line breaks.`
  const d = extractJson(await ask(prompt, { maxTokens: 1200 }))
  return { subject: String(d.subject || '').trim(), body: String(d.body || '').trim() }
}

// --- 4. VERIFY 1: is this a real, correctly-laned target? -------------------
async function verify1(c) {
  const prompt = `You are validating a contributor-outreach target before we email them. Target: name "${c.name}", kind "${c.kind}", email "${c.email}", org "${c.org}", beat "${c.beat}".
Return ONLY JSON {"pass":true|false,"reason":"one line"}. Pass ONLY if all hold: this reads as a real, identifiable person or organization; the email looks plausibly correct for them; the lane fits (feature = a credentialed non-student journalist or author; commons = a student, student org, university magazine, or club journal); and nothing screams that this is already a known contact or a duplicate. When in doubt, fail.`
  return extractJson(await ask(prompt, { maxTokens: 500 }))
}

// --- 5. VERIFY 2: does the draft actually pass muster? ----------------------
async function verify2(c) {
  const prompt = `You are proofing an outreach email before it is sent to ${c.name} <${c.email}> (lane: ${c.kind}).
SUBJECT: ${c.draft.subject}
BODY:
${c.draft.body}
Return ONLY JSON {"pass":true|false,"reason":"one line"}. Pass ONLY if ALL hold: it is addressed to the correct person by the correct name; it invents no facts about them; it follows every voice rule (no em-dashes; no colons or semicolons as prose punctuation; describes Cameron as "studies neuroscience at Columbia" never "undergrad"; never calls the publication "small" or "a newsletter"); a Feature pitch mentions NO pay or money; it has a proper sign-off as Cameron / The Neuroscience Review / theneuroreview.com; and it contains no leftover placeholder or bracket text. When in doubt, fail.`
  return extractJson(await ask(prompt, { maxTokens: 500 }))
}

function buildTransport() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  })
}

async function main() {
  const candidates = await research()
  console.log(`Research surfaced ${candidates.length} candidate(s).`)

  const imap = await dedup(candidates)

  const sent = []       // actually sent (or would-send in dry-run)
  const held = []       // { name, email, reason }

  for (const c of candidates) {
    // Reasons that drop a candidate before drafting.
    if (onExcludeList(c)) { held.push({ name: c.name, email: c.email, reason: 'on exclude list (already contacted elsewhere)' }); continue }
    if (!c.email) { held.push({ name: c.name, email: '', reason: 'no email' }); continue }
    if (!imap.ok) { held.push({ name: c.name, email: c.email, reason: `IMAP unavailable — held to avoid double-contact (${imap.error})` }); continue }
    if (c.alreadyContacted) { held.push({ name: c.name, email: c.email, reason: 'already contacted' }); continue }

    // Fresh candidate: draft + double-verify.
    try {
      c.draft = await draft(c)
    } catch (e) {
      held.push({ name: c.name, email: c.email, reason: 'draft failed: ' + e.message })
      continue
    }
    try {
      c.verify1 = await verify1(c)
    } catch (e) {
      c.verify1 = { pass: false, reason: 'verify1 error: ' + e.message }
    }
    if (!c.verify1.pass) { held.push({ name: c.name, email: c.email, reason: 'failed verify1: ' + (c.verify1.reason || '') }); continue }

    try {
      c.verify2 = await verify2(c)
    } catch (e) {
      c.verify2 = { pass: false, reason: 'verify2 error: ' + e.message }
    }
    if (!c.verify2.pass) { held.push({ name: c.name, email: c.email, reason: 'failed verify2: ' + (c.verify2.reason || '') }); continue }

    c.sendable = true
  }

  // DECIDE + SEND, capped at MAX_SENDS.
  const sendable = candidates.filter((c) => c.sendable)
  let transporter = null
  let sendCount = 0
  for (const c of sendable) {
    if (sendCount >= MAX_SENDS) {
      held.push({ name: c.name, email: c.email, reason: 'over cap (MAX_SENDS)' })
      continue
    }
    if (DRY_RUN) {
      sent.push({ name: c.name, email: c.email, kind: c.kind, subject: c.draft.subject, wouldSend: true })
      sendCount++
      continue
    }
    try {
      if (!transporter) transporter = buildTransport()
      await transporter.sendMail({
        from: GMAIL_USER,
        to: c.email,
        subject: c.draft.subject,
        text: c.draft.body,
      })
      sent.push({ name: c.name, email: c.email, kind: c.kind, subject: c.draft.subject, wouldSend: false })
      sendCount++
      console.log('Sent to', c.email)
    } catch (e) {
      // One recipient failing must not abort the others.
      console.error('Send failed for', c.email, e.message)
      held.push({ name: c.name, email: c.email, reason: 'send failed: ' + e.message })
    }
  }

  // --- 6/7. REPORT -----------------------------------------------------------
  const sentVerb = DRY_RUN ? 'WOULD-SEND (dry run)' : 'SENT'
  const lines = []
  lines.push(`Outreach run ${niceDate}`)
  lines.push(DRY_RUN ? 'Mode: DRY RUN (nothing was actually emailed to targets)' : 'Mode: LIVE')
  lines.push(`Cap: ${MAX_SENDS} per run.`)
  if (!imap.ok) lines.push(`WARNING: IMAP dedup was unavailable this run, so nothing was sent (fail safe). Error: ${imap.error}`)
  lines.push('')
  lines.push(`== ${sentVerb} (${sent.length}) ==`)
  if (sent.length === 0) lines.push('  (none)')
  for (const s of sent) lines.push(`  - ${s.name} <${s.email}> [${s.kind}] — ${s.subject}`)
  lines.push('')
  lines.push(`== HELD / SKIPPED (${held.length}) ==`)
  if (held.length === 0) lines.push('  (none)')
  for (const h of held) lines.push(`  - ${h.name}${h.email ? ` <${h.email}>` : ''} — ${h.reason}`)
  const digest = lines.join('\n')
  console.log('\n' + digest + '\n')

  // Email the digest to OUTREACH_TO (best effort — a digest failure is non-fatal).
  try {
    if (!transporter) transporter = buildTransport()
    await transporter.sendMail({
      from: GMAIL_USER,
      to: OUTREACH_TO,
      subject: `Outreach run ${niceDate} — ${sent.length} ${DRY_RUN ? 'would-send' : 'sent'}, ${held.length} held`,
      text: digest,
    })
    console.log('Digest emailed to', OUTREACH_TO)
  } catch (e) {
    console.error('Could not email digest:', e.message)
  }

  // Structured result for later inspection / handoff.
  try {
    fs.writeFileSync('.github/outreach-latest.json', JSON.stringify({
      date: niceDate,
      dryRun: DRY_RUN,
      maxSends: MAX_SENDS,
      imapOk: imap.ok,
      imapError: imap.error,
      sent,
      held,
    }, null, 2))
  } catch (e) {
    console.error('Could not write outreach-latest.json:', e.message)
  }

  console.log(`Outreach: ${sent.length} ${DRY_RUN ? 'would-send' : 'sent'}, ${held.length} held.`)
  try { fs.appendFileSync(process.env.GITHUB_OUTPUT || '/dev/stdout', `sent=${sent.length}\n`) } catch (e) { /* non-fatal */ }
}

// Never throw, never exit non-zero: a broken run must not fail the workflow or
// leave state that could cause a double-contact next time.
main().catch((e) => {
  console.error('Outreach pipeline error:', e && e.stack ? e.stack : e)
  process.exit(0)
})
