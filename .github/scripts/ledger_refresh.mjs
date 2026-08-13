// Lightweight 3x/day outreach status digest for The Neuroscience Review.
// Reads the last ~7 days of the Sent folder (who we recently pitched) and the
// last ~3 days of INBOX (possible replies), and emails a concise plain-text
// summary. Read-only on IMAP. Never throws, always exits 0.
//
// Requires env GMAIL_APP_PASSWORD. Optional GMAIL_USER, LEDGER_TO.

import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'

const GMAIL_USER = process.env.GMAIL_USER || 'theneuroreview@gmail.com'
const LEDGER_TO = process.env.LEDGER_TO || 'theneuroreview@gmail.com'
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')

const now = new Date()
const niceDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000)

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()

// Pull the recent envelopes from a mailbox opened read-only. Returns an array of
// { from, to, subject, date }, newest first, capped. Any failure yields [].
async function recent(client, mailbox, since, limit) {
  const out = []
  try {
    await client.mailboxOpen(mailbox, { readOnly: true })
    let seqs = await client.search({ since })
    if (!Array.isArray(seqs)) seqs = []
    // Newest first, cap the fetch so a busy mailbox can't blow up the run.
    seqs = seqs.sort((a, b) => b - a).slice(0, limit)
    if (seqs.length === 0) return out
    for await (const msg of client.fetch(seqs, { envelope: true })) {
      const env = msg.envelope || {}
      const addr = (list) => (Array.isArray(list) ? list.map((a) => a.address).filter(Boolean).join(', ') : '')
      out.push({
        from: addr(env.from),
        to: addr(env.to),
        subject: clean(env.subject),
        date: env.date ? new Date(env.date) : null,
      })
    }
  } catch (e) {
    console.error(`fetch from ${mailbox} failed:`, e.message)
  }
  return out
}

async function main() {
  let client
  let pitched = []
  let inbound = []
  try {
    client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      logger: false,
    })
    await client.connect()
    pitched = await recent(client, '[Gmail]/Sent Mail', daysAgo(7), 60)
    inbound = await recent(client, 'INBOX', daysAgo(3), 60)
  } catch (e) {
    console.error('IMAP connect failed:', e.message)
  } finally {
    try { if (client) await client.logout() } catch (e) { /* ignore close errors */ }
  }

  const lines = []
  lines.push(`Outreach ledger — ${niceDate}`)
  lines.push('')
  lines.push(`Pitched in last 7 days (${pitched.length}):`)
  if (pitched.length === 0) lines.push('  (none, or Sent folder unavailable)')
  for (const m of pitched) {
    const d = m.date ? m.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'
    lines.push(`  - ${d}  to ${m.to || '?'}  — ${m.subject || '(no subject)'}`)
  }
  lines.push('')
  lines.push(`Recent inbound, possible replies (last 3 days, ${inbound.length}):`)
  if (inbound.length === 0) lines.push('  (none, or INBOX unavailable)')
  for (const m of inbound) {
    const d = m.date ? m.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'
    lines.push(`  - ${d}  from ${m.from || '?'}  — ${m.subject || '(no subject)'}`)
  }
  const digest = lines.join('\n')
  console.log('\n' + digest + '\n')

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    })
    await transporter.sendMail({
      from: GMAIL_USER,
      to: LEDGER_TO,
      subject: `Outreach ledger ${niceDate} — ${pitched.length} pitched, ${inbound.length} inbound`,
      text: digest,
    })
    console.log('Ledger emailed to', LEDGER_TO)
  } catch (e) {
    console.error('Could not email ledger:', e.message)
  }
}

main().catch((e) => {
  console.error('Ledger refresh error:', e && e.stack ? e.stack : e)
  process.exit(0)
})
