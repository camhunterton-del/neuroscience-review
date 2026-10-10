#!/usr/bin/env python3
"""Rebuild search-index.json from the site's real content.

Why this exists
---------------
The hand-maintained index only carried a title, a category, and a one-line
excerpt per record. Body prose was never indexed, so a reader searching for a
term that lives inside an article -- a gene like ``EPHX2`` or a concept like
``interference`` -- got nothing back, even though the words are right there in
the post. This script walks the actual HTML and pulls real prose out of every
post, every news brief, and the key standing pages, so body terms become
findable. It keeps the four fields the current search UI already reads
(``title``, ``url``, ``category``, ``excerpt``) and *adds* ``body``, ``author``,
``topic``, ``format``, and ``aliases`` -- extending the record shape without
breaking it.

Run it from anywhere (stdlib only, isolation-safe):

    python3 -I .github/scripts/build_search_index.py

Pass a site root as the first argument to override autodetection. Pass
``--check`` to verify the on-disk index matches what the generator would write
(non-zero exit on drift) without rewriting the file.
"""
import html as html_mod
import json
import os
import re
import sys
from html.parser import HTMLParser

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
# The script lives at <site>/.github/scripts/build_search_index.py, so the site
# root is three directories up. An explicit argv[1] wins for flexibility/CI.
_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_ROOT = os.path.dirname(os.path.dirname(_HERE))

# Body prose kept per record. Enough to carry the real argument of a piece
# (names, genes, mechanisms) while keeping the whole index small.
BODY_LIMIT = 1200

# Tags whose text is site chrome or non-prose and must never reach the index.
SKIP_TAGS = {"script", "style", "noscript", "svg", "template", "form", "button"}
# Tags that imply a word boundary, so text across them does not glue together.
BLOCK_TAGS = {
    "p", "div", "br", "li", "ul", "ol", "section", "article", "header",
    "footer", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
    "figure", "figcaption", "td", "tr", "th", "dt", "dd", "table", "main",
    "nav", "hr",
}


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------
class _TextExtractor(HTMLParser):
    """Collect visible text from an HTML fragment, skipping scripts/styles/svg
    and anything else in SKIP_TAGS. convert_charrefs=True decodes entities
    (&rsquo; etc.) for us."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self._skip_depth += 1
        elif self._skip_depth == 0 and tag in BLOCK_TAGS:
            self._parts.append(" ")

    def handle_startendtag(self, tag, attrs):
        if self._skip_depth == 0 and tag in BLOCK_TAGS:
            self._parts.append(" ")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        elif self._skip_depth == 0 and tag in BLOCK_TAGS:
            self._parts.append(" ")

    def handle_data(self, data):
        if self._skip_depth == 0:
            self._parts.append(data)

    def get_text(self):
        return "".join(self._parts)


# Map the handful of smart-punctuation code points the site uses to plain ASCII,
# matching the convention of the existing index (straight quotes, hyphens) so a
# reader typing an ordinary apostrophe matches "don't" written as "don&rsquo;t".
_PUNCT = {
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "…": "...", " ": " ",
    "‐": "-", "‑": "-", "­": "", "​": "",
    "−": "-",
}
_PUNCT_RE = re.compile("|".join(re.escape(k) for k in _PUNCT))


def normalize(text):
    """Collapse whitespace and fold smart punctuation to ASCII."""
    if not text:
        return ""
    text = _PUNCT_RE.sub(lambda m: _PUNCT[m.group(0)], text)
    return re.sub(r"\s+", " ", text).strip()


def strip_to_text(fragment):
    """Render an HTML fragment down to normalized plain prose."""
    parser = _TextExtractor()
    parser.feed(fragment)
    parser.close()
    return normalize(parser.get_text())


def truncate(text, limit=BODY_LIMIT):
    """Trim to ~limit chars on a word boundary so the index stays small."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    sp = cut.rfind(" ")
    if sp > limit * 0.6:
        cut = cut[:sp]
    return cut.rstrip() + "..."


