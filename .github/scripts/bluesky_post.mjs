// Post up to 2 of today's newly published news items to Bluesky.
// Reads .github/news-latest.json (written by news_pipeline.mjs each run).
// Needs BLUESKY_APP_PASSWORD (and optional BLUESKY_HANDLE). Skips gracefully if
// the password is unset, and NEVER exits non-zero, so it can never block the
// news pipeline or the commit that publishes the News page.

import fs from 'fs'

const HANDLE = process.env.BLUESKY_HANDLE || 'theneuroreview.bsky.social'
const PASS = process.env.BLUESKY_APP_PASSWORD
const PDS = 'https://bsky.social'
const MAX_POSTS = 2

async function buildEmbed(it, jwt) {
  // A link card that carries the source, title, and (when possible) its preview image.
  const external = {
    uri: it.sourceUrl,
    title: String(it.headline || '').slice(0, 280),
    description: it.sourceName ? `via ${it.sourceName}` : '',
  }
  try {
    if (it.image) {
      const imgRes = await fetch(it.image, { signal: AbortSignal.timeout(15000) })
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer())
        const mime = imgRes.headers.get('content-type') || 'image/jpeg'
        if (buf.length <= 976 * 1024 && /^image\//.test(mime)) {
          const up = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, {
            method: 'POST',
            headers: { 'content-type': mime, authorization: `Bearer ${jwt}` },
            body: buf,
          })
          if (up.ok) external.thumb = (await up.json()).blob
          else console.error('uploadBlob failed:', up.status)
        }
      }
    }
  } catch (e) {
    console.error('thumb skipped:', e.message)
  }
  return { $type: 'app.bsky.embed.external', external }
}

function buildText(it) {
  // Lead with the plain finding; add the honest caveat when it fits. The pipeline
  // already writes these with no colons, semicolons, or dashes, matching the voice.
  const summary = String(it.summary || it.headline || '').trim()
  const caveat = String(it.caveat || '').trim()
  let text = summary
  if (caveat && (summary.length + caveat.length + 1) <= 285) text = `${summary} ${caveat}`
  if (text.length > 290) text = text.slice(0, 289).trim() + '…'
  return text
}

async function main() {
  if (!PASS) {
    console.log('BLUESKY_APP_PASSWORD not set — skipping Bluesky auto-post (add the secret to enable).')
    return
  }
  let items
  try {
    items = JSON.parse(fs.readFileSync('.github/news-latest.json', 'utf8'))
  } catch {
    console.log('No news-latest.json — nothing to post.')
    return
  }
  if (!Array.isArray(items) || items.length === 0) {
    console.log('No new items to post.')
    return
  }
  items = items.slice(0, MAX_POSTS)

  const sres = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: HANDLE, password: PASS }),
  })
  if (!sres.ok) {
    console.error('Bluesky login failed:', sres.status, await sres.text())
    return
  }
  const session = await sres.json()

  let posted = 0
  for (const it of items) {
    try {
      const text = buildText(it)
      const embed = await buildEmbed(it, session.accessJwt)
      const record = { $type: 'app.bsky.feed.post', text, embed, langs: ['en'], createdAt: new Date().toISOString() }
      const res = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessJwt}` },
        body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
      })
      if (!res.ok) {
        console.error('createRecord failed:', res.status, await res.text())
        continue
      }
      posted++
      console.log('Posted to Bluesky:', it.headline)
    } catch (e) {
      console.error('Failed to post', it && it.headline, e.message)
    }
  }
  console.log(`Bluesky auto-post: ${posted}/${items.length} sent.`)
}

main().catch((e) => { console.error('Bluesky poster error:', e.message) })
