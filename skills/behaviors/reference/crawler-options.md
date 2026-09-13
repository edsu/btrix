# Browsertrix Crawler options reference

Every `crawl` option, grouped by purpose. Generated from the pinned image:

```sh
docker run --rm webrecorder/browsertrix-crawler:latest crawl --help
```

(Captured 2026-08-01 from `:latest`. Regenerate with the command above when you
bump the image — options drift between releases.) In a **YAML config** use the
long name with the leading `--` stripped, e.g. `--pageExtraDelay` → `pageExtraDelay: 8`.
Aliases are shown after `/`.

## Seeds & scope

| Option | Default | Notes |
|---|---|---|
| `seeds` / `url` | `[]` | Start URL(s). |
| `seedFile` / `urlFile` | — | File with one seed URL per line. |
| `scopeType` | per-seed | `page`, `page-spa`, `prefix`, `host`, `domain`, `any`, `custom`. |
| `scopeIncludeRx` / `include` | dir of URL | Regex of page URLs to include. |
| `scopeExcludeRx` / `exclude` | — | Regex of page URLs to exclude (drop off-site/junk here). |
| `extraHops` | `0` | Follow links N hops **beyond** scope. `1` follows all seed-page links (nav, footer, off-site!). See guide §4. |
| `depth` | `-1` | Max crawl depth from seeds. `-1` = unlimited. |
| `allowHashUrls` | false | Treat `#hash` URLs as distinct pages (SPAs). |
| `selectLinks` / `linkSelector` | `["a[href]->href"]` | Custom link-extraction selectors. Runs at extraction (before behaviors) — does NOT see behavior-revealed links (use `addLink`, guide §3). |
| `addRedirectedSeeds` | false | Add redirected seed URLs as new seeds. |

## Limits

| Option | Default | Notes |
|---|---|---|
| `workers` / `-w` | `1` | Parallel browser workers. Keep at 1 to be gentle / avoid rate limits. |
| `pageLimit` / `limit` | `0` | Max pages to crawl (0 = unlimited). Great for trial runs. |
| `maxPageLimit` | `0` | Hard cap that overrides `pageLimit`. |
| `sizeLimit` | `0` | Save state & exit past this byte size. |
| `timeLimit` | `0` | Save state & exit after N seconds. |
| `diskUtilization` | `0` | Save state & exit past this disk-use %. |

## Timing & waits

| Option | Default | Notes |
|---|---|---|
| `pageLoadTimeout` / `timeout` | `90` | Per-page load timeout (s). |
| `behaviorTimeout` | `90` | Max seconds a behavior runs per page; `0` = until it finishes. Raise for long behaviors. |
| `postLoadDelay` | `0` | Sleep (s) after load, before screenshots/text/behaviors. |
| `pageExtraDelay` / `delay` | `0` | Sleep (s) after behaviors before the next page. **Main politeness / rate-limit lever** (guide §8). |
| `netIdleWait` | `2` | Seconds to wait for network idle after load & behaviors. |
| `netIdleMaxRequests` | `1` | Max in-flight requests to still count as "idle". |
| `waitUntil` | `["load","networkidle2"]` | Puppeteer `goto` condition(s): `load`, `domcontentloaded`, `networkidle0`, `networkidle2`. |

## Behaviors

| Option | Default | Notes |
|---|---|---|
| `behaviors` | `["autoplay","autofetch","autoscroll","siteSpecific"]` | Built-in behaviors to run. Add `autoclick` to click elements. |
| `customBehaviors` | `[]` | File path, directory, URL, or `git+https://…?branch=&path=` for your behavior(s). Container paths — the crawler's default working dir is `/crawls/`, so mount your project there. |
| `clickSelector` | `"a"` | What the `autoclick` behavior clicks. For repeated "Load More" a custom behavior is usually better. |
| `alwaysAddBehaviorLinks` | false | Let behavior `addLink()` calls bypass scope & always be crawled. Needed for out-of-scope discovered links (guide §3–4). |
| `failOnContentCheck` | false | Let a behavior fail the crawl based on page content (e.g. detects logged-out). |