# ---------------------------------------------------------------------------
# Head-metadata helpers
# ---------------------------------------------------------------------------
def _meta(doc, *, prop=None, name=None):
    """Return the content of a <meta property=...> or <meta name=...> tag.
    Handles content-before-key attribute order too."""
    if prop is not None:
        key_attr, key_val = "property", prop
    else:
        key_attr, key_val = "name", name
    patterns = [
        r'<meta\s+%s="%s"\s+content="([^"]*)"' % (key_attr, re.escape(key_val)),
        r'<meta\s+content="([^"]*)"\s+%s="%s"' % (key_attr, re.escape(key_val)),
    ]
    for pat in patterns:
        m = re.search(pat, doc, re.I)
        if m:
            return normalize(html_mod.unescape(m.group(1)))
    return ""


_SITE_SUFFIX_RE = re.compile(
    r"\s*[—–|\-]\s*The Neuroscience Review\s*$", re.I
)


def clean_title(raw):
    """Drop the shared ' — The Neuroscience Review' / ' | ...' site suffix."""
    return _SITE_SUFFIX_RE.sub("", raw).strip()


def title_of(doc):
    t = _meta(doc, prop="og:title")
    if not t:
        m = re.search(r"<title>([^<]*)</title>", doc, re.I)
        t = normalize(html_mod.unescape(m.group(1))) if m else ""
    return clean_title(t)


def description_of(doc):
    return _meta(doc, prop="og:description") or _meta(doc, name="description")


# ---------------------------------------------------------------------------
# Region slicing
# ---------------------------------------------------------------------------
def _slice(doc, start_marker, end_marker):
    """Return the substring from the tag containing start_marker up to
    end_marker. Used to isolate the real content region before text extraction
    so nav/footer chrome never gets indexed."""
    i = doc.find(start_marker)
    if i == -1:
        return ""
    # Back up to the start of the enclosing tag.
    lt = doc.rfind("<", 0, i)
    if lt != -1:
        i = lt
    j = doc.find(end_marker, i + 1)
    if j == -1:
        j = len(doc)
    return doc[i:j]


def post_body_text(doc):
    """Prose of an article: the .post-body region, which runs up to the
    .post-end footer in every post template."""
    region = _slice(doc, 'class="post-body"', 'class="post-end"')
    if not region:
        region = _slice(doc, "<main", "</main>")
    return strip_to_text(region)


def page_main_text(doc):
    """Prose of a standing page: everything inside <main> (nav sits before it
    and the footer after it, so <main> is already free of shared chrome)."""
    region = _slice(doc, "<main", "</main>")
    return strip_to_text(region)


# ---------------------------------------------------------------------------
# Aliases
# ---------------------------------------------------------------------------
_STOP = {
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "but",
    "is", "are", "was", "were", "be", "do", "does", "did", "your", "you",
    "my", "our", "we", "it", "its", "what", "why", "how", "when", "where",
    "who", "that", "this", "with", "from", "into", "out", "run", "get",
    "under", "before", "new", "can", "all", "not", "one", "two", "has",
    "n", "html", "posts", "topics", "authors", "tools", "feature",
}

# A few high-value expansions keyed by a token that appears in the content.
# Attached only when that token is present, so they stay honest and small.
_CURATED = {
    "fmri": ["bold", "functional magnetic resonance imaging"],
    "ephx2": ["soluble epoxide hydrolase"],
    "als": ["amyotrophic lateral sclerosis"],
    "glp": ["glp-1", "glucagon-like peptide"],
    "bbb": ["blood brain barrier"],
}


def slug_tokens(url):
    """Alias tokens from the filename/anchor slug (e.g.
    posts/feature-interference.html -> ['interference'])."""
    tail = url.split("/")[-1]
    tail = tail.split("#")[-1]
    tail = re.sub(r"\.html$", "", tail)
    toks = re.split(r"[^a-z0-9]+", tail.lower())
    return [t for t in toks if len(t) >= 3 and t not in _STOP]


def build_aliases(url, probe_text):
    aliases = list(dict.fromkeys(slug_tokens(url)))
    present = set(aliases)
    low = probe_text.lower()
    for key, extra in _CURATED.items():
        # Match the key as a whole token (a slug alias, or a standalone word in
        # the prose) -- never a substring, so "als" can't fire inside "animals".
        boundary = re.search(r"(?<![a-z0-9])" + re.escape(key) + r"(?![a-z0-9])", low)
        if key in present or boundary:
            for e in extra:
                if e not in aliases:
                    aliases.append(e)
    return aliases


