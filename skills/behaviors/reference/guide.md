# Writing & debugging Browsertrix custom behaviors — full guide

The reference companion to the `behaviors` skill. A field guide to
writing [browsertrix-crawler] custom behaviors and, just as importantly,
figuring out why they aren't doing what you expect. Corrections and additions
welcome — keep it a living resource.

Everything here was learned the hard way while archiving a paginated "Load More"
article list — the running example throughout, with a ready-to-adapt starting
point in [`assets/behavior-template.js`](../assets/behavior-template.js).
Details like the exact `ctx.Lib` helpers can vary between crawler
versions, so treat this as a map, not gospel — verify against the version you're
running (`webrecorder/browsertrix-crawler:latest` here).

- Behaviors reference: <https://crawler.docs.browsertrix.com/user-guide/behaviors/>
- Behaviors source: <https://github.com/webrecorder/browsertrix-behaviors>

---

## 1. Anatomy of a custom behavior

A behavior is a plain JS class. The crawler injects it into every page and runs
the **first** one whose `isMatch()` returns true.

```js
class MyBehavior {
  // Required. Shown in logs; keep it unique across the behaviors you load.
  static id = "MyBehavior";

  // Required. Runs in the page. Return true to run this behavior on this page.
  static isMatch() {
    return !!window.location.href.match(/example\.com\/some-section\//);
  }

  // Optional. Return initial state (rarely needed).
  static init() {
    return {};
  }

  // Required. An async generator. `yield` hands control back to the crawler
  // (for logging and graceful interruption); do real work between yields.
  async *run(ctx) {
    const { sleep, addLink } = ctx.Lib; // grab helpers (see §2)
    // ...
    yield ctx.Lib.getState(ctx, "did a thing", "myCounter"); // log progress
  }
}
```

Key points:

- `run()` **must** be an `async *` generator. `yield` is how the crawler learns
  you're still alive and lets it stop you cleanly if `behaviorTimeout` is hit.
- `isMatch()` runs in the page context — it can read `window.location`, the DOM,
  etc. Scope it tightly so it doesn't fire on pages you don't mean it to.
- Besides `run()`, a class may define optional hooks: `static onPageInit()`,
  `async awaitPageLoad(ctx)` (awaited before the crawler snapshots/processes the
  page — a good place to detect a login wall via `assertContentValid()` + the
  `failOnContentCheck` option), `static runInIframe`, and `cleanup()`. `init()`
  can return `{ state, opts }` if you need starting state.