## Link/URL blocking

| Option | Default | Notes |
|---|---|---|
| `blockRules` | `[]` | Regex rules to block URLs from loading (optionally by iframe text match). |
| `blockMessage` | — | Record this message instead of a blocked URL. |
| `blockAds` / `blockads` | false | Block ads via Stephen Black's blocklist. |
| `adBlockMessage` | — | Record this message instead of a blocked ad. |

## Capture output

| Option | Default | Notes |
|---|---|---|
| `collection` / `-c` | `crawl-@ts` | Output collection name/dir. |
| `generateWACZ` / `generateWacz` | false | Package the crawl as `.wacz`. |
| `generateCDX` / `generateCdx` | false | Also write a merged CDXJ index. |
| `combineWARC` / `combineWarc` | false | Combine WARCs into one. |
| `rolloverSize` | `1000000000` | WARC rollover size (bytes). |
| `useSHA1` | false | SHA-1 instead of SHA-256 record digests. |
| `text` | — | Extract page text. `to-pages` writes it into the page index (`pages.jsonl`), which is what makes pages full-text searchable in ReplayWeb.page; `to-warc` stores text as WARC records instead (the replay search does NOT index those); `final-to-warc` extracts after behaviors. It's an **array** — combine values (e.g. `to-pages,to-warc`) to store text both ways: searchable *and* kept in the WARC. |
| `screenshot` | `[]` | `view`, `thumbnail`, `fullPage`, `fullPageFinal`. |
| `saveStorage` | — | Save local/sessionStorage per page. |
| `warcPrefix` | — | Prefix for generated WARC filenames. |
| `warcInfo` / `warcinfo` | — | Extra fields for the warcinfo record. |
| `title` / `description` | — | Written into WACZ `datapackage.json`. |
| `cwd` | `/crawls` | Crawl working directory. |
| `dryRun` | false | Write only pages+logs (and state), no archive data. Good for testing scope/behaviors. |

## Browser, identity & profile

| Option | Default | Notes |
|---|---|---|
| `headless` | false | Headless vs xvfb. |
| `profile` / `loadProfile` | — | Path/URL to a `tar.gz` browser profile (cookies/session). Helps with logins & sometimes anti-bot (guide §8). |
| `saveProfile` | — | Save the profile back after a successful crawl. |
| `mobileDevice` | — | Emulate a named Puppeteer device. |
| `userAgent` | — | Override the full user-agent. |
| `userAgentSuffix` | — | Append to the default UA (e.g. contact info — polite). |
| `lang` | — | Browser language (ISO 639). |
| `serviceWorker` / `sw` | `disabled` | `disabled`, `disabled-if-profile`, `enabled`. |
| `extraChromeArgs` | `[]` | Extra flags passed to Chrome. |
| `originOverride` | `[]` | Redirect requests from one origin to another. |

## Politeness: robots & sitemaps

| Option | Default | Notes |
|---|---|---|
| `useRobots` / `robots` | false | Fetch & respect per-host `robots.txt` disallows. |
| `robotsAgent` | `Browsertrix/1.x` | Extra agent (besides `*`) to check in robots. |
| `useSitemap` / `sitemap` | — | Discover URLs via `/sitemap.xml` (or a given URL). |
| `sitemapFromDate` / `sitemapToDate` | — | Filter sitemap URLs by ISO date range. |

## Rate limiting & failure handling

Explains the "Page possibly rate limited, retrying" behavior we hit (guide §8).

