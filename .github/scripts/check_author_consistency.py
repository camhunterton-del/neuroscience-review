#!/usr/bin/env python3
"""Author / byline metadata-consistency check for The Neuroscience Review.

Treats ``posts.html`` as the article index of record and verifies, across the
author archive pages and the article files, that:

  (A) every article's byline author resolves to an existing authors/<slug>.html
      (both the posts.html byline AND the article file's own byline link);
  (B) every article appears exactly once in its author's archive (none missing,
      none duplicated, and no archive entry mis-attributed to the wrong author);
  (C) every author archive is ordered newest-first.

Exits non-zero (FAIL) if any check fails. Stdlib only.

Run:  python3 -I .github/scripts/check_author_consistency.py
"""

import datetime
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
POSTS_INDEX = os.path.join(ROOT, "posts.html")
AUTHORS_DIR = os.path.join(ROOT, "authors")

CARD_RE = re.compile(r'<li class="post-card">(.*?)</li>', re.S)
HREF_RE = re.compile(r'<a href="(posts/[^"]+\.html)"')
TYPE_RE = re.compile(r'<span class="post-card__meta-type">(.*?)</span>', re.S)
BARE_SPAN_RE = re.compile(r'<span>(.*?)</span>', re.S)
TITLE_RE = re.compile(r'<h2 class="post-card__title">(.*?)</h2>', re.S)

ARCHIVE_LIST_RE = re.compile(
    r'<ol class="author-posts__list">(.*?)</ol>', re.S)
ARCHIVE_HREF_RE = re.compile(r'<li[^>]*>\s*<a href="\.\./(posts/[^"]+\.html)"')
BYLINE_RE = re.compile(r'<span class="byline">(.*?)</span>', re.S)
BYLINE_AUTHOR_HREF_RE = re.compile(r'href="\.\./authors/([^"]+\.html)"')


def slugify(name):
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def parse_posts_index(text):
    start = text.find("<!-- POSTS-LIST-START -->")
    end = text.find("<!-- POSTS-LIST-END -->")
    region = text[start:end] if (start != -1 and end != -1) else text
    records = []
    fails = []
    for card in CARD_RE.findall(region):
        href_m = HREF_RE.search(card)
        bare = BARE_SPAN_RE.findall(card)
        title_m = TITLE_RE.search(card)
        type_m = TYPE_RE.search(card)
        if not href_m:
            fails.append("posts.html: a post-card has no article link (cannot check)")
            continue
        url = href_m.group(1)
        if len(bare) < 3 or not bare[-1].strip():
            fails.append("%s: no parseable byline author in posts.html card" % url)
            continue
        try:
            date = datetime.datetime.strptime(bare[0].strip(), "%B %d, %Y").date()
        except ValueError:
            fails.append("%s: unparseable date %r in posts.html" % (url, bare[0].strip()))
            continue
        records.append({
            "url": url,
            "title": title_m.group(1).strip() if title_m else "",
            "format": type_m.group(1).strip() if type_m else "",
            "date": date,
            "author": bare[-1].strip(),
        })
    return records, fails


def parse_archive(path):
    """Return ordered list of article urls (posts/xxx.html) from an author archive."""
    text = read(path)
    m = ARCHIVE_LIST_RE.search(text)
    if not m:
        return None
    return ARCHIVE_HREF_RE.findall(m.group(1))


def check_file_byline(url):
    """Return (ok, detail) for the article file's own byline link resolution."""
    path = os.path.join(ROOT, url)
    if not os.path.isfile(path):
        return False, "article file missing: %s" % url
    text = read(path)
    m = BYLINE_RE.search(text)
    if not m:
        return False, "%s: no <span class=\"byline\"> found" % url
    href_m = BYLINE_AUTHOR_HREF_RE.search(m.group(1))
    if not href_m:
        return False, "%s: byline is not a link to an author page (plain byline)" % url
    target = href_m.group(1)  # e.g. "evelyn-nye.html"
    if not os.path.isfile(os.path.join(AUTHORS_DIR, target)):
        return False, "%s: byline links to missing author page authors/%s" % (url, target)
    return True, target