# ---------------------------------------------------------------------------
# Record assembly
# ---------------------------------------------------------------------------
def make_record(url, title, category, excerpt, body, author="",
                topic="", fmt=""):
    """Order the four legacy keys first so the record stays a drop-in for the
    current UI, then the new fields."""
    rec = {
        "title": title,
        "url": url,
        "category": category,
        "excerpt": excerpt,
    }
    body = truncate(body)
    probe = " ".join([title, excerpt, body, topic, fmt])
    rec["body"] = body
    if author:
        rec["author"] = author
    if topic:
        rec["topic"] = topic
    if fmt:
        rec["format"] = fmt
    aliases = build_aliases(url, probe)
    if aliases:
        rec["aliases"] = aliases
    return rec


# Post eyebrows that are formats rather than content topics.
_KNOWN_FORMATS = {
    "Paper breakdown", "First principles", "Myth-busting",
    "The honest guide", "The Commons", "Column",
}


def read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def build_posts(root):
    records = []
    posts_dir = os.path.join(root, "posts")
    for name in sorted(os.listdir(posts_dir)):
        if not name.endswith(".html"):
            continue
        doc = read(os.path.join(posts_dir, name))
        title = title_of(doc)
        excerpt = description_of(doc)
        body = post_body_text(doc)
        author = _meta(doc, prop="article:author")
        m = re.search(r'class="post-header__eyebrow">([^<]*)<', doc)
        eyebrow = normalize(html_mod.unescape(m.group(1))) if m else ""
        fmt = eyebrow if eyebrow in _KNOWN_FORMATS else "Feature"
        topic = "" if eyebrow in _KNOWN_FORMATS else eyebrow
        records.append(make_record(
            url="posts/" + name,
            title=title,
            category=eyebrow or "Article",
            excerpt=excerpt,
            body=body,
            author=author,
            topic=topic,
            fmt=fmt,
        ))
    return records


_NEWS_ITEM_RE = re.compile(
    r'<article class="news-item"[^>]*\bid="(n-[a-z0-9-]+)"[^>]*>([\s\S]*?)</article>'
)
_NEWS_H_RE = re.compile(r"<h[23]>\s*(?:<a [^>]*>)?([\s\S]*?)(?:</a>)?\s*</h[23]>", re.I)


def build_news(root):
    """The news landing record plus one record per brief, anchored at
    news.html#n-<slug> so a click lands on the exact brief."""
    doc = read(os.path.join(root, "news.html"))
    # The landing record only needs its own blurb; the per-brief records below
    # carry the real prose, so indexing the whole feed here would just bloat the
    # file and make the landing match every query.
    records = [make_record(
        url="news.html",
        title=title_of(doc),
        category="News",
        excerpt=description_of(doc),
        body=description_of(doc),
        fmt="News",
    )]
    for anchor, inner in _NEWS_ITEM_RE.findall(doc):
        hm = _NEWS_H_RE.search(inner)
        title = normalize(html_mod.unescape(re.sub(r"<[^>]+>", "", hm.group(1)))) if hm else ""
        # Body = all prose paragraphs of the brief (lede + caveat), minus the
        # date/source meta line.
        paras = re.findall(r"<p(?![^>]*news-item__meta)[^>]*>([\s\S]*?)</p>", inner)
        prose = strip_to_text(" ".join(paras))
        excerpt = truncate(prose, 320)
        records.append(make_record(
            url="news.html#" + anchor,
            title=title,
            category="News",
            excerpt=excerpt,
            body=prose,
            fmt="News brief",
        ))
    return records


