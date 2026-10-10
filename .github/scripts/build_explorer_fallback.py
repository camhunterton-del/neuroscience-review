#!/usr/bin/env python3
"""Build the module-independent text fallback for the 3D explorer pages.

The three explorer pages (``brain.html``, ``neuron.html``, ``synapse.html``) draw
their region/part CONTROLS and descriptions from inside an ES module that imports
three.js from a CDN. If the module itself fails to load (blocked or unreachable
CDN), none of that text ever reaches the page, so the ``#brain-fallback`` preview
has no region text to show. This script lifts the region/part data OUT of each
module and writes a static, semantic reference list inside ``#brain-fallback`` so
the text route works with zero JavaScript.

How the data is read (no regex guessing of field values): the data array literal
is isolated from the page with a string/comment-aware bracket scanner, handed to
**Node** as ``const DATA=<literal>; console.log(JSON.stringify(...))``, and the
REAL evaluated objects come back as JSON. Field names are adapted per page.

The reference is injected between the idempotent markers
``<!-- FALLBACK-REF-START -->`` / ``<!-- FALLBACK-REF-END -->`` (created inside
``#brain-fallback`` on first run). Re-running produces byte-identical output.

Run:  python3 -I .github/scripts/build_explorer_fallback.py

Stdlib only. Requires ``node`` on PATH.
"""

import html
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Per-page configuration. ``var`` is the module-level array literal to lift.
# ``grouped`` toggles section headings keyed off each record's ``group`` field.
PAGES = [
    {
        "file": "brain.html",
        "var": "REGIONS",
        "noun": "region",
        "grouped": True,
        "group_order": ["cortex", "deep"],
        "group_labels": {
            "cortex": "Cerebral cortex (outer surface)",
            "deep": "Deep structures",
        },
    },
    {
        "file": "neuron.html",
        "var": "PARTS",
        "noun": "part",
        "grouped": False,
    },
    {
        "file": "synapse.html",
        "var": "PARTS",
        "noun": "part",
        "grouped": False,
    },
]

START = "<!-- FALLBACK-REF-START -->"
END = "<!-- FALLBACK-REF-END -->"
INDENT = "          "  # 10 spaces, matching the content inside #brain-fallback


def isolate_array_literal(src, var):
    """Return the ``[...]`` literal assigned to ``const <var>`` in ``src``.

    Uses a scanner that tracks JS string literals ('...', "...", `...`) and
    line/block comments so brackets inside strings or comments never fool the
    depth count.
    """
    m = re.search(r"const\s+" + re.escape(var) + r"\s*=\s*\[", src)
    if not m:
        raise ValueError("could not find `const %s = [` in the page" % var)
    start = m.end() - 1  # index of the opening '['
    i = start
    n = len(src)
    depth = 0
    in_str = None
    escaped = False
    line_comment = False
    block_comment = False
    while i < n:
        c = src[i]
        if line_comment:
            if c == "\n":
                line_comment = False
            i += 1
            continue
        if block_comment:
            if c == "*" and i + 1 < n and src[i + 1] == "/":
                block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_str is not None:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == in_str:
                in_str = None
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            line_comment = True
            i += 2
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            block_comment = True
            i += 2
            continue
        if c in ("'", '"', "`"):
            in_str = c
            i += 1
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
        i += 1
    raise ValueError("unbalanced brackets while isolating `%s`" % var)


def eval_with_node(literal):
    """Evaluate the array literal with Node and return the list of records."""
    script = (
        "const DATA=" + literal + ";\n"
        "console.log(JSON.stringify(DATA.map(r=>({"
        "label:r.label||r.name,"
        "text:r.text||r.desc||'',"
        "group:r.group||''"
        "}))));\n"
    )
    fd, path = tempfile.mkstemp(suffix=".js", prefix="explorer_fallback_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(script)
        out = subprocess.run(
            ["node", path],
            check=True,
            capture_output=True,
            text=True,
        )
    finally:
        os.unlink(path)
    return json.loads(out.stdout)


def short_desc(text):
    """First sentence of ``text`` (or ~160 chars, whichever is shorter)."""
    text = " ".join((text or "").split())
    if not text:
        return ""
    m = re.match(r"^(.*?[.!?])(?:\s|$)", text)
    sentence = m.group(1).strip() if m else text
    if len(sentence) > 200:
        sentence = textwrap.shorten(sentence, width=160, placeholder="…")
    return sentence


def esc(s):
    return html.escape(s or "", quote=False)


def render_entries(records):
    lines = ["<dl>"]
    for r in records:
        lines.append("  <dt>%s</dt>" % esc(r["label"]))
        lines.append("  <dd>%s</dd>" % esc(short_desc(r["text"])))
    lines.append("</dl>")
    return lines


def build_block(cfg, records):
    """Return the full marker-to-marker block, indented, no trailing newline."""
    inner = ['<div class="brain-fallback-ref">']
    if cfg["grouped"]:
        seen = [g for g in cfg["group_order"] if any(r["group"] == g for r in records)]
        # any groups not in the declared order get appended, so nothing is dropped
        for r in records:
            if r["group"] and r["group"] not in seen:
                seen.append(r["group"])
        for g in seen:
            group_records = [r for r in records if r["group"] == g]
            if not group_records:
                continue
            label = cfg.get("group_labels", {}).get(g, g.title())
            inner.append('  <section class="brain-fallback-group">')
            inner.append("    <h3>%s</h3>" % esc(label))
            for ln in render_entries(group_records):
                inner.append("    " + ln)
            inner.append("  </section>")
    else:
        for ln in render_entries(records):
            inner.append("  " + ln)
    inner.append("</div>")

    body = [START] + inner + [END]
    return "\n".join(INDENT + ln for ln in body)


def inject(src, block):
    """Insert or replace the marker block inside #brain-fallback. Idempotent."""
    if START in src and END in src:
        pattern = re.compile(
            r"[ \t]*" + re.escape(START) + r".*?" + re.escape(END),
            re.DOTALL,
        )
        return pattern.sub(lambda _m: block, src, count=1)
    # First run: insert right after the fallback message paragraph.
    anchor = re.compile(r'<p id="brain-fallback-msg">.*?</p>', re.DOTALL)
    m = anchor.search(src)
    if not m:
        raise ValueError("could not find the #brain-fallback-msg paragraph")
    insert_at = m.end()
    return src[:insert_at] + "\n" + block + src[insert_at:]


def main():
    for cfg in PAGES:
        path = ROOT / cfg["file"]
        src = path.read_text(encoding="utf-8")
        literal = isolate_array_literal(src, cfg["var"])
        records = eval_with_node(literal)
        block = build_block(cfg, records)
        had_markers = START in src and END in src
        new_src = inject(src, block)
        changed = new_src != src
        if changed:
            path.write_text(new_src, encoding="utf-8")

        # Summary for verification.
        total = len(records)
        action = "replaced" if had_markers else ("inserted" if changed else "unchanged")
        detail = ""
        if cfg["grouped"]:
            counts = {}
            for r in records:
                counts[r["group"] or "(none)"] = counts.get(r["group"] or "(none)", 0) + 1
            detail = " (" + ", ".join("%s=%d" % (k, v) for k, v in counts.items()) + ")"
        status = "CHANGED" if changed else "no change"
        print(
            "%-12s %-8s %2d %-6s %-9s %s%s"
            % (cfg["file"], cfg["var"], total, cfg["noun"] + "s", action, status, detail)
        )


if __name__ == "__main__":
    main()
