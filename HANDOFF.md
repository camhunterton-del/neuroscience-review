# Project Handoff — Neuroscience Blog

This file exists so any new Claude (or human collaborator) can pick this project up cold. Read it first.

## What this is

A static neuroscience blog. Name: **The Neuroscience Review** (finalized 2026-06-01, replacing the earlier working name "Neuroscience Made Easy"). The brand string lives in:

- `index.html` (logo, title tag, footer)
- `about.html` (logo, title, meta, body copy)
- Both files in `posts/` (logo, title tag, footer)
- `README.md`
- `POSITIONING.md`

If the name ever changes again, a one-shot find-and-replace across the folder handles it.

## Who it's for

Two readers, simultaneously:

1. **The curious generalist** — smart adult, NYT science-section reader, no formal bio background.
2. **The science-literate reader** — premed, neuro undergrad, or scientist, who'd notice if anything is hand-waved.

Every post should be readable for #1 *and* verifiable for #2. Losing either is failing.

## Voice

Clean and journalistic — Quanta Magazine vibes. Technically sound, never lax. Confident, not condescending. Sparing with metaphor. First person used only when it adds something.

**Avoid:** "fascinating," "amazing," "groundbreaking," "mind-blowing."

## Format

Two post types:

- **Paper breakdowns** (~60% of posts, 1,500–2,500 words): unpack one recent paper. Structure: hook → why it matters → what they did → what they found → what it doesn't mean → why you should care.
- **First-principles deep dives** (~40%, 2,000–3,500 words): build a concept from scratch. Evergreen, SEO-friendly.

## Editorial standards (non-negotiable)

1. Every factual claim sourced or sourceable.
2. No hedging without explaining — "studies suggest" must be replaced with specifics.
3. Don't conflate animal models with humans.
4. Distinguish correlation from causation, every time.
5. Present both sides on contested topics.
6. Acknowledge what's unknown.

## What's built

```
neuroscience-made-easy/
├── index.html               Homepage with post list
├── about.html               About page
├── HANDOFF.md               This file
├── README.md                Deploy + add-post instructions
├── POSITIONING.md           Full positioning/voice doc (longer version)
├── css/
│   └── styles.css           Single shared stylesheet (CSS vars at top)
└── posts/
    ├── what-is-a-neuron.html
    └── dopamine-doesnt-do-what-you-think.html
```

Tech: pure static HTML + CSS. No build step. No dependencies beyond Google Fonts (Newsreader + Inter, loaded from CDN). Opens by double-clicking `index.html`.

## What's published

**Post 1 — "What is a neuron, really?"** (First principles, ~1700 words)
The foundational post — every future post can link back to it. Covers: cell biology of a neuron, dendrite/soma/axon shape, action potentials, chemical synapses, scale (86 billion neurons), honest caveats (glia, neuron-type diversity, the consciousness gap).

**Post 2 — "Dopamine doesn't do what you think it does."** (Myth-busting, ~1500 words)
Establishes the blog's point of view. Covers: dopamine's actual role, Schultz reward-prediction-error work, Berridge wanting-vs-liking distinction, why "dopamine detox" is mostly nonsense, what's still unknown.

Both link the original positioning, and the dopamine post links back to the neuron post for cross-referencing.

## What's NOT done yet

1. **Subscribe form is a stub** — pops an alert. Needs to be wired to Buttondown / ConvertKit / Mailchimp. The form is identical in 4 files; do find-and-replace.
2. **No domain.** Buy `neurosciencemadeeasy.com` (or the new name's domain) at Namecheap / Porkbun / Cloudflare. Point at the host.
3. **Not deployed.** Drag the folder onto https://app.netlify.com/drop for an instant free URL.
4. **About-page bio is generic.** Cameron should rewrite the "About the author" paragraph in his own voice.
5. **Both posts are AI-drafted in Cameron's intended voice.** Factually sound to my knowledge, but Cameron should read carefully and adjust before publishing under his name.

## First-10-posts seed list (from positioning doc — order is flexible)

1. ✅ What is a neuron, really? *(first principles — done)*
2. How does memory actually work? (first principles)
3. Latest psychedelics-and-depression trial — pick a 2025–26 paper and unpack (paper breakdown)
4. The blood-brain barrier (first principles)
5. A recent Alzheimer's paper (paper breakdown)
6. Why sleep matters for the brain (first principles)
7. Something from the Columbia Mass Murder Database / Girgis lab — Cameron has insider context (paper breakdown)
8. ✅ Dopamine doesn't do what you think it does *(myth-busting / first principles — done)*
9. A recent neuroplasticity paper (paper breakdown)
10. What an fMRI actually measures (first principles)

## How to add a new post

1. Copy an existing post HTML as a template.
2. Update title, subtitle, eyebrow type (First principles / Myth-busting / Paper breakdown / etc.), date, read time.
3. Replace body.
4. Add a new `<li class="post-card">` block at the top of the post list in `index.html`.

## Suggested opening prompt for Claude Code

When opening a fresh Claude Code session in this folder:

> Read HANDOFF.md and POSITIONING.md. Then help me with [whatever — adding a post, renaming the brand, hooking up subscribe, etc.]. Match the existing voice, structure, and editorial standards.
