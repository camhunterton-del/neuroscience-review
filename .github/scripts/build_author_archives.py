#!/usr/bin/env python3
"""Regenerate per-author archive pages for The Neuroscience Review.

Source of record: ``posts.html`` (the article index). Each ``<li class="post-card">``
block is parsed into a record, records are grouped by author, and each author's
archive page is regenerated with that author's articles listed newest-first.

The page SHELL (head, utility bar, masthead, nav, footer, theme JS, CSS) is cloned
verbatim from the existing ``authors/cameron-hunterton.html``. Only two regions are
regenerated: the post-list region, and the per-author identity (name / bio / schema
and the matching head metadata).

Cameron's identity (bio, role, schema, head meta) is extracted from the existing
page and re-inserted unchanged, so it stays verbatim. Other authors supply their
identity from the AUTHORS registry below, which must contain only approved facts.

Run:  python3 -I .github/scripts/build_author_archives.py

Stdlib only.
"""

import datetime
import html
import json
import os
import re
import sys

# ---------------------------------------------------------------------------
# Paths (resolved from this file, so the script works from any CWD).
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
POSTS_INDEX = os.path.join(ROOT, "posts.html")
AUTHORS_DIR = os.path.join(ROOT, "authors")
TEMPLATE_PAGE = os.path.join(AUTHORS_DIR, "cameron-hunterton.html")

SITE = "https://theneuroreview.com"


def slugify(name):
    """Author display name -> author-page slug (matches existing file names)."""
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


# ---------------------------------------------------------------------------
# Approved per-author identity. Only authors listed here get a generated page;
# an author found in posts.html but absent here is reported, never invented.
#
# "cameron-hunterton" is the template author: its identity is pulled from the
# existing page at runtime (see below) so it stays byte-for-byte verbatim, so it
# carries no explicit identity here.
# ---------------------------------------------------------------------------
TEMPLATE_AUTHOR_SLUG = "cameron-hunterton"

AUTHORS = {
    "evelyn-nye": {
        "name": "Evelyn Nye",
        "initials": "EN",
        "eyebrow": "Author",
        "role": "The Commons contributor",
        # One-line factual descriptor built only from approved facts.
        "descriptor": ("Evelyn Nye is a contributor to The Commons at "
                       "The Neuroscience Review, at SUNY Geneseo."),
        # Author schema: name + affiliation (SUNY Geneseo) only.
        "schema": {
            "@context": "https://schema.org",
            "@type": "Person",
            "name": "Evelyn Nye",
            "affiliation": {"@type": "CollegeOrUniversity", "name": "SUNY Geneseo"},
        },
    },
}


# ---------------------------------------------------------------------------
# Parse posts.html into records.
# ---------------------------------------------------------------------------
CARD_RE = re.compile(r'<li class="post-card">(.*?)</li>', re.S)
HREF_RE = re.compile(r'<a href="(posts/[^"]+\.html)"')
TYPE_RE = re.compile(r'<span class="post-card__meta-type">(.*?)</span>', re.S)
BARE_SPAN_RE = re.compile(r'<span>(.*?)</span>', re.S)
TITLE_RE = re.compile(r'<h2 class="post-card__title">(.*?)</h2>', re.S)
LEDE_RE = re.compile(r'<p class="post-card__lede">(.*?)</p>', re.S)