# Standing pages: (relative url, category label, format label). Category labels
# preserve what the current index shows; new pages get sensible labels.
_PAGES = [
    ("resources.html", "Resources", "Resource"),
    ("funding.html", "Resources", "Resource"),
    ("lab.html", "The Lab", "Interactive"),
    ("topics.html", "Topics", "Index"),
    ("authors.html", "Authors", "Index"),
    ("commons.html", "The Commons", "Index"),
    ("about.html", "About", "Page"),
    ("contribute.html", "Submissions", "Page"),
    ("start-here.html", "Start here", "Guide"),
    ("trust.html", "How we work", "Page"),
    ("brain-myths.html", "Myth-busting", "Reference"),
    ("the-paper-that-hooked-me.html", "Column", "Column"),
    ("topics/ai-and-the-brain.html", "Topics", "Topic"),
    ("topics/first-principles.html", "Topics", "Topic"),
    ("topics/myth-busting.html", "Topics", "Topic"),
    ("topics/paper-breakdown.html", "Topics", "Topic"),
    ("authors/cameron-hunterton.html", "Authors", "Author"),
    ("authors/evelyn-nye.html", "Authors", "Author"),
    ("tools/stroop-test.html", "The Lab", "Interactive tool"),
    ("tools/reaction-time-test.html", "The Lab", "Interactive tool"),
    ("tools/find-your-blind-spot.html", "The Lab", "Interactive tool"),
]


def build_pages(root):
    records = []
    for rel, category, fmt in _PAGES:
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            continue
        doc = read(path)
        topic = title_of(doc) if category == "Topics" else ""
        author = ""
        if rel.startswith("authors/"):
            author = title_of(doc)
        records.append(make_record(
            url=rel,
            title=title_of(doc),
            category=category,
            excerpt=description_of(doc),
            body=page_main_text(doc),
            author=author,
            topic=topic,
            fmt=fmt,
        ))
    return records


def build_lab_demos(root):
    """Index existing demo anchors; the page opens their containing card on arrival."""
    doc = read(os.path.join(root, "lab.html")).split("</main>", 1)[0]
    starts = list(re.finditer(r'<(?:article|section|div)\b[^>]*(?:data-labdemo="[^"]+"|class="demo-card(?:\s[^"]*)?")[^>]*>', doc))
    records = []
    seen = set()
    for i, match in enumerate(starts):
        fragment = doc[match.start():starts[i+1].start() if i+1 < len(starts) else len(doc)]
        heading = re.search(r'<h[23]\b[^>]*>(.*?)</h[23]>', fragment, re.S)
        anchor = re.search(r'\bid="([^"]+)"', fragment)
        if not heading or not anchor:
            continue
        url = "lab.html#" + anchor.group(1)
        if url in seen:
            continue
        seen.add(url)
        title = strip_to_text(heading.group(1))
        prose = strip_to_text(fragment)
        records.append(make_record(url=url, title=title, category="The Lab",
            excerpt=truncate(prose, 240), body=prose, fmt="Interactive demo"))
    records.append(make_record(url="lab.html#lif-current", title="Drive a neuron to threshold",
        category="The Lab", excerpt="Explore injected current and firing rate in a leaky integrate-and-fire neuron.",
        body="LIF neuron membrane voltage threshold firing rate f-I curve injected current", fmt="Interactive demo"))
    return records


def build_index(root):
    records = []
    records += build_posts(root)
    records += build_pages(root)
    records += build_lab_demos(root)
    records += build_news(root)
    return records


def main(argv):
    root = _DEFAULT_ROOT
    check = False
    for arg in argv[1:]:
        if arg == "--check":
            check = True
        else:
            root = os.path.abspath(arg)

    records = build_index(root)
    out_path = os.path.join(root, "search-index.json")
    payload = json.dumps(records, ensure_ascii=False, separators=(",", ":"))

    if check:
        try:
            current = read(out_path)
        except OSError:
            current = ""
        if current.strip() == payload.strip():
            print("search-index.json is up to date (%d records)." % len(records))
            return 0
        print("DRIFT: search-index.json is stale; rerun without --check.")
        return 1

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(payload)
        f.write("\n")

    size = os.path.getsize(out_path)
    with_body = sum(1 for r in records if r.get("body"))
    print("Wrote %s" % out_path)
    print("  records: %d (%d carry body prose)" % (len(records), with_body))
    print("  size:    %d bytes (%.1f KB)" % (size, size / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
