#!/usr/bin/env python3
"""Verify every relative href/src in the site's HTML points to a real file.

Skips external URLs, mailto, anchors, and root-absolute paths (those resolve on
the live server, not in the repo tree). Exits non-zero if any internal link or
asset is broken, so the watchdog fails loudly.
"""
import re
import glob
import os
import sys

bad = []
for f in glob.glob("**/*.html", recursive=True):
    # Skip underscore-prefixed template files (Jekyll never publishes them,
    # and they carry intentional placeholder links like ../authors/<slug>.html).
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
        target = ref.split("#")[0].split("?")[0]
        if not target:
            continue
        resolved = os.path.normpath(os.path.join(d, target))
        if not os.path.exists(resolved):
            bad.append(f"{f} -> {ref}")

bad = sorted(set(bad))
if bad:
    print("Broken internal links or assets:")
    for b in bad:
        print("  " + b)
    sys.exit(1)
print("Internal links and assets all resolve.")
