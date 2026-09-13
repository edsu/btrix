---
name: new-crawl
description: Write or adjust a Browsertrix crawl config — choosing scope, page limits, delays, exclusions, and whether a site needs a custom behavior or a logged-in profile. Use when starting to archive a new site, when a crawl captured too much or too little, or when the user asks what a config should look like.
---

# Writing a crawl config

Configs live at `btrix/config/<name>.yaml` in the store. A minimal one:

```yaml
collection: sulnews
generateWACZ: true
screencastPort: 9037
scopeType: prefix
text: to-pages,to-warc
seeds:
  - url: https://library.stanford.edu/news
```

`assets/config-template.yaml` in the btrix installation is a starting point.
Keep configs minimal — only the keys that are actually needed.

Three decisions cannot be revisited without re-crawling, so settle them first.

## 1. Scope — the decision that matters most

Ask what the user wants archived, and say back what the scope will include
before crawling. Getting this wrong is the usual cause of both "it only got one
page" and "it's been running for six hours".

| `scopeType` | Captures | Use when |
|---|---|---|
| `page` | the seed URL alone | one article, one document, a first test |
| `prefix` | the seed URL and anything beneath its path | a section: a news area, a collection, one author |
| `host` | everything on that host | a whole small site |
| `domain` | the host and its subdomains | rarely — say what this will pull in first |

`prefix` is the usual answer. Note it is *path*-based: a seed of
`https://example.org/news` includes `/news/2026/...` but not `/about`.

Other scope controls worth reaching for:

- `include` / `exclude` — regexes against the URL. `exclude` is the fix for a
  crawl wandering into calendars, search result pages, print views, or
  `?share=` permutations of the same page.
- `depth` — how many links from the seed. A cheap ceiling when the shape of a
  site is unknown.
- `extraHops` — follow this many links *beyond* the scope, to catch linked
  pages that would otherwise be cut off mid-story.

## 2. `pageLimit` on anything unfamiliar

Set one on a first attempt. A wrong scope with no limit is discovered hours
later and wastes the site's bandwidth as well as the user's time; a wrong scope
with `pageLimit: 25` is discovered in a minute and costs nothing.

`btrix_review` will say when a limit was hit, and that the capture is therefore
truncated rather than complete.

## 3. What cannot be added afterwards

- `generateWACZ: true` — without it there is no WACZ and nothing to replay. Set
  it unless the user specifically wants raw WARCs.
- `text: to-pages,to-warc` — page text, which makes replay full-text
  searchable. It cannot be added to an existing archive. `to-pages` puts text
  in the page index, `to-warc` also keeps it in the WARC records; both is the
  safe choice. This is also what lets `btrix_review` detect interstitials.

## Does the site need a custom behavior?

If content appears only after interaction — "Load More", infinite scroll,
expandable sections, tabs — the crawler will capture the first screenful and
stop. That needs a custom behavior. Read the **behaviors** skill before writing
one; it covers the template, `addLink()` for feeding discovered URLs back into
the crawl queue, and how to tell an interaction problem from a scope problem.

Signs from a finished crawl: far fewer pages than the site obviously has, or
`btrix_review` reporting many pages with almost no text.

## Politeness, and sites that push back

The defaults are deliberately slow: one worker with a delay between pages. This
is a courtesy to the site, and it also avoids tripping bot protection.

- `pageExtraDelay` — seconds to wait after each page. Raise this first when a
  site starts rate-limiting or serving interstitials.
- `workers` — leave at 1 for anything public. More workers means more
  concurrent load on someone else's server.

If a site is actively blocking the crawler, slow down, and consider whether the
archiving is authorised. Do not try to evade bot protection.

## Sites behind a login

`btrix_profile` is not implemented yet. For now a logged-in capture needs a
browser profile made with browsertrix-crawler's own `create-login-profile`
tool, and the config pointed at it with `profile:`. Say so plainly rather than
attempting a workaround; credentials in a config file is not an acceptable
substitute.

## After writing one

Read it back to the user: the scope in plain words, the limit, and what will be
excluded. Then `btrix_run` it. Progress renders itself; do not poll.
