---
name: replay
description: Diagnose ReplayWeb.page replay problems for a btrix archive — "Failed to fetch" when opening a replay link, archived pages showing live content instead, page search finding nothing, or a WACZ that looks corrupt. Use when replay does not work, not to start a replay server (btrix_view does that).
---

# Replaying a WACZ

`btrix_view` serves the archive and returns a `replayweb.page` URL. When replay
misbehaves, the archive is usually fine and one of these is the cause. Check
them in this order.

## "An unexpected error occured: TypeError: Failed to fetch"

The browser refused to let the page on `replayweb.page` fetch `127.0.0.1`.
The archive is almost certainly fine, and saying so first matters — the
message reads like a corrupt capture.

**Say the archive is healthy before troubleshooting.** To show it rather than
assert it, ask the archive for a byte range. A `206 Partial Content` while the
browser fails is the signature: server and archive are both fine, and the
block is entirely browser-side.

Then, cheapest first:

- **Drag the `.wacz` onto <https://replayweb.page>.** It reads from disk, makes
  no local request, and always works. This is the fastest way to unblock
  someone and it is worth offering first.
- **Try another browser.** This varies by browser *and by profile*: the same
  archive on the same server has been seen replaying in a clean Firefox while
  failing in Chrome and in Zen on the same machine, the same minute.
- **Look for an extension blocking LAN access.** uBlock Origin ships a "Block
  Outsider Intrusion into LAN" filter list that blocks exactly this. A private
  or incognito window, where extensions are usually off, is a quick way to
  tell — if it replays there, an extension is the cause.
- **Check the site's Local Network Access permission** in Chrome. Do not
  promise a prompt: on Chrome 153 no prompt was offered at all, so telling the
  user to "click Allow" sends them looking for something that is not there.

Do not conclude the crawl is broken from this message alone. Confirm with a
range request first.

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