def parse_posts_index(text):
    """Return (records, warnings). Each record is a dict; warnings flag ambiguity."""
    start = text.find("<!-- POSTS-LIST-START -->")
    end = text.find("<!-- POSTS-LIST-END -->")
    region = text[start:end] if (start != -1 and end != -1) else text

    records = []
    warnings = []
    for card in CARD_RE.findall(region):
        href_m = HREF_RE.search(card)
        type_m = TYPE_RE.search(card)
        title_m = TITLE_RE.search(card)
        lede_m = LEDE_RE.search(card)
        bare = BARE_SPAN_RE.findall(card)

        if not href_m:
            warnings.append("post-card with no article href; skipped")
            continue
        url = href_m.group(1)

        # Bare (class-less) spans in meta are, in order: date, read-time, author.
        if len(bare) < 3:
            warnings.append("%s: could not find date/read/author spans; skipped" % url)
            continue
        date_str = bare[0].strip()
        author = bare[-1].strip()
        if not author:
            warnings.append("%s: empty author byline; skipped" % url)
            continue
        try:
            date = datetime.datetime.strptime(date_str, "%B %d, %Y").date()
        except ValueError:
            warnings.append("%s: unparseable date %r; skipped" % (url, date_str))
            continue

        records.append({
            "url": url,
            "title": (title_m.group(1).strip() if title_m else ""),
            "date": date,
            "date_str": date_str,
            "author": author,
            "format": (type_m.group(1).strip() if type_m else ""),
            "lede": (lede_m.group(1).strip() if lede_m else ""),
        })
    return records, warnings


# ---------------------------------------------------------------------------
# Template handling.
# ---------------------------------------------------------------------------
def split_template(template):
    """Return (head, main_inner, tail) by splitting the shell around <main>."""
    head, rest = template.split('<main id="main">', 1)
    main_inner, tail = rest.split('</main>', 1)
    return head, main_inner, tail


def split_main_regions(main_inner):
    """Split the <main> inner HTML into (profile_seg, bio_seg) before the posts list.

    profile_seg runs from the start of <main> content up to the author-bio block.
    bio_seg runs from the author-bio block up to the author-posts section.
    """
    bio_start = main_inner.index('<div class="author-bio">')
    posts_start = main_inner.index('<section class="author-posts">')
    return main_inner[:bio_start], main_inner[bio_start:posts_start]


def render_posts_section(name, records):
    """Build the author-posts <section> (ends with the indent before </main>)."""
    lines = [
        '<section class="author-posts">\n',
        '      <h2>Posts by %s</h2>\n' % name,
        '      <ol class="author-posts__list">\n',
    ]
    if records:
        for r in records:
            lines.append(
                '        <li><a href="../%s">'
                '<span class="author-posts__type">%s</span> %s</a></li>\n'
                % (r["url"], r["format"], r["title"])
            )
    else:
        lines.append('        <li class="author-posts__empty">No articles yet.</li>\n')
    lines.append('      </ol>\n')
    lines.append('    </section>\n')
    lines.append('  ')
    return "".join(lines)


def build_profile_seg(initials, eyebrow, name, role):
    return (
        '\n    <section class="author-profile">\n'
        '      <div class="author-avatar author-avatar--lg" aria-hidden="true">%s</div>\n'
        '      <div>\n'
        '        <div class="author-profile__eyebrow">%s</div>\n'
        '        <h1 class="author-profile__name">%s</h1>\n'
        '        <p class="author-profile__role">%s</p>\n'
        '      </div>\n'
        '    </section>\n\n    '
        % (initials, eyebrow, name, role)
    )


def build_bio_seg(descriptor):
    return (
        '<div class="author-bio">\n'
        '      <p>%s</p>\n'
        '      <div class="author-links">\n'
        '        <a href="../commons.html">The Commons</a>\n'
        '        <a href="../about.html">About the Review</a>\n'
        '      </div>\n'
        '    </div>\n\n    '
        % descriptor
    )