def main():
    posts_text = read(POSTS_INDEX)
    records, fails = parse_posts_index(posts_text)

    # Group by author in posts.html order.
    by_author = {}
    for r in records:
        by_author.setdefault(r["author"], []).append(r)

    url_date = {r["url"]: r["date"] for r in records}
    url_author = {r["url"]: r["author"] for r in records}

    n_authors = len(by_author)
    n_articles = len(records)

    # (A) every distinct byline author resolves to an existing author page.
    for name in sorted(by_author):
        slug = slugify(name)
        if not os.path.isfile(os.path.join(AUTHORS_DIR, slug + ".html")):
            fails.append("[A] byline author %r has no authors/%s.html" % (name, slug))

    # (A) every article file's own byline resolves to an existing author page,
    #     and points at the same author posts.html attributes it to.
    for r in records:
        ok, detail = check_file_byline(r["url"])
        if not ok:
            fails.append("[A] %s" % detail)
        else:
            expected = slugify(r["author"]) + ".html"
            if detail != expected:
                fails.append("[A] %s: byline links to authors/%s but posts.html "
                             "attributes it to %r (authors/%s)"
                             % (r["url"], detail, r["author"], expected))

    # (B) + (C) per-author archive membership, uniqueness, and ordering.
    for name in sorted(by_author):
        slug = slugify(name)
        apath = os.path.join(AUTHORS_DIR, slug + ".html")
        if not os.path.isfile(apath):
            continue  # already reported under (A)
        archive = parse_archive(apath)
        if archive is None:
            fails.append("[B] authors/%s.html: no author-posts list found" % slug)
            continue

        expected_urls = [r["url"] for r in by_author[name]]

        # Duplicates in the archive.
        seen = {}
        for u in archive:
            seen[u] = seen.get(u, 0) + 1
        for u, c in seen.items():
            if c > 1:
                fails.append("[B] authors/%s.html: %s listed %d times (duplicate)"
                             % (slug, u, c))

        archive_set = set(archive)
        # Missing: attributed to this author but absent from the archive.
        for u in expected_urls:
            if u not in archive_set:
                fails.append("[B] authors/%s.html: missing %s "
                             "(attributed to %s in posts.html)" % (slug, u, name))
        # Extra / mis-attributed: in the archive but not this author's in posts.html.
        for u in archive:
            if u not in set(expected_urls):
                owner = url_author.get(u)
                if owner is None:
                    fails.append("[B] authors/%s.html: lists %s, which is not in "
                                 "posts.html" % (slug, u))
                else:
                    fails.append("[B] authors/%s.html: lists %s, attributed to %r "
                                 "in posts.html" % (slug, u, owner))

        # (C) newest-first ordering (dates non-increasing); ties allowed.
        dates = [url_date[u] for u in archive if u in url_date]
        for i in range(len(dates) - 1):
            if dates[i] < dates[i + 1]:
                fails.append("[C] authors/%s.html: not newest-first at position %d "
                             "(%s before %s)" % (slug, i + 1, dates[i], dates[i + 1]))
                break

    # ---- Summary ----
    print("check_author_consistency.py")
    print("  articles in posts.html: %d" % n_articles)
    print("  distinct byline authors: %d (%s)"
          % (n_authors, ", ".join(sorted(by_author))))
    print("  author archive pages checked: %d"
          % sum(1 for name in by_author
                if os.path.isfile(os.path.join(AUTHORS_DIR, slugify(name) + ".html"))))
    print("  article-file bylines checked: %d" % n_articles)

    if fails:
        print("  RESULT: FAIL (%d issue%s)" % (len(fails), "" if len(fails) == 1 else "s"))
        for f in fails:
            print("    - %s" % f)
        return 1

    print("  checks: author-page existence, article byline resolution, "
          "archive membership (once, no dupes, no mis-attribution), newest-first order")
    print("  RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
