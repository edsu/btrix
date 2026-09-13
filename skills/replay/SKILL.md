---
name: replay
description: Diagnose ReplayWeb.page replay problems for a btrix archive — "Failed to fetch" when opening a replay link, archived pages showing live content instead, page search finding nothing, or a WACZ that looks corrupt. Use when replay does not work, not to start a replay server (btrix_view does that).
---

# Replaying a WACZ

`btrix_view` serves the archive and returns a `replayweb.page` URL. When replay
misbehaves, the archive is usually fine and one of these is the cause. Check
them in this order.

## "An unexpected error occured: TypeError: Failed to fetch"

Almost always the **Local Network Access permission**, not a bad archive.

Chrome 141+ and Edge require a public HTTPS origin like `replayweb.page` to ask
permission before reaching `http://localhost`. Chrome prompts on first load;
if it was dismissed or missed, the fetch fails with exactly that message.

- Tell the user to reload and click **Allow**, or grant it via the icon in the
  address bar.
- To confirm it is the permission rather than the server, request the archive
  from the shell. A `206 Partial Content` there while the browser fails is the
  signature — the server and the archive are both healthy.
- Dragging the `.wacz` file onto <https://replayweb.page> sidesteps the
  permission entirely, because no local network request is made. That is the
  fastest way to unblock someone.

## Replay loads, but pages show *live* content

ReplayWeb.page replays through a service worker. In DevTools →
Application → Service Workers, make sure **"Bypass for network"** is
unchecked; when it is checked, requests go to the live internet instead of the
archive, so the site appears to work while nothing is actually being replayed.

## Page search finds nothing

Full-text search needs the crawl to have written page text. That requires
`text: to-pages` (or `to-pages,to-warc`) in the config. A crawl with
`to-warc` only, or with no `text:` key, replays correctly but is not
searchable — `btrix_view` says so in its result when the config lacks it.

Fixing it means re-crawling with the key added; it cannot be added to an
existing archive.

## There is no archive to replay

Check `btrix_list`. Three different situations look alike:

- **still crawling** — the WACZ only appears at the end, during the
  "Generating WACZ" phase;
- **`generateWACZ` is off** — the crawl produced WARCs and no WACZ. The WARC
  directory is in the store's `out/`, but ReplayWeb.page wants a WACZ, so this
  needs a re-crawl with `generateWACZ: true`;
- **the crawl ended early** — `btrix_status` will say so, and the run is parked
  under the store's `failed/` for inspection.

## The archive really is suspect

If replay works but pages are missing or wrong, the problem is in the crawl
rather than in replay — a site that needed a custom behavior, or pages captured
as an anti-bot interstitial. See the **behaviors** skill for writing and
debugging behaviors, and its debugging playbook for interstitials.