def apply_head_identity(head, slug, name, descriptor, schema):
    """Swap the per-author head metadata into the cloned head for a non-template author."""
    canonical = "%s/authors/%s.html" % (SITE, slug)
    title = "%s — The Neuroscience Review" % name
    desc_attr = html.escape(descriptor, quote=True)
    schema_json = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))

    subs = [
        (r'<title>.*?</title>', '<title>%s</title>' % title),
        (r'<meta name="description" content="[^"]*">',
         '<meta name="description" content="%s">' % desc_attr),
        (r'<link rel="canonical" href="[^"]*">',
         '<link rel="canonical" href="%s">' % canonical),
        (r'<meta property="og:title" content="[^"]*">',
         '<meta property="og:title" content="%s">' % title),
        (r'<meta property="og:description" content="[^"]*">',
         '<meta property="og:description" content="%s">' % desc_attr),
        (r'<meta property="og:url" content="[^"]*">',
         '<meta property="og:url" content="%s">' % canonical),
        (r'<meta name="twitter:title" content="[^"]*">',
         '<meta name="twitter:title" content="%s">' % title),
        (r'<meta name="twitter:description" content="[^"]*">',
         '<meta name="twitter:description" content="%s">' % desc_attr),
        (r'<script type="application/ld\+json">\s*\{.*?\}\s*</script>',
         '<script type="application/ld+json">\n  %s\n  </script>' % schema_json),
    ]
    for pattern, replacement in subs:
        new_head, n = re.subn(pattern, lambda m, r=replacement: r, head,
                              count=1, flags=re.S)
        if n != 1:
            raise RuntimeError("head substitution matched %d times for %r" % (n, pattern))
        head = new_head
    return head


def build_page(head, main_inner, tail, profile_seg, bio_seg, name, records):
    new_main = profile_seg + bio_seg + render_posts_section(name, records)
    return head + '<main id="main">' + new_main + '</main>' + tail


def main():
    with open(POSTS_INDEX, encoding="utf-8") as f:
        posts_text = f.read()
    with open(TEMPLATE_PAGE, encoding="utf-8") as f:
        template = f.read()

    records, warnings = parse_posts_index(posts_text)

    # Group by author, preserving posts.html order (already newest-first).
    by_author = {}
    for r in records:
        by_author.setdefault(r["author"], []).append(r)

    # Newest-first; stable, so equal dates keep posts.html order.
    for name in by_author:
        by_author[name] = sorted(by_author[name], key=lambda r: r["date"], reverse=True)

    head, main_inner, tail = split_template(template)
    tpl_profile, tpl_bio = split_main_regions(main_inner)

    written = []
    skipped = []
    for name in sorted(by_author):
        slug = slugify(name)
        recs = by_author[name]
        out_path = os.path.join(AUTHORS_DIR, slug + ".html")

        if slug == TEMPLATE_AUTHOR_SLUG:
            # Template author: clone head + verbatim profile/bio, regenerate list only.
            page = build_page(head, main_inner, tail, tpl_profile, tpl_bio, name, recs)
        elif slug in AUTHORS:
            a = AUTHORS[slug]
            new_head = apply_head_identity(head, slug, a["name"], a["descriptor"], a["schema"])
            profile_seg = build_profile_seg(a["initials"], a["eyebrow"], a["name"], a["role"])
            bio_seg = build_bio_seg(a["descriptor"])
            page = build_page(new_head, main_inner, tail, profile_seg, bio_seg, a["name"], recs)
        else:
            skipped.append((name, slug, len(recs)))
            continue

        with open(out_path, "w", encoding="utf-8") as f:
            f.write(page)
        written.append((name, slug, len(recs)))

    # Report.
    print("build_author_archives.py")
    print("  posts parsed: %d (from posts.html)" % len(records))
    print("  authors found: %d" % len(by_author))
    for name, slug, n in written:
        print("  WROTE  authors/%s.html  (%s, %d article%s)"
              % (slug, name, n, "" if n == 1 else "s"))
    for name, slug, n in skipped:
        print("  SKIP   %s (%d article%s): no approved identity in registry; "
              "page NOT generated" % (name, n, "" if n == 1 else "s"))
    for w in warnings:
        print("  WARN   %s" % w)

    if skipped:
        print("  NOTE: %d author(s) had no registry entry; add approved facts to "
              "AUTHORS before their page can be built." % len(skipped))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
