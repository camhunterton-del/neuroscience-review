// Mirror the newest few News items onto the homepage "Latest news" rail.
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
const COUNT = 3

try {
  const news = fs.readFileSync(NEWS_FILE, 'utf8')
  const fStart = news.indexOf('<!-- NEWS-FEED-START -->')
  const fEnd = news.indexOf('<!-- NEWS-FEED-END -->')
  if (fStart === -1 || fEnd === -1) {
    console.warn('Home rail sync: news feed markers not found; homepage unchanged.')
    process.exit(0)
  }
  const feed = news.slice(fStart, fEnd)
  const articles = feed
    .split(/(?=<article class="news-item">)/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('<article class="news-item">'))

  const items = articles.slice(0, COUNT).map((art) => {
    const url = (art.match(/<h[23]><a href="([^"]+)"/) || [])[1] || ''
    const headline = (art.match(/<h[23]><a [^>]*>([\s\S]*?)<\/a><\/h[23]>/) || [])[1] || ''
    const meta = (art.match(/news-item__meta">([\s\S]*?)<\/p>/) || [])[1] || ''
    const date = (meta.split('&middot;')[0] || '').trim()
    const source = ((meta.match(/>([^<]+)<\/a>/) || [])[1] || '').trim()
    return { url, headline, date, source }
  }).filter((it) => it.url && it.headline)

  if (items.length === 0) {
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

  const lis = items.map((it) =>
`              <li class="home-news__item">
                <a class="home-news__headline" href="${it.url}" target="_blank" rel="noopener">${it.headline}</a>
                <span class="home-news__meta">${it.date} &middot; ${it.source}</span>
              </li>`).join('\n')

  const rebuilt = home.slice(0, s + START.length) + '\n' + lis + '\n              ' + home.slice(e)
  if (rebuilt === home) {
    console.log('Home rail already in sync.')
  } else {
    fs.writeFileSync(HOME_FILE, rebuilt)
    console.log(`Home rail synced to newest ${items.length} item(s): ` + items.map((i) => i.headline).join(' | '))
  }
} catch (err) {
  console.warn('Home rail sync skipped:', err.message)
  process.exit(0)
}
