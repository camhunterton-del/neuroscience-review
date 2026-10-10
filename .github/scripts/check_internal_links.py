#!/usr/bin/env python3
"""Verify every relative href/src in the site's MAINTAINED HTML points to a real file.

"Maintained" = pages that actually ship: git-tracked HTML, plus a small allowlist
of new-but-real pages not yet committed. Untracked local drafts (design
experiments and work-in-progress pages that carry placeholder links) are reported
separately and never fail the run, so a draft's broken link cannot mask or block a
real production regression. On CI only committed files exist, so this checks
exactly the maintained site; the separation only matters for local runs.

Skips external URLs, mailto, anchors, root-absolute paths, data URIs, and
JS-built dynamic links. Exits non-zero only if a MAINTAINED page has a broken
internal link or asset.
"""
import re
import glob
import os
import subprocess
import sys

# New-but-real pages that may not be git-tracked yet. Treated as maintained so
# their links are still checked before they are committed.
MAINTAINED_ALLOWLIST = {"authors/evelyn-nye.html"}


def tracked_html():
    """The set of git-tracked HTML paths, or None if git is unavailable."""
    try:
        out = subprocess.run(
            ["git", "ls-files", "*.html"],
            capture_output=True, text=True, check=True,
        ).stdout.split()
        return {os.path.normpath(p) for p in out}
    except Exception:
        return None  # git not available: fall back to treating everything as maintained


TRACKED = tracked_html()


def is_maintained(path):
    if TRACKED is None:
        return True
    rel = os.path.normpath(path)
    return rel in TRACKED or rel in MAINTAINED_ALLOWLIST


bad = []        # broken links on maintained/production pages (fatal)
draft_bad = []  # broken links on untracked local drafts (non-fatal)

for f in glob.glob("**/*.html", recursive=True):
    # Skip underscore-prefixed template files (never published; they carry
    # intentional placeholder links like ../authors/<slug>.html).
    if os.path.basename(f).startswith("_"):
        continue
    d = os.path.dirname(f)
    with open(f, encoding="utf-8") as fh:
        html = fh.read()
    for ref in re.findall(r'(?:href|src)="([^"]+)"', html):
        ref = ref.strip()
        if not ref or ref.startswith(
            ("http://", "https://", "mailto:", "tel:", "//", "#", "/", "data:")
        ):
            continue
        # Skip URLs built dynamically in JS (e.g. href="'+region.link+'" inside a
        # Three.js template string) — they're not static links to a repo file.
        if any(tok in ref for tok in ("'", "`", "${", "{{", "<%")):
            continue
        target = ref.split("#")[0].split("?")[0]
        if not target:
            continue
        resolved = os.path.normpath(os.path.join(d, target))
        if not os.path.exists(resolved):
            (bad if is_maintained(f) else draft_bad).append(f"{f} -> {ref}")

bad = sorted(set(bad))
draft_bad = sorted(set(draft_bad))

if draft_bad:
    print("Broken links in untracked local drafts (NOT part of the maintained site, not failing):")
    for b in draft_bad:
        print("  (draft) " + b)
    print()

if bad:
    print("Broken internal links or assets on maintained pages:")
    for b in bad:
        print("  " + b)
    sys.exit(1)

print(
    "Internal links and assets all resolve on maintained pages"
    + (f" ({len(draft_bad)} draft-only issue(s) ignored)." if draft_bad else ".")
)
