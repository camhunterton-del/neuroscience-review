# Publishing a scheduled Wednesday post

Each Wednesday deep dive publishes through its own one-off workflow
`.github/workflows/publish-<slug>-post.yml` that merges the staged `post/<slug>`
branch into `main` on a dated cron.

## The cron must be a RETRY WINDOW, not a single time

GitHub's scheduled crons are **best-effort** and regularly get delayed or silently
dropped, especially near busy clock times like `:00` and `:13`. On 2026-09-16 the
single `13 13 16 9 *` cron never fired and the post only went live via a manual
trigger. The publish workflow is **idempotent** (it exits early if the post file is
already on `main`) and **concurrency-guarded**, so firing it several times is a safe
no-op after the first success.

So every publish workflow should schedule **several attempts** across the publish
morning instead of one:

```yaml
on:
  schedule:
    - cron: '13 13 16 9 *'   # 9:13am ET  (primary)
    - cron: '25 13 16 9 *'   # 9:25am ET  (retry)
    - cron: '45 13 16 9 *'   # 9:45am ET  (retry)
    - cron: '15 14 16 9 *'   # 10:15am ET (final retry)
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Test the merge without publishing'
        type: boolean
        default: false
```

Use the same date on every line; only the first attempt that actually fires
publishes, and the rest no-op. Times above are for EDT (UTC-4); in EST (UTC-5) add
an hour to the UTC hour field.

## The safety net

`.github/workflows/publish-guard.yml` runs late every Wednesday morning. If any
`publish-*-post.yml` has a dated cron for **today** and that post is **not live**, it
opens a `🔴 Wednesday post did not publish on time` issue with the exact manual-fix
command. So even if every scheduled attempt is dropped, the miss is caught the same
morning instead of breaking the streak silently.

## Manual publish (always available)

```
gh workflow run publish-<slug>-post.yml --ref main
```

Idempotent and safe to run anytime — it no-ops if the post is already live.
