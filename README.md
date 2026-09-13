# btrix

Drive [Browsertrix Crawler](https://github.com/webrecorder/browsertrix-crawler)
from [pi](https://pi.dev): typed crawl tools plus a live progress widget that
costs nothing to watch.

## Why

This started as a Claude Code plugin
([browsertrix-crawler-claude](https://github.com/edsu/browsertrix-crawler-claude)),
where two things were structural rather than fixable:

**The model was the renderer.** Status was a shell script that had to print
everything from one command, because every extra `grep`/`du`/`df` was a
permission prompt — and status gets polled on a loop. So structured data was
flattened into text for a model to read back, one turn per refresh. The
"interpretation" the skills asked for was mostly deterministic rules written as
prose: *"`done*` means no WACZ, so replay won't work"*, *"flag low free space"*,
*"point the user at the obvious next step"*.

**There was no history.** The script printed a snapshot, so the rules that
mattered most — *"a flat page count with growing bytes means a large asset is
downloading, not a stall"* — asked the model to diff against a reading from two
minutes ago that might no longer be in context. Every genuinely useful number
about a crawl is a derivative: pages/min, time since the last completed page,
**time until the disk fills**. None of them are expressible in a snapshot.

btrix keeps a byte offset and a ring buffer of samples, so those numbers are
computed, rendered continuously in the TUI for free, and the model is left the
work it is actually good at: writing configs, authoring behaviors, and
explaining what went wrong.

## Install

Requires [Docker or Podman](https://docs.docker.com/get-docker/) and pi.

```bash
npm i -g @earendil-works/pi-coding-agent
pi install git:github.com/edsu/btrix
```

Or, from a clone:

```bash
pi -e ~/Projects/btrix
```

## Use

`cd` into a working directory and talk to pi. Everything btrix touches lives in
one directory beside your work:

```
./                                  your project dir
├── btrix/                          one directory; tar it and go
│   ├── config/sulnews.yaml         authored configs (versionable)
│   ├── runs/sulnews-20260913T1137/ mounted at /crawls: WARCs, logs, CDX, state
│   ├── out/sulnews.wacz            the deliverable, moved here on success
│   ├── out/sulnews.btrix.json      provenance sidecar
│   ├── profiles/                   browser logins, mode 0700
│   └── failed/                     runs that produced nothing, kept to inspect
└── notes.md, Makefile, .git/       your stuff, untouched
```

Point the store somewhere else with `--dir` or `$BTRIX_DIR` — that names the
store root itself, so `btrix --dir /Volumes/archive/sulnews` puts the whole
thing on that volume. Because work and output share a tree, promoting a
finished WACZ is always a same-volume rename, never a copy: there is no
cross-device path to get wrong, and no way to fill your home partition on a
crawl you meant to land elsewhere.

The store writes its own `.gitignore`, so bulk output and credential-bearing
profiles stay out of version control while `config/` remains yours to commit.

| You say | What happens |
|---|---|
| "crawl sulnews" | `btrix_run` starts `btrix/config/sulnews.yaml` detached, then the widget takes over |
| "how's it going?" | `btrix_status` — but you usually won't need to ask, the widget is already showing it |
| "what do I have?" | `btrix_list` — configs, runs and their state, archives, failed runs, free space |
| "replay stanford-news" | `btrix_view` serves the archive and hands you a ReplayWeb.page link |
| `/btrix [name]` | Repaint the widget, or show the inventory, by hand. No model turn |

The widget looks like this, repainting once a second:

```
btrix │ crawling mysite · 142/201 · 71% · 3.2 pg/min · 1.2M/min
      archive 880M · profile 300M · 12G free · rate-limited 3 · screencast :9037
      fetching https://example.org/news/some-page
```

The inventory is a table, not a paragraph:

```
configs
  cultprotest        cultprotest.me/            page · limit 3
  sulnews            library.stanford.edu/news  collection stanford-news · prefix · limit 25 · behavior load-more.js
  toi                timesofisrael.com/         page · no wacz

runs
  sulnews            stopped       18/25     ended early — btrix_status for why

archives
  out/cultprotest.wacz      3.0M    3/3 pages · truncated at pageLimit 3 · crawler 1.14.3
  out/stanford-news.wacz    40M     25/25 pages · crawler 1.14.3

  1 failed run(s) 4.0K · 39G free
```

Every "interpret rather than restate" instruction the old plugin gave the model
is a rule here instead: `state → next command` is a switch, "an archive with no
matching config" is a set difference, "a leftover container" is a container
lookup, and low free space is a threshold. A config that will produce no WACZ
says so *before* you crawl with it rather than after.

Both renderers state facts and leave diagnosis alone: you get `no new page 4m`,
never `stalled`. Stall detection is a heuristic with a timeout, and moving it out of
prose into TypeScript shouldn't launder a guess into certainty. Anything
uncertain is carried by colour, not by adjective.

The crawl is **detached**, so it outlives the session: quit pi, come back
tomorrow, and the widget re-attaches. State lives on disk — the crawler's own
JSON logs plus `docker ps` — so a crawl started in another session or by hand is
picked up too. A crawl btrix did not start is left exactly where it is; only its
own runs get promoted.

When one finishes, the WACZ moves into `btrix/out/` with a sidecar recording
the config that produced it, the crawler version, page counts and any warnings
— so the archive stays self-describing after someone emails it onwards. You get
a summary card (which never enters the model's context) and exactly one model
turn announcing the result.

## Layout

| Path | What |
|---|---|
| `src/inventory.ts` | "What do I have here?" as data: configs, runs, archives, orphans, free space |
| `src/serve.ts` | Local replay server: HTTP ranges (including the suffix form) and CORS, in-process |
| `src/config.ts` | The few config keys btrix needs, read line-wise rather than via a YAML dependency |
| `src/store.ts` | Where files live: `--dir` / `$BTRIX_DIR` / `./btrix`, run directories, the `collection:` key |
| `src/finish.ts` | Promotes a finished run into `out/`, or parks it in `failed/` |
| `src/log.ts` | Pure parser for the crawler's JSON log lines. No fs, so it tests against fixtures |
| `src/stats.ts` | Incremental tailer: byte offsets, sample ring buffer, derived rates and states |
| `src/monitor.ts` | Poll loop and completion detection. Knows nothing about pi |
| `src/render.ts` | `CrawlStats` → widget lines, and → a compact line for the model |
| `src/engine.ts` | podman-or-docker, and which containers are crawling what |
| `src/tools.ts` | `btrix_run`, `btrix_status` |
| `index.ts` | pi wiring only: tools, widget, entry renderer, disk-space gate |
| `scripts/run.sh` | The `docker run`. Stays shell so you can run a crawl by hand |
| `test/fixtures/*.log` | Real crawl logs, so the parser is tested against what browsertrix actually emits |
| `skills/behaviors/` | Writing and debugging custom crawl behaviors — carried over unchanged |
| `skills/replay/` | Diagnosing replay failures: Chrome's local-network prompt, service workers, search |

Container invocation stays in shell on purpose: its whole job is picking an
engine and assembling flags, and a rewrite would only cost you a
copy-pasteable command. Parsing and rendering are in TypeScript, where they
earn it.

## Develop

```bash
npm install
npm test          # 94 tests, no container or model needed
npm run btrix     # run it here; the store lands in ./btrix (gitignored)
npm run check     # tsc --noEmit
```

There is no build step: pi loads `.ts` through
[jiti](https://github.com/unjs/jiti).

### Verifying it end to end

The spawn path has no automated test — it would pull a 2.4GB image and start a
real crawl. Do it by hand:

```bash
mkdir -p /tmp/crawltest/btrix/config && cd /tmp/crawltest
cat > btrix/config/example.yaml <<'EOF'
seeds:
  - url: https://example.com/
scopeType: page
pageLimit: 3
generateWACZ: true
EOF
pi -e ~/Projects/btrix
```

`npm run btrix` does the same from inside the repo, but only from there — `npm
run` needs a `package.json` in the cwd or an ancestor, so a scratch crawl
directory needs the `pi -e` form.

Then ask it to crawl `example`, and check the things that are the whole point:

- the widget repaints while the transcript shows **no new turns**;
- `/session` token count doesn't grow while the crawl runs;
- Ctrl+C during startup stops the container (`docker ps` comes back empty);
- quitting pi leaves the crawl running, and reopening re-attaches the widget;
- completion produces **one** model turn, plus a summary card;
- the WACZ ends up in `btrix/out/` with its `.btrix.json` sidecar;
- `btrix_view` serves it and ReplayWeb.page replays it through the link.

## Status

`run`, `status`, `list` and `view`, over a self-contained store. Not yet ported
from the Claude Code plugin: `review`, `profile`, `new`. Replay serving is now
in-process Node, so `python3` is only needed for the behaviors skill's own
`waczserve.py` when debugging behaviors by hand.

## License

MIT