- Only the first *matching* behavior runs per page, but the built-ins still run:
  `autoscroll` (scrolls to trigger infinite scroll), `autoplay`, `autofetch`,
  and `siteSpecific` (maintained behaviors for Twitter/X, Instagram, Facebook,
  …). There's also `autoclick`, which clicks elements matching `clickSelector`
  (default `a`). **Prefer a built-in when one fits** — for social sites,
  Webrecorder staff recommend `behaviors: siteSpecific` over a plain autoscroll,
  which can stop early
  ([forum](https://forum.webrecorder.net/t/browsertrix-configuration-for-list-of-twitter-profiles/164)).

---

## 2. The `ctx.Lib` toolbox

Helpers live on `ctx.Lib`. The idiomatic style (used by the built-in behaviors)
is to destructure the ones you need at the top of `run()`:

```js
const {
  sleep,            // sleep(ms) — await it
  addLink,          // addLink(url) — queue a URL for crawling (see §3) — critical!
  getState,         // getState(ctx, message[, counterName]) — yield this to log
  scrollAndClick,   // scroll an element into view and click it
  scrollIntoView,
  waitUntil,        // waitUntil(predicate, interval) — poll until true
  waitUntilNode,    // waitUntilNode(xpath, root, oldNode, timeout, interval)
  waitForNetworkIdle,// waitForNetworkIdle(idleMs=500, concurrency=0) — let XHRs settle
  iterChildMatches, // async iterator: yields matching children AS they lazy-load
  iterChildElem,    // async iterator over child elements (infinite scroll / Load More)
  xpathNode, xpathNodes, xpathString,
  isInViewport,
  doExternalFetch,  // doExternalFetch(url) -> bool — capture an asset out-of-band
  assertContentValid, // fail the crawl on bad content (with failOnContentCheck)
} = ctx.Lib;
```

`iterChildMatches` / `iterChildElem` are especially handy for infinite-scroll and
"Load More" lists — they yield newly-appeared elements as the page loads them,
so you can process items without re-scanning the whole DOM each pass. Prefer
`waitForNetworkIdle` / `waitUntilNode` over fixed `sleep`s to know a batch has
settled.

The exact set varies by crawler version (these are verified against current
`main`, `src/lib/utils.ts`) — if something's missing, check the
`browsertrix-behaviors` source for your version. When in doubt you can always
fall back to plain DOM APIs (`document.querySelector`, `element.click()`, etc.),
which is what the example behavior mostly does.

> Note: `Date.now()` and friends work fine inside behaviors (they run in the
> real browser page), so timing loops are OK here.

---

## 3. The one thing that will bite you: link extraction runs BEFORE behaviors

This is the single most important thing to internalize.

**The crawler extracts a page's links right after load, _before_ your behavior
runs.** So any links your behavior reveals — by clicking "Load More", expanding
sections, infinite-scrolling — are invisible to the normal link extractor. They
get recorded as *network responses* (so the page replays), but they are **never
queued as their own pages to crawl.**

If you want those revealed URLs crawled as standalone pages, the behavior must
put them in the queue itself, with `addLink()`:

```js
const seen = new Set();
function queueLinks() {
  document.querySelectorAll("a.article-link").forEach((a) => {
    const url = a.href.split("#")[0];
    if (seen.has(url)) return;
    seen.add(url);
    addLink(url);        // <-- pushes url into the crawl frontier
  });
}
```

Call it **incrementally** (after each batch/scroll), not just once at the end —
that way you don't lose everything if the behavior hits `behaviorTimeout`
mid-run.

### `addLink` + scope: you probably need `alwaysAddBehaviorLinks`

Links added via `addLink()` are **still subject to the crawl scope**. If the
URLs you're adding are outside scope (very common — e.g. articles at
`/some-slug/` while your seed is `/writers/name/`), they'll be dropped unless you
set:

```yaml
alwaysAddBehaviorLinks: true
```

This tells the crawler to fetch behavior-added links even when they're outside
the configured scope. (The built-in Instagram/Facebook behaviors rely on this to
queue individual posts/stories.)

> `addLink` has the signature `addLink(url, alwaysObeyScope = false)` and is
> backed by the crawler-injected `__bx_addLink` (so it's a no-op if the host
> crawler didn't inject it). In practice the reliable, documented way to force
> out-of-scope crawling is the `alwaysAddBehaviorLinks` option above.
> Webrecorder staff confirm behaviors run *after* link extraction:
> [forum thread](https://forum.webrecorder.net/t/understanding-custom-browsertrix-behaviors-a-js-popup-scenario/624).

---

## 4. Scope, `scopeType`, and `extraHops` — and how to avoid a junk crawl

These interact in ways that surprise people:

- `scopeType: page` — only the seed URL itself is "in scope."
- `extraHops: N` — also crawl links found on in-scope pages, up to N hops beyond
  scope.

The trap: **`extraHops: 1` follows _every_ link on the seed page** — including
nav, footer, "other editions", and social links. A crawl can happily wander off
into `facebook.com`, other domains, and section pages, which crowds out (and
slows down) the content you actually wanted.

The clean pattern for "seed page + only the things my behavior discovers":

```yaml
scopeType: page
extraHops: 0                 # do NOT follow the seed's own nav/footer links
alwaysAddBehaviorLinks: true # but DO crawl what the behavior addLink()s
```

With `extraHops: 0`, the *only* out-of-scope pages crawled are the ones your
behavior explicitly queues. If your behavior only `addLink`s the URLs you care
about (e.g. filter to one host), the crawl stays tightly focused — no Facebook,
no stray domains. Verified: same seed, `extraHops:1` crawled 0 target articles +
a pile of off-site junk within a page limit; `extraHops:0` crawled only the
articles, all on the intended host.

To restrict by host more explicitly you can also use `exclude` regex rules, but
if the behavior controls what gets queued, `extraHops: 0` alone is usually
enough.

---

## 5. Wiring a behavior into a crawl config

```yaml
customBehaviors:
  - /crawls/config/behaviors/my-behavior.js
behaviorTimeout: 600        # seconds; default is 90 — raise it for long behaviors
alwaysAddBehaviorLinks: true
```

- **Paths are container paths.** The crawler's working dir defaults to `/crawls/`,
  so mount your project there (`-v $PWD:/crawls/`) and a file at
  `config/behaviors/x.js` is referenced as `/crawls/config/behaviors/x.js`.
  `customBehaviors` also accepts a directory, a URL, or a `git+https://…` spec.
- **`behaviorTimeout` (default 90s) is a hard cap on your behavior.** A behavior
  that clicks through dozens of "Load More" batches will blow past 90s — raise
  it, and make your behavior incremental so a timeout doesn't lose progress.
- Turn on behavior logging so you can see it work:
  `logging: stats,behaviors,behaviors-debug`.

---

## 6. Worked example: click "Load More" until it's gone

Start from [`../assets/behavior-template.js`](../assets/behavior-template.js).
The shape, generalized:

```js
async *run(ctx) {
  const { sleep, addLink } = ctx.Lib;
  const selector = "div.load-more > a";
  const seen = new Set();

  const queue = () => document
    .querySelectorAll('a.article[href^="https://example.com/"]')
    .forEach((a) => {
      const u = a.href.split("#")[0];
      if (!seen.has(u)) { seen.add(u); addLink(u); }
    });

  for (let i = 0; i < 5000; i++) {          // hard safety cap
    const link = document.querySelector(selector);
    if (!link) { queue(); return; }         // button gone -> done

    // The button carries state (here, a `data-next-cursor` attribute) that changes
    // as you page. Capture it, click, then wait until it changes or the button
    // disappears — that's how you know the batch actually loaded.
    const before = link.getAttribute("data-next-cursor");
    link.scrollIntoView({ block: "center" });
    await sleep(3000);                       // be polite; let things settle
    link.click();
    yield ctx.Lib.getState(ctx, `clicked (batch ${i + 1})`, "loadMoreClicks");

    const start = Date.now();
    while (Date.now() - start < 30000) {
      await sleep(1500);
      const cur = document.querySelector(selector);
      if (!cur || cur.getAttribute("data-next-cursor") !== before) break;
    }
    queue();                                 // queue new links each batch
  }
}
```

Transferable lessons: (1) detect "done" by the control disappearing; (2) detect
"batch loaded" by watching a state attribute change, not a fixed `sleep`; (3)
`addLink` each batch as you go; (4) keep a hard iteration cap so a misbehaving
page can't loop forever.

---

## 7. Debugging playbook

### a. First, learn what the page actually does

Before writing anything, watch the real network request the interaction makes.
In a browser console, wrap `fetch`/`XMLHttpRequest` and trigger the control:

```js
const orig = window.fetch;
window.fetch = (...a) => { console.log("FETCH", a[0], a[1]?.method); return orig(...a); };
// also patch XMLHttpRequest.prototype.open/send similarly
```

You're looking for: is it GET or POST? Is the URL **deterministic**, or does it
carry a per-request nonce/timestamp/cache-buster? Deterministic requests replay
cleanly; ones with a random `_=1699…` cache-buster may need fuzzy matching. (A
clean GET to an endpoint with a stable cursor param is the easy case — it will
replay once the pages are queued.)

### b. Iterate with a bounded trial crawl, not the real one

Don't debug against a multi-hour crawl. Make a throwaway config:

```yaml
collection: my-test
generateWACZ: false     # skip packaging; faster
logging: stats,behaviors
pageLimit: 25           # cap total pages
workers: 1
# ...your behavior, with a temporarily tiny click cap (e.g. maxClicks = 3)
```

Run it directly (no `-it`, so output streams to a file you can grep):

```sh
docker run --rm -v "$PWD":/crawls/ webrecorder/browsertrix-crawler:latest \
  crawl --config /crawls/config/my-test.yaml
```

### c. Read the crawl logs

Behavior output shows up under the `behaviorScript` / `behaviorScriptCustom`
contexts; anything you `getState(...)` appears as a `message`. This is how you
confirm ordering and progress:

```sh
grep -oE '"context":"[^"]*"|"message":"[^"]*"' collections/<name>/logs/*.log \
  | paste - - | grep -iE 'behavior|link|extract'
```

### d. Inspect the WACZ/CDX on disk — was it captured? was it queued?

These answer two *different* questions:

- **Captured as a network response?** Grep the CDX index:
  ```sh
  gunzip -c collections/<name>/indexes/index.cdx.gz | grep "your-endpoint" | head
  ```
  Each line's JSON has `status`, `mime`, and a `digest`. Handy tell: a digest of
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` is the
  SHA-256 of an **empty body** — e.g. the terminal "no more results" response.
- **Queued and crawled as its own page?** Check the page lists:
  ```sh
  wc -l collections/<name>/pages/pages.jsonl        # seed pages
  wc -l collections/<name>/pages/extraPages.jsonl   # everything else crawled
  grep -o '"url": *"[^"]*"' collections/<name>/pages/extraPages.jsonl
  ```
  The classic bug is visible right here: the AJAX responses are in the CDX
  (hundreds of captures) but the revealed pages are absent from
  `extraPages.jsonl` — captured, but never crawled as pages. That's the
  signature of the §3 problem.

### e. Test replay — and know your replayer

- **ReplayWeb.page** (<https://replayweb.page>) is the canonical, always-current
  viewer. Trust it. Drag a `.wacz` onto it, open the page, exercise the control.
- **ArchiveWeb.page** bundles its *own* (often older) copy of the replay engine
  and is recording-oriented; a dynamic interaction can behave differently there
  even with an identical WACZ. If something replays in ReplayWeb.page but not
  ArchiveWeb.page, suspect the app (version, incomplete import, or a stray
  live-network fallback) — not your archive.
- Large WACZ: serve it locally with `btrix_view`, or
  `node <btrix>/src/serve.ts <dir> [port]`, then open
  `http://127.0.0.1:PORT/?source=foo.wacz`. The viewer is served from that same
  origin, so there is no cross-origin fetch to be refused — which is the point:
  a page on `replayweb.page` reaching `127.0.0.1` is blocked by some browsers
  and by LAN-blocking extensions. The server honours `Range: bytes=-N` suffix
  requests, which is how the ZIP index is read.
- **Full-text search:** ReplayWeb.page's page search (URL / title / text) only
  searches text stored in the page index, so crawl with `text: to-pages` — that
  writes each page's text into `pages.jsonl`. Text written `to-warc` lives in
  WARC records the search doesn't index, so the archive won't be searchable.

### f. Test the behavior standalone in DevTools

Faster than a crawl for logic bugs: build `browsertrix-behaviors` (produces
`dist/behaviors.js`), load it on the target page, then in the console run
`self.__bx_behaviors.run()` to exercise it against the live DOM. Toggle built-ins
with `self.__bx_behaviors.init({autoscroll:true, siteSpecific:true, …})`. "Active"
behaviors (autoscroll and your custom one) need an explicit
`await self.__bx_behaviors.run()`. (Source: browsertrix-behaviors README.)

---

## 8. Rate-limit / anti-bot interstitials

Sites often gate content behind a JavaScript anti-bot / rate-limit interstitial
— a bare page with just the site header and text like **"Just a quick check…"**,
"Verifying you are human", or "Just a moment…". It appears when your request
rate looks automated. It's usually a device/JS challenge a real browser clears
on its own (not a click-CAPTCHA).

**Do not try to defeat it.** Getting challenged is the site telling you to slow
down; the correct — and most effective — response is to back off. (Solving or
circumventing CAPTCHAs / bot-detection is out of bounds.)

How to spot it in a run:

The retry count is in the crawler's own log, so `grep` it directly — the
pattern `"message":"Page possibly rate limited, retrying"` under
`collections/<name>/logs/`.

Whether the interstitial was *recorded* takes decompressing the WARCs, which
needs a shell btrix does not have. Ask the user to run this themselves with
`!`, and read the number back:

```sh
for w in collections/<name>/archive/rec-*.warc.gz; do gunzip -c "$w"; done \
  | grep -a -c -i "just a quick check"
```

If the retry count roughly matches the interstitial-capture count and your saved
page **titles** are all real content (`pages/*.jsonl`), the crawler is winning:
it retried and got the real page. If pages are saved *as* the interstitial,
they'll also replay that way — spot-check a few in ReplayWeb.page and re-crawl
the affected URLs.

Mitigations, gentlest first:

- **`pageExtraDelay: <seconds>`** — space out page loads to stay under the rate
  threshold. This is the primary lever.
- **1 worker** — sequential requests look far less like an attack than parallel.
- **A warmed browser profile** (e.g. via a `create-login-profile` run) so a
  normal cookie/session is present.
- **Let the built-in retry work**, then do a second pass to backfill any URLs
  that still came through as the interstitial.
- Respect the site's `robots.txt` and terms — if you're being throttled, that's
  the signal to slow down, not push harder.

The retry is driven by tunable options (see `crawler-options.md` → "Rate
limiting"). By default the crawler treats **HTTP 403/429/503** as rate-limited
(`rateLimitStatusCodes`) and retries up to **4×** (`rateLimitMaxRetries`); the
text matcher `rateLimitOnMatch` only ships with an Incapsula pattern, so if your
interstitial returns a **200** you can add its marker text there so it's caught
too. `rateLimitInterruptCount` can abort the whole crawl once you've been
throttled N times.

## 9. Stopping & resuming a crawl (don't blow away your progress)

Long crawls get interrupted — stop them the right way and you can resume instead
of starting over.

- **Interrupt with a single Ctrl-C / SIGINT and wait.** One signal lets the
  crawler finish in-flight pages, flush WARCs, write the WACZ, and save state. A
  *second* signal skips WACZ generation; a `SIGKILL` (`docker kill`) can leave
  WARCs invalid. Prefer one signal and be patient.
- **Re-running the same collection RESUMES from saved state** — the queue (all
  those `addLink`-ed URLs) and completed pages are restored, and the seed's
  Load-More behavior won't re-run. `saveState` defaults to `partial` (state
  written on interrupt), which is enough to resume after a clean Ctrl-C.
- **`overwrite: true` (`--overwrite`) DELETES the collection directory first.**
  That's the "blow away my progress" switch — great for a genuine fresh start,
  but it wipes any resumable state and the WARCs already captured. Don't set it
  if you mean to resume. (Re-running the same `crawl` command *without*
  `--overwrite` resumes.)
- **For very long crawls, set `saveState: always`** with `saveStateInterval:`
  (seconds; default 300) so state is checkpointed *during* the crawl, not only
  on interrupt. `saveStateHistory:` keeps several checkpoints as backups.
- **Bound long crawls so they stop cleanly** instead of crashing: `sizeLimit`
  (bytes), `timeLimit` (seconds), and `diskUtilization` (percent) each save
  state and exit when exceeded.

Docs: <https://crawler.docs.browsertrix.com/user-guide/common-options/>

## 10. Gotchas checklist

- [ ] `run()` is `async *` and you `yield` periodically.
- [ ] `isMatch()` is scoped tightly (it runs on every page).
- [ ] Links your behavior reveals are `addLink()`-ed (they are NOT auto-extracted — §3).
- [ ] `alwaysAddBehaviorLinks: true` if those links are out of scope.
- [ ] `extraHops: 0` unless you truly want the seed's own nav/footer links followed (§4).
- [ ] `behaviorTimeout` raised to fit a long behavior; behavior is incremental so a timeout doesn't lose work.
- [ ] A hard iteration cap so the behavior can't loop forever.
- [ ] Behavior never triggers `alert()`/`confirm()`/`prompt()` — modal dialogs freeze the browser.
- [ ] Be polite: sleeps between actions, 1 worker (and optionally `pageExtraDelay`) to avoid tripping bot mitigation.

## 11. Community field tips & resources

Curated, source-linked wisdom from the Webrecorder forum, the docs, and this
work. Docs and staff-attributed posts (Ilya/Hank/Tessa of Webrecorder) are the
firmest; community/unresolved threads are flagged. Anti-bot and replay behavior
is version-sensitive — test against your own crawler / ReplayWeb.page versions.

**Resources**

- [`crawler-options.md`](crawler-options.md) — every option, with defaults.
- Forum: [Custom Behaviors](https://forum.webrecorder.net/c/behaviors/29) · [Help!](https://forum.webrecorder.net/c/help/5)
- Docs: [scope](https://crawler.docs.browsertrix.com/user-guide/crawl-scope/) · [behaviors](https://crawler.docs.browsertrix.com/user-guide/behaviors/) · [profiles](https://crawler.docs.browsertrix.com/user-guide/browser-profiles/) · [QA](https://crawler.docs.browsertrix.com/user-guide/qa/)

**Behaviors & dynamic content**

- **Try it manually first.** Record the page by hand in ArchiveWeb.page while you
  click/scroll, then replay. If manual capture can't replay it, a behavior
  usually won't either — the problem is elsewhere (e.g. an embed that resists
  archiving), so find that out before writing code.
- **Prefer behavioral triggers over hardcoded asset lists** — interacting
  (scroll/click/play) to *organically* load resources beats reverse-engineering
  asset URLs, which rot as the site changes.
- `doExternalFetch(url)` captures an asset out-of-band; the community Vimeo
  behavior parses `playlist.json` and fetches segment URLs this way
  ([forum](https://forum.webrecorder.net/t/custom-vimeo-behavior-documentation/867) — community).
- For **no-code pagination**, JSON Flow behaviors recorded with Chrome DevTools
  Recorder auto-repeat a step (e.g. "Next") until it fails
  ([Webrecorder blog](https://webrecorder.net/blog/2025-05-28-create-use-and-automate-actions-with-custom-behaviors-in-browsertrix/)).

**Scope**

- **Exclusion beats inclusion:** if a URL matches both include and exclude, it's
  excluded. `exclude` (scopeExcludeRx) is your main anti-wander lever ([docs](https://crawler.docs.browsertrix.com/user-guide/crawl-scope/)).
- include/exclude are **regexes, not globs** — escape `.` `?` `+`. Excluded URLs
  aren't logged, so verify by inspecting what *was* captured
  ([forum](https://forum.webrecorder.net/t/excluding-pages-scope/927) — community).
- **Page scope ≠ resource blocking.** Use `blockRules` to stop a heavy embedded
  asset that loads on every page (one crawl ballooned 100MB→1GB from an audio
  embed) ([forum](https://forum.webrecorder.net/t/unable-to-exclude-an-embedded-audio-hosted-by-google-drive-on-browsertrix-crawler/444) — community).
- **No built-in per-domain page cap** — run one crawl job per domain for broad
  crawls ([forum](https://forum.webrecorder.net/t/setting-up-limits-for-broadcrawls/1063) — staff).
- `extraHops` can break embedded-media replay; test per site
  ([forum](https://forum.webrecorder.net/t/find-optimal-scope-for-fetching-website-incl-embeds-and-linked-pages/1044) — community).

**Rate limiting & blocking** (see also §8)

- Watch **HTTP 429/403** as the "you're throttled" tell; `failOnInvalidStatus`
  makes a blocked crawl fail loudly instead of archiving error pages ([docs](https://crawler.docs.browsertrix.com/user-guide/cli-options/)).
- A **browser profile** sometimes makes a Cloudflare challenge disappear
  (returning-visitor cookies) ([forum](https://forum.webrecorder.net/t/cloudflare-bypass-website-under-our-control/999) — staff thread).
- **Proxies** (`proxyServer`, `proxyServerConfig`) fix geo/IP blocking — staff
  have diagnosed 403s as geo-blocks ([docs](https://crawler.docs.browsertrix.com/user-guide/proxies/), [forum](https://forum.webrecorder.net/t/403-forbidden-on-web-accessible-content/719) — staff).
- If you **own the site**, allowlist the crawler's IPs/UA in the WAF rather than
  fighting it; put a contact email in `userAgentSuffix`
  ([forum](https://forum.webrecorder.net/t/cloudflare-bypass-website-under-our-control/999) — staff).
- Some challenges (reCAPTCHA) aren't solvable from config — use a profile/proxy,
  coordinate with the owner, or back off
  ([forum](https://forum.webrecorder.net/t/recaptcha-validation-error/906) — staff, inconclusive).

**Profiles & logins**

- Create interactively: `create-login-profile --url …` (open the UI on port
  9223; 6080 is the VNC websocket it embeds), log in, click "Create Profile" to
  get a `profile.tar.gz`, then crawl with `profile:`. Create the profile
  the **same way you crawl** (e.g. both `--headless`) ([docs](https://crawler.docs.browsertrix.com/user-guide/browser-profiles/)).
- A replay that shows only a login popup usually means the session **expired at
  crawl time** — refresh the profile and re-crawl
  ([forum](https://forum.webrecorder.net/t/replay-instagram-account/267) — community).

**Large / long crawls** (see also §9)

- Mass "failed" after N pages is often a **memory/worker-crash cascade** — lower
  `workers`, raise `pageLoadTimeout`
  ([forum](https://forum.webrecorder.net/t/crawl-stops-loading-pages-and-marks-them-as-failed-after-a-certain-threshold/1040) — community, unresolved).
- "Queued but not crawled" pages almost always have a **log reason** (redirect to
  an excluded URL, `net::ERR_BLOCKED_BY_RESPONSE`, time limit) — read the log
  ([forum](https://forum.webrecorder.net/t/5-476-pages-missing-from-a-large-crawl/871) — staff).

**Replay & QA**

- **Prefer WACZ over bare WARC** — WACZ bundles the CDXJ index + page list that
  replayers need ([forum](https://forum.webrecorder.net/t/differences-between-wacz-and-warc-file-for-x/1000) — staff).
- "No Pages are defined in this archive" on a big multi-WACZ crawl is usually an
  **outdated ReplayWeb.page** — update it, or replay the per-shard WACZ files
  individually ([forum](https://forum.webrecorder.net/t/replayweb-page-wont-display-wacz-files/707) — staff).
- Quantify capture-vs-replay fidelity with the crawler's **QA mode** (`qaSource`);
  needs the crawl run with `screenshot: view` + `text: to-warc` ([docs](https://crawler.docs.browsertrix.com/user-guide/qa/)).

## 12. Patterns for harder pages (from the built-in behaviors)

Past a simple "Load More", the bundled behaviors in
[browsertrix-behaviors](https://github.com/webrecorder/browsertrix-behaviors) are
the best teachers. The patterns below are distilled from them (v0.12.3) — and the
highest-leverage move is to **read the source of the one closest to your case**:
`autoscroll.ts` (infinite scroll), `autoclick.ts` (safe clicking),
`autofetcher.ts` / `autoplay.ts` (assets & media), and the site behaviors
(`instagram.ts`, `twitter.ts`, `facebook.ts`, `youtube.ts`). You'll learn more
from those than from any prose; the file names below point there.

### Bounded waiting: race the signal against a hard cap

Never blind-sleep, but never hang either. Wait for the *actual* signal (a node
appears, an attribute changes, the network goes idle) raced against a ceiling:

```js
const { waitUntil, sleep } = ctx.Lib;
await Promise.race([
  waitUntil(() => document.querySelector(".results .item"), 250), // poll
  sleep(20000),                                                   // give up
]);
```

`ctx.Lib.waitForNetworkIdle()` is the equivalent when the trigger is a background
XHR. This race is the single most important reliability idiom. (`lib/utils.ts`,
used throughout `autoscroll.ts`.)

### Infinite scroll & virtualized lists

Feeds that recycle DOM nodes (render only what's on-screen) destroy off-screen
elements, so you can't collect references and process them later:

- **Scroll incrementally with stuck-detection** — scroll a small step, bump a
  counter when `scrollHeight` grows, stop once the scroll position repeats a
  couple of times. (`autoscroll.ts`)
- **Process each item before it scrolls out** — do all the work (open, expand,
  `addLink`) inline during the one pass. (`instagram.ts`, `twitter.ts`)
- **Re-locate your place after the DOM rebuilds** — capture a stable id (e.g. an
  item's permalink `href`) *before* acting, then re-find that node afterward
  instead of trusting a stale reference. (`instagram.ts`, `twitter.ts` — the
  `RestoreState` helper)
- `ctx.Lib.iterChildElem` / `iterChildMatches` stream a container's children as
  they lazy-render — built for this.

### Knowing when to stop (no explicit "end")

- **Feed:** re-query the list each pass; stop when the first element is identical
  to last round (nothing new materialized). (`facebook.ts`)
- **Carousel / slideshow:** click "next" until `window.location.href` (or the
  active slide) stops changing. (`twitter.ts`, `facebook.ts`)
- Always keep a hard iteration cap as a backstop.

### Queue a permalink for every item (coverage)

Sites render a post one way in-feed and another on its own page. While you're on
each item, `addLink()` its canonical standalone URL (strip the query string,
dedupe with a `Set`) so the crawler captures the standalone version too:

```js
const seen = new Set();
for (const post of posts) {
  const url = post.querySelector("a.permalink")?.href.split("?")[0];
  if (url && !seen.has(url)) { seen.add(url); addLink(url); }
}
```

This is the feed equivalent of the §3 rule. (`instagram.ts`, `facebook.ts`)

### Fail loudly on login / bot walls: `awaitPageLoad` + `assertContentValid`

Don't silently archive a login or "verify you're human" page. In an
`awaitPageLoad(ctx)` hook, assert a **sentinel that exists only in the good
state**, and throw a named reason so the crawler records a failure:

```js
async awaitPageLoad(ctx) {
  const { assertContentValid, waitUntilNode, sleep } = ctx.Lib;
  await Promise.race([ waitUntilNode('//button[@aria-label="New post"]'), sleep(10000) ]);
  assertContentValid(() => !!document.querySelector('nav [aria-label="Home"]'), "not_logged_in");
}
```

Run the crawl with `failOnContentCheck: true` to make that reason fail the page.
Choose a language-stable sentinel where you can. (every site behavior;
`lib/utils.ts`)

### Capturing media & lazy assets

Media rarely loads from a click alone:

- **Out-of-band fetch** — reconstruct HLS/DASH manifest & segment URLs and hand
  them to the crawler with `ctx.Lib.doExternalFetch(url)`; `addToExternalSet(url)`
  dedupes across the crawl. (`autofetcher.ts`, media site behaviors)
- **Trigger the site's own player, then wait for readiness** — wait on a
  `<video>.readyState >= 3`, or resolve on the first `ended`/`pause`/`error`
  event, raced against a cap; prefer capturing a direct `src` URL over real-time
  playback when one exists. (`autoplay.ts`, `twitter.ts`)
- **Force lazy assets** — flip `loading="lazy"` → `"eager"` and harvest
  `srcset` / `data-src` / `<source>` URLs the browser won't otherwise request, or
  inject a detached `new Image()` with the URL to force the request.
  (`autofetcher.ts`, `telegram.ts`)

### Clicking without wrecking the crawl

If you click links/buttons programmatically:

- **Same-origin only** — skip off-site anchors (let normal crawling handle them),
  plus invisible / disconnected / already-seen elements (track with a `WeakSet`).
- **Guard navigation** — register a `beforeunload` handler that `preventDefault()`s
  during your click loop.
- **Drill in and return** — after a click that pushState-navigated (history grew
  by one *and* the URL changed), `history.back()` and await `popstate` to return
  to the list. (the `HistoryState` helper packages this.)
- Or skip all that and use the built-in **`autoclick`** behavior with a
  `clickSelector`. (`autoclick.ts`, `lib/utils.ts`)

### Advanced: `onPageInit` monkeypatching

A behavior can define a static `onPageInit()` that runs *before* anything else,
to patch native APIs and steer the page toward archivable code paths — e.g.
YouTube overrides `MediaSource.isTypeSupported` to force simpler, capturable video
formats. Powerful, and inherently site-specific. (`youtube.ts`)

> File references are to browsertrix-behaviors v0.12.3; internals drift between
> releases, so read the current source for exact APIs.

[browsertrix-crawler]: https://github.com/webrecorder/browsertrix-crawler
