---
name: behaviors
description: >-
  Write and debug Browsertrix Crawler custom behaviors — automating "Load
  More" / infinite scroll / expandable content, feeding behavior-discovered
  links into the crawl queue with addLink(), and diagnosing why dynamically
  loaded pages aren't crawled or don't replay. Use when creating or editing a
  browsertrix-crawler custom behavior (JS under config/behaviors or referenced
  by customBehaviors), archiving a site whose content loads via JS interaction,
  or troubleshooting a WACZ where expected pages are missing or an interaction
  doesn't replay.
---

# Browsertrix custom behaviors

A behavior is a JS class the crawler injects into each page; it runs the first
one whose `isMatch()` returns true. Use it to drive JS-dependent content
(clicking "Load More", infinite scroll, expanding sections) so the crawler can
archive it.

For the full narrative guide and the debugging playbook, read
[`reference/guide.md`](reference/guide.md). This file is the fast path. For
harder pages — infinite scroll, virtualized feeds, media capture, login/bot
walls — see the guide's "Patterns for harder pages" (§12), distilled from the
bundled browsertrix-behaviors.

## Workflow

1. **Learn what the interaction actually does first.** In a real browser,
   instrument `fetch`/`XMLHttpRequest` and trigger the control. Note: GET or
   POST? Is the request URL **deterministic** or does it carry a random
   cache-buster/nonce? Deterministic requests replay cleanly. (See guide §7a.)
2. **Write the behavior** from [`assets/behavior-template.js`](assets/behavior-template.js).
   Scope `isMatch()` tightly; make the loop detect "done" by the control
   disappearing and "batch loaded" by a state change (not a fixed sleep); keep a
   hard iteration cap.
3. **Queue discovered links** (see the critical rule below).
4. **Wire it into the config** and raise `behaviorTimeout`.
5. **Verify with a bounded trial crawl** (`pageLimit`, `generateWACZ: false`,
   tiny click cap), then inspect logs + the WACZ on disk. (Guide §7b–d.)
6. **Test replay** in ReplayWeb.page (the canonical viewer). (Guide §7e.)

## The critical rule (this is the #1 mistake)

**The crawler extracts a page's links BEFORE your behavior runs.** Anything your
behavior reveals (Load More results, lazy-loaded items) is recorded as network
traffic but is **never queued as its own page** unless the behavior queues it:

```js
const { addLink } = ctx.Lib;
// after each batch/scroll, deduped:
addLink(url); // pushes url into the crawl frontier
```

Call it **incrementally** (each batch), so a `behaviorTimeout` mid-run doesn't
lose everything. And because those URLs are usually out of scope, set in the
config:

```yaml
alwaysAddBehaviorLinks: true   # crawl behavior-added links even if out of scope
```

## Scope: avoid the junk crawl

`extraHops: 1` follows **every** link on the seed page — nav, footer, social
(Facebook!), other domains — which slows the crawl and archives noise. If your
behavior queues the URLs you want via `addLink`, use:

```yaml
scopeType: page
extraHops: 0                   # don't follow the seed's own nav/footer links
alwaysAddBehaviorLinks: true   # only the behavior's links get crawled
```

## Config snippet

```yaml
scopeType: page
extraHops: 0
customBehaviors:
  - /crawls/config/behaviors/my-behavior.js   # container path; mount your project at /crawls/
behaviorTimeout: 600           # seconds; default 90 — raise for long behaviors
alwaysAddBehaviorLinks: true
logging: stats,behaviors,behaviors-debug
```

## Quick debugging commands

```sh
# Behavior events in the crawl log (getState messages show here):
grep -oE '"context":"[^"]*"|"message":"[^"]*"' collections/<name>/logs/*.log | paste - -

# Was a URL CAPTURED as a response? (digest e3b0c442… = empty body)
gunzip -c collections/<name>/indexes/index.cdx.gz | grep "<endpoint>" | head

# Was a URL CRAWLED as its own page? (the #1-rule check)
grep -o '"url": *"[^"]*"' collections/<name>/pages/extraPages.jsonl
```

## Bundled files

- [`assets/behavior-template.js`](assets/behavior-template.js) — a starting-point
  behavior with the addLink pattern baked in.
## Working it out in a real browser first

Do not write a behavior by guessing at selectors and running a crawl to find
out. `btrix_browser` opens a real Chrome, inside the crawler's own container,
on the page in question:

```
btrix_browser  url=https://example.org/news
```

Watch and click it at <http://localhost:6080>. Then `btrix_eval` runs
expressions against that live page, so the loop is seconds instead of a crawl:

```
btrix_eval  js=document.querySelectorAll('.load-more').length
  => 1
btrix_eval  js=document.querySelectorAll('article').length
  => 20
btrix_eval  js=(() => { document.querySelector('.load-more').click(); return 'clicked' })()
  => "clicked"
btrix_eval  js=document.querySelectorAll('article').length
  => 40
```

That sequence answers the questions a behavior is built from: does the control
exist, what does it match, does clicking it actually add items, and how many
per click. `console.log` from evaluated code comes back too, which is the same
channel a behavior reports on.

Three things to know about it:

- It is the **same Chrome the crawler uses**, in the same container, so a
  selector that works here works in a crawl. It is not the user's own browser,
  and nothing is saved.
- It is a **throwaway**: one page at a time, closed when the session ends.
- It cannot run a behavior *class* as the crawler would — there is no behavior
  API shim in there. Work out the selectors and the interaction here, then put
  them in the behavior and run a small crawl (`pageLimit: 2`) to check the real
  thing, reading `behaviorScriptCustom` lines from the log.

- **Serving a WACZ for replay** — a Range + CORS static server
  for loading a large local `.wacz` into ReplayWeb.page:
  Use `btrix_view` for an archive in the store. For a WACZ anywhere else, run
  `node <btrix>/src/serve.ts <dir> [port]` then open
  `https://replayweb.page/?source=http://localhost:<port>/<file>.wacz`.
- [`reference/guide.md`](reference/guide.md) — the full guide + debugging playbook.
- [`reference/crawler-options.md`](reference/crawler-options.md) — every `crawl`
  option grouped by purpose (scope, behaviors, timing, rate limiting, …), with
  defaults. Generated from the pinned image's `crawl --help`.

## Etiquette & rate limits

Sleep between actions; prefer 1 worker (+ `pageExtraDelay`) to stay below
bot-mitigation thresholds. Never trigger `alert()`/`confirm()`/`prompt()` —
modal dialogs freeze the browser and stall the crawl.

If you see an anti-bot interstitial ("Just a quick check…", "Just a moment…"),
the site is throttling you. **Back off — don't try to defeat it.** Add
`pageExtraDelay`, keep 1 worker, and let the crawler's built-in retry (log line
`"Page possibly rate limited, retrying"`) do its thing. Full details and
detection commands in [`reference/guide.md`](reference/guide.md) §8.
