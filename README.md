# The Neuroscience Review

A clean, static website for a neuroscience blog. No build step, no dependencies — just open `index.html` to view, or drag the folder onto a static host to deploy.

## What's in here

```
neuroscience-made-easy/
├── index.html               Homepage with post list
├── about.html               About page
├── css/
│   └── styles.css           Shared stylesheet (uses Google Fonts CDN)
├── posts/
│   ├── what-is-a-neuron.html
│   └── dopamine-doesnt-do-what-you-think.html
└── README.md                This file
```

Two starter posts are published, both written to the positioning doc (`neuroscience-made-easy-positioning.md` in the parent folder):

1. **What is a neuron, really?** — the foundational first-principles post that every later post can reference.
2. **Dopamine doesn't do what you think it does.** — a myth-busting deep dive that establishes credibility and gives the blog an immediate point of view.

Both are drafts. Read through them carefully and adjust anything that doesn't sound like your voice before publishing.

## To view locally

Double-click `index.html`. It opens in your default browser.

## To deploy (recommended: Netlify Drop)

1. Go to https://app.netlify.com/drop
2. Drag the entire `neuroscience-made-easy` folder onto the page
3. Netlify gives you a live URL (e.g. `neuroscience-made-easy.netlify.app`) within seconds — free forever
4. To use a custom domain (`neurosciencemadeeasy.com`), buy the domain (Namecheap, Porkbun, Cloudflare ~$10/yr) and point it at the Netlify site

Other free options: **GitHub Pages**, **Vercel**, **Cloudflare Pages**. All work the same way — give them static files, get back a live URL.

## To add a new post

1. Copy one of the existing files in `posts/` as a template (e.g. `cp posts/what-is-a-neuron.html posts/your-new-post.html`).
2. Edit the title, subtitle, date, read time, and body content.
3. Open `index.html` and add a new `<li class="post-card">` block at the top of the post list pointing to your new file.

## To make the Subscribe button actually work

Right now the form just shows an alert. To connect it to a real email service:

1. Sign up for a free transactional/newsletter provider — **Buttondown** ($9/mo, very clean) or **ConvertKit** (free up to 1,000 subscribers) are good choices.
2. Each provider gives you an HTML form snippet — replace the `<form class="cta__form">` element in all three HTML files (`index.html`, `about.html`, both posts) with their snippet.

## Design notes

- **Fonts:** Newsreader (body, serif) and Inter (UI, sans) — both loaded from Google Fonts.
- **Colors:** Editorial cream background, near-black text, single deep-teal accent. All defined as CSS variables at the top of `styles.css` — change them in one place to retheme the whole site.
- **Layout:** Reading column capped at 680px for comfortable line length. Responsive down to mobile.

## Editorial standards (from the positioning doc)

Before publishing any post, run this checklist:

1. Every factual claim is sourced or sourceable.
2. No hedging without explaining — "studies suggest" must be replaced with specifics.
3. Don't conflate animal models with humans.
4. Distinguish correlation from causation, every time.
5. When something is contested, present both sides.
6. Acknowledge what you don't know.

If a post doesn't deliver on both halves of the promise — accurate enough for a science-literate reader, readable enough for a smart non-scientist — it isn't ready.
