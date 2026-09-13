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

`cd` into a working directory — crawls read `./config` and write `./collections`
there — and talk to pi:

| You say | What happens |
|---|---|
| "crawl sulnews" | `btrix_run` starts `config/sulnews.yaml` detached, then the widget takes over |
| "how's it going?" | `btrix_status` — but you usually won't need to ask, the widget is already showing it |
| `/btrix [name]` | Repaint the widget by hand. No model turn |

The widget looks like this, repainting once a second:

```
btrix │ crawling mysite · 142/201 · 71% · 3.2 pg/min · 1.2M/min
      archive 880M · profile 300M · 12G free · rate-limited 3 · screencast :9037
      fetching https://example.org/news/some-page
```

It states facts and leaves diagnosis alone: you get `no new page 4m`, never
`stalled`. Stall detection is a heuristic with a timeout, and moving it out of
prose into TypeScript shouldn't launder a guess into certainty. Anything
uncertain is carried by colour, not by adjective.

The crawl is **detached**, so it outlives the session: quit pi, come back
tomorrow, and the widget re-attaches. State lives on disk — the crawler's own
JSON logs plus `docker ps` — so a crawl started in another session or by hand is
picked up too. When one finishes you get a summary card (which never enters the
model's context) and exactly one model turn announcing the result.

## Layout

| Path | What |
|---|---|
| `src/log.ts` | Pure parser for the crawler's JSON log lines. No fs, so it tests against fixtures |
| `src/stats.ts` | Incremental tailer: byte offsets, sample ring buffer, derived rates and states |
| `src/monitor.ts` | Poll loop and completion detection. Knows nothing about pi |
| `src/render.ts` | `CrawlStats` → widget lines, and → a compact line for the model |
| `src/engine.ts` | podman-or-docker, and which containers are crawling what |
| `src/tools.ts` | `btrix_run`, `btrix_status` |
| `index.ts` | pi wiring only: tools, widget, entry renderer, disk-space gate |
| `scripts/run.sh` | The `docker run`. Stays shell so you can run a crawl by hand |
| `skills/behaviors/` | Writing and debugging custom crawl behaviors — carried over unchanged |

Container invocation stays in shell on purpose: its whole job is picking an
engine and assembling flags, and a rewrite would only cost you a
copy-pasteable command. Parsing and rendering are in TypeScript, where they
earn it.

## Develop

```bash
npm install
npm test          # 38 tests, no container or model needed
npm run check     # tsc --noEmit
```

There is no build step: pi loads `.ts` through
[jiti](https://github.com/unjs/jiti).

### Verifying it end to end

The spawn path has no automated test — it would pull a 2.4GB image and start a
real crawl. Do it by hand:

```bash
mkdir -p /tmp/crawltest/config && cd /tmp/crawltest
cat > config/example.yaml <<'EOF'
seeds:
  - url: https://example.com/
scopeType: page
pageLimit: 3
generateWACZ: true
EOF
pi -e ~/Projects/btrix
```

Then ask it to crawl `example`, and check the things that are the whole point:

- the widget repaints while the transcript shows **no new turns**;
- `/session` token count doesn't grow while the crawl runs;
- Ctrl+C during startup stops the container (`docker ps` comes back empty);
- quitting pi leaves the crawl running, and reopening re-attaches the widget;
- completion produces **one** model turn, plus a summary card.

## Status

Milestone 1: `run` and `status`. Not yet ported from the Claude Code plugin:
`list`, `review`, `view`, `profile`, `new`. `skills/behaviors/scripts/waczserve.py`
is still Python, so `python3` is needed for local replay serving.

## License

MIT
