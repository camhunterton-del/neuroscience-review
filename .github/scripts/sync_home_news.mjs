// Mirror the newest few News briefs onto the homepage "Research briefs" rail.
//
// Reads the freshly-built news.html and rewrites index.html between the
// HOME-NEWS markers so the landing page never drifts behind the News feed.
//
// Deliberately separate from news_pipeline.mjs: that script does all the
// scouting/vetting/publishing and only ever touches news.html. This runs
// AFTER it as a small, idempotent, best-effort step — if anything looks off
// it logs and leaves index.html untouched (exit 0), so it can never break the
// daily publish. index.html is not touched by the scheduled post-merge, so
// this cannot collide with that either.
import fs from 'fs'

const NEWS_FILE = 'news.html'
const HOME_FILE = 'index.html'
const COUNT = 7

// The hand-authored rail writes apostrophes as the typographic entity &rsquo;
// (and the news h2 stores a straight '), so convert on the way in to reproduce
// the rail markup byte for byte. A plain & is left alone (news source names
// already carry &amp;), and no card currently uses a bare & in a headline.
const toRail = (s) => String(s)
  .replace(/['’]/g, '&rsquo;')
  .replace(/‘/g, '&lsquo;')

try {
  const news = fs.readFileSync(NEWS_FILE, 'utf8')
  const fStart = news.indexOf('<!-- NEWS-FEED-START -->')
  const fEnd = news.indexOf('<!-- NEWS-FEED-END -->')
  if (fStart === -1 || fEnd === -1) {
    console.warn('Home rail sync: news feed markers not found; homepage unchanged.')
    process.exit(0)
  }
  const feed = news.slice(fStart, fEnd)

  // One block PER card: split on `<article class="news-item"` FOLLOWED BY optional
  // attributes (every card now carries id="n-SLUG"), not the old bare tag that
  // matched zero of the new cards and left the homepage stale.
  const articles = feed
    .split(/(?=<article class="news-item"[\s>])/)
    .map((s) => s.trim())
    .filter((s) => /^<article class="news-item"[\s>]/.test(s))

  const cards = articles.map((art) => {
    const id = (art.match(/<article class="news-item"[^>]*\bid="([^"]+)"/) || [])[1] || ''
    const headline = (art.match(/<h[23]><a [^>]*>([\s\S]*?)<\/a><\/h[23]>/) || [])[1] || ''
    const meta = (art.match(/news-item__meta">([\s\S]*?)<\/p>/) || [])[1] || ''
    const date = (meta.split('&middot;')[0] || '').trim()
    const source = ((meta.match(/>([^<]+)<\/a>/) || [])[1] || '').trim()
    return { id, headline, date, source }
  }).filter((c) => c.id && c.headline)

  if (cards.length === 0) {
    console.warn('Home rail sync: no parseable news items; homepage unchanged.')
    process.exit(0)
  }

  const home = fs.readFileSync(HOME_FILE, 'utf8')
  const START = '<!-- HOME-NEWS-START -->'
  const END = '<!-- HOME-NEWS-END -->'
  const s = home.indexOf(START)
  const e = home.indexOf(END)
  if (s === -1 || e === -1) {
    console.warn('Home rail sync: HOME-NEWS markers not found; homepage unchanged.')
    process.exit(0)
  }

  // Do not repeat a brief the homepage already features OUTSIDE the rail: the
  // "AI & the Brain" feature cards link to news.html#n-SLUG too, and the rail is
  // meant to carry the newest briefs NOT already surfaced there. Scan the page
  // with the rail region removed and skip any slug it already links to.
  const outsideRail = home.slice(0, s) + home.slice(e + END.length)
  const featured = new Set([...outsideRail.matchAll(/news\.html#(n-[a-z0-9-]+)/g)].map((m) => m[1]))

  const items = cards.filter((c) => !featured.has(c.id)).slice(0, COUNT)
  if (items.length === 0) {
    console.warn('Home rail sync: every recent brief is already featured; homepage unchanged.')
    process.exit(0)
  }

  // Reproduce the rail card markup exactly: a <li> with an .latest-item link to
  // the brief's permalink (news.html#n-SLUG) and the source / title / date spans.
  const lis = items.map((it) =>
`            <li>
              <a class="latest-item" href="news.html#${it.id}">
                <span class="tag src">${toRail(it.source)}</span>
                <span class="latest-item__title">${toRail(it.headline)}</span>
                <span class="latest-item__date">${it.date}</span>
              </a>
            </li>`).join('\n')

  const rebuilt = home.slice(0, s + START.length) + '\n' + lis + '\n            ' + home.slice(e)
  if (rebuilt === home) {
    console.log('Home rail already in sync.')
  } else {
    fs.writeFileSync(HOME_FILE, rebuilt)
    console.log(`Home rail synced to newest ${items.length} brief(s): ` + items.map((i) => i.headline).join(' | '))
  }
} catch (err) {
  console.warn('Home rail sync skipped:', err.message)
  process.exit(0)
}