| Option | Default | Notes |
|---|---|---|
| `rateLimitStatusCodes` | `[403,429,503]` | Responses with these codes are treated as rate-limited/blocked → retried. |
| `rateLimitOnMatch` | `["src=\"/_Incapsula_Resource?:200"]` | `<regex>` or `<regex>:<status>` matched against page text to flag rate limiting. Add your interstitial's text here (e.g. an anti-bot "quick check" marker). |
| `rateLimitTimeout` | `300` | Seconds to track the rate-limited count before resetting. |
| `rateLimitMaxRetries` | `4` | Retries for rate-limited pages before failing them (`-1` = forever). |
| `rateLimitInterruptCount` | `-1` | If >0, abort the whole crawl after this many rate-limited pages. |
| `maxPageRetries` / `retries` | `2` | Retries for a page that fails to load. |
| `failOnFailedSeed` | false | Exit 1 if any seed fails. |
| `failOnInvalidStatus` | false | Treat 4xx/5xx as failures. |
| `failOnFailedLimit` | `0` | Save state & exit if failed pages exceed this. |

## Dedupe

| Option | Default | Notes |
|---|---|---|
| `dedupePagesMinDepth` | `-1` | Min depth at which duplicate pages may be skipped (`-1` = never). |
| `dedupeConcurrent` | false | Commit deduped URLs immediately (enables cross-crawl dedupe; risk on cancel). |
| `redisDedupeUrl` | — | Remote redis for the dedupe index. |

## State & resume

| Option | Default | Notes |
|---|---|---|
| `saveState` | `partial` | `never`, `partial` (on interrupt), `always`. |
| `saveStateInterval` | `300` | With `always`, also save every N seconds. |
| `saveStateHistory` | `5` | How many save-states to keep. |
| `overwrite` | false | Delete the collection dir before starting. |
| `waitOnDone` | false | Wait for a signal instead of exiting when done. |
| `restartsOnError` | false | Assume restart on interrupt; skip post-crawl processing. |
| `crawlId` / `id` | host+collection | User-provided crawl ID (or `CRAWL_ID` env). |

## Logging & observability

| Option | Default | Notes |
|---|---|---|
| `logging` | `["stats"]` | Add `jserrors`, `debug`. Add `behaviors`/`behaviors-debug` via contexts. |
| `logLevel` | all but debug | `debug`, `info`, `warn`, `error`, `interrupt`, `fatal`. |
| `context` / `logContext` | — | Restrict to contexts. Useful: `behavior`, `behaviorScript`, `behaviorScriptCustom`, `links`, `scope`, `pageStatus`, `fetch`, `crawlStatus`. |
| `logExcludeContext` | `["recorderNetwork","jsError","screencast"]` | Contexts to drop. |
| `statsFilename` | — | Write JSON stats to this file. |
| `logErrorsToRedis` / `logBehaviorsToRedis` / `writePagesToRedis` | false | Ship logs/pages to redis. |
| `healthCheckPort` | `0` | Serve a healthcheck. |
| `screencastPort` | `0` | Serve the live screencast on this port (e.g. 9037). |
| `screencastRedis` | false | Screencast via redis pubsub. |

## Proxy & distributed

| Option | Default | Notes |
|---|---|---|
| `proxyServer` | — | Proxy URL (takes precedence over env proxy vars). |
| `proxyServerConfig` | — | YAML/JSON mapping multiple proxies per URL regex. |
| `proxyServerPreferSingleProxy` | false | Prefer `proxyServer` when both are set. |
| `sshProxyPrivateKeyFile` / `sshProxyKnownHostsFile` | — | SOCKS5-over-SSH proxy. |
| `redisStoreUrl` | `redis://localhost:6379/0` | Remote redis for shared crawl state. |
| `debugAccessRedis` / `debugAccessBrowser` | — | Expose redis / Chrome CDP (port 9222) for debugging. |

## QA (replay comparison)

| Option | Default | Notes |
|---|---|---|
| `qaSource` | — | WACZ (or multi-WACZ) to QA against. |
| `qaDebugImageDiff` | — | Write `crawl.png`/`replay.png`/`diff.png` where they differ. |

## Misc

| Option | Default | Notes |
|---|---|---|
| `config` | — | Path to a YAML config file (the tidy way to manage options). |
| `reportSkipped` | false | Write `reports/skippedPages.jsonl` for URLs seen but not queued. |
| `driver` | — | Custom crawler driver. |
