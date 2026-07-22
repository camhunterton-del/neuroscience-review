#!/usr/bin/env python3
"""Content-logic watchdog: the News feed must read newest-first.

The link/HTTP checks can't see this — a page can load fine, every link can
work, and the items can still be in the wrong order. This asserts the visible
dates on the live News page are non-increasing (most recent at the top), which
is exactly the class of bug that slipped past the availability checks once.

It also sanity-checks that the homepage "Latest news" rail leads with the same
headline the News feed leads with, so the two never drift apart again.

Exits non-zero (failing the watchdog, which opens an alert issue) if either
invariant is broken. Best-effort on network/parse hiccups: if it genuinely
can't read the pages it says so and exits 0 rather than crying wolf.
"""
import re
import sys
import urllib.request
from datetime import datetime

BASE = "https://theneuroreview.com"
UA = {"User-Agent": "Mozilla/5.0 (compatible; TheNeuroReview-watchdog/1.0)"}

META_DATE = re.compile(r'news-item__meta[^>]*>\s*([A-Za-z]+ \d{1,2}, \d{4})')
NEWS_HEADLINE = re.compile(r'<h[23]><a [^>]*>([\s\S]*?)</a></h[23]>')
RAIL_HEADLINE = re.compile(r'home-news__headline"[^>]*>([\s\S]*?)</a>')


def fetch(path):
    req = urllib.request.Request(BASE + path, headers=UA)
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode("utf-8", "replace")


def first(pattern, html):
    m = pattern.search(html)
    return m.group(1).strip() if m else None


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def main():
    try:
        news = fetch("/news.html")
    except Exception as e:
        print(f"Could not fetch news.html ({e}); skipping order check.")
        return 0

    dates = []
    for d in META_DATE.findall(news):
        for fmt in ("%B %d, %Y", "%b %d, %Y"):
            try:
                dates.append(datetime.strptime(d, fmt))
                break
            except ValueError:
                continue
    if not dates:
        print("No dated news items found; skipping order check.")
        return 0

    fail = 0
    for i in range(1, len(dates)):
        if dates[i] > dates[i - 1]:
            print(
                f"OUT OF ORDER: item {i + 1} ({dates[i]:%b %d, %Y}) is newer than "
                f"item {i} ({dates[i - 1]:%b %d, %Y}) above it. News must be newest-first."
            )
            fail = 1
    if not fail:
        print(f"News order ok: {len(dates)} items, newest-first.")

    # The homepage rail should lead with the same story the feed leads with.
    try:
        home = fetch("/")
        news_top = norm(first(NEWS_HEADLINE, news))
        rail_top = norm(first(RAIL_HEADLINE, home))
        if news_top and rail_top and news_top != rail_top:
            print(
                "RAIL DRIFT: homepage leads with "
                f"{rail_top!r} but the News feed leads with {news_top!r}."
            )
            fail = 1
        elif news_top and rail_top:
            print("Homepage rail leads with the newest News item (ok).")
    except Exception as e:
        print(f"Could not cross-check homepage rail ({e}); skipping that part.")

    return fail


if __name__ == "__main__":
    sys.exit(main())
