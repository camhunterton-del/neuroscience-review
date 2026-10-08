#!/usr/bin/env python3
"""Content-logic watchdog: the News feed must read newest-first.

The link/HTTP checks can't see this — a page can load fine, every link can
work, and the items can still be in the wrong order. This asserts the visible
dates on the live News page are non-increasing (most recent at the top), which
is exactly the class of bug that slipped past the availability checks once.

It also sanity-checks that the homepage "Research briefs" rail leads with the
same brief the News feed leads with (matched by permalink slug), so the two
never drift apart again.

FAILS CLOSED. Exits non-zero (failing the watchdog, which opens an alert issue)
if it can't read the pages after retries, if no dated items parse (the markup
likely changed), if a lead headline is missing on either page, or if either
ordering invariant is broken. Network-availability failures are labeled
distinctly from content failures so the alert says which kind it is. Exit codes:
0 = ok, 1 = content problem, 2 = network problem after retries.
"""
import re
import sys
import time
import urllib.request
from datetime import datetime

BASE = "https://theneuroreview.com"
UA = {"User-Agent": "Mozilla/5.0 (compatible; TheNeuroReview-watchdog/1.0)"}

META_DATE = re.compile(r'news-item__meta[^>]*>\s*([A-Za-z]+ \d{1,2}, \d{4})')
NEWS_HEADLINE = re.compile(r'<h[23]><a [^>]*>([\s\S]*?)</a></h[23]>')
# Each news card now carries a stable permalink id (id="n-SLUG") and the homepage
# rail links to that same permalink (news.html#n-SLUG). The lead cross-check
# compares the two by SLUG, which is encoding-independent -- the rail title writes
# apostrophes as &rsquo; where the news h2 uses a straight ' -- instead of trying
# to match display text. RAIL_TITLE is kept only for a human-readable message.
NEWS_TOP_ID = re.compile(r'<article class="news-item"[^>]*\bid="(n-[a-z0-9-]+)"')
RAIL_ITEM = re.compile(r'class="latest-item"[^>]*href="news\.html#(n-[a-z0-9-]+)"')
RAIL_TITLE = re.compile(r'latest-item__title"[^>]*>([\s\S]*?)</span>')


def fetch(path, attempts=3):
    """Fetch with retries. Raises the last error only after all attempts fail,
    so a transient DNS/TLS/network blip doesn't get mistaken for a real fault."""
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(BASE + path, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - retry any transport error
            last = e
            if i < attempts - 1:
                time.sleep(3 * (i + 1))
    raise last


def first(pattern, html):
    m = pattern.search(html)
    return m.group(1).strip() if m else None


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def main():
    # Fetch the News page. A network failure after retries FAILS the check
    # rather than skipping it, so a block/outage can't quietly hide a bug.
    try:
        news = fetch("/news.html")
    except Exception as e:  # noqa: BLE001
        print(f"NETWORK FAIL: could not fetch news.html after retries ({e}).")
        return 2

    # Parse the visible dates. No dated items = the markup changed or the feed
    # is empty, which is itself a failure (the regex used to fail open here).
    dates = []
    for d in META_DATE.findall(news):
        for fmt in ("%B %d, %Y", "%b %d, %Y"):
            try:
                dates.append(datetime.strptime(d, fmt))
                break
            except ValueError:
                continue
    if not dates:
        print("CONTENT FAIL: no dated news items parsed on news.html "
              "(markup changed or the feed is empty).")
        return 1

    fail = 0
    for i in range(1, len(dates)):
        if dates[i] > dates[i - 1]:
            print(
                f"CONTENT FAIL, OUT OF ORDER: item {i + 1} ({dates[i]:%b %d, %Y}) is "
                f"newer than item {i} ({dates[i - 1]:%b %d, %Y}) above it. "
                "News must be newest-first."
            )
            fail = 1
    if not fail:
        print(f"News order ok: {len(dates)} items, newest-first.")

    # The News feed must expose a lead card with its permalink id for the rail
    # cross-check. A missing id means the card markup changed (fail closed).
    news_top_id = first(NEWS_TOP_ID, news)
    news_top = norm(first(NEWS_HEADLINE, news))
    if not news_top_id or not news_top:
        print("CONTENT FAIL: could not find the lead news card (permalink id + headline) "
              "on news.html (markup changed).")
        return 1

    # The homepage rail should lead with that same brief. A homepage network
    # failure after retries also FAILS closed.
    try:
        home = fetch("/")
    except Exception as e:  # noqa: BLE001
        print(f"NETWORK FAIL: could not fetch the homepage after retries ({e}).")
        return 2

    rail_top_id = first(RAIL_ITEM, home)
    rail_top = norm(first(RAIL_TITLE, home))
    if not rail_top_id:
        print("CONTENT FAIL: could not find a brief link in the homepage research-briefs rail "
              "(markup changed).")
        return 1
    # Compare by slug: the rail title and the news headline encode apostrophes
    # differently, so comparing display text would false-alarm.
    if news_top_id != rail_top_id:
        print(
            "CONTENT FAIL, RAIL DRIFT: homepage leads with "
            f"{rail_top or rail_top_id!r} (#{rail_top_id}) but the News feed leads with "
            f"{news_top!r} (#{news_top_id})."
        )
        fail = 1
    else:
        print("Homepage rail leads with the newest News item (ok).")

    return fail


if __name__ == "__main__":
    sys.exit(main())
