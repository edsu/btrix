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

Requires [Docker or Podman](https://docs.docker.com/get-docker/) and Node 22.19+.

```bash
npm install -g btrix
btrix
```

On first run btrix asks you to connect a language model — type `/login` for a
Claude, ChatGPT or Copilot subscription, or set an API key such as
`ANTHROPIC_API_KEY`. Crawling itself runs locally in a container and needs no
account.

## Providers and models

| | |
|---|---|
| Switch mid-session | `/model` — Ctrl+S in the picker saves it as your startup default |
| Add a provider | `/login` |
| Choose at launch | `btrix --model anthropic/claude-haiku-4-5` |
| See what is available | `btrix --list-models` |

Worth knowing for this tool specifically: **most of a btrix session does not use
the model at all.** Crawl progress, the inventory and the review tables all
render themselves, and the crawl runs in a container regardless. A small cheap
model is fine for running and watching crawls. Where a strong one earns its
keep is narrow — writing a custom behavior for an awkward site, and judging a
review, where deciding whether a repeated title is a block page or a templated
site is the whole question.

btrix is built on the [pi](https://pi.dev) agent harness, which comes along as a
dependency; you do not need to install or know anything about it. If you already
use pi, you can load btrix as an extension instead:

```bash
pi install git:github.com/edsu/btrix
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
| "did that crawl work?" | `btrix_review` — what was actually captured, as candidates to judge |
| "this site needs a login" | `btrix_profile` — starts a browser **you** log into; btrix never sees the password |
| "stop it" | `btrix_stop` — asks the crawler to shut down, so what it captured stays usable |
| "what's taking space?" | `btrix_clean` — reports old run directories; deletes only when you say so |
| "replay stanford-news" | `btrix_view` serves the archive and hands you a ReplayWeb.page link |
| `/btrix [name]` | Repaint the widget, or show the inventory, by hand. No model turn |
| `@` | Completes config, collection, archive and profile names from the store |
| `ctrl+r` / `ctrl+g` | Open the replay link, or the live crawl screencast |

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
never `stalled`.

`btrix_review` takes the same line with a finished crawl. It reads the crawler's
own page index and reports *candidates*:

```
toi: 11 pages captured
page text: median 48 chars, longest 9000 chars — a wide spread like this
  usually means most pages did not capture real content
7 page(s) under 600 chars — judge whether these are real content or a block page:
  48 chars · Just a moment... · https://www.timesofisrael.com/blocked-0/
titles shared by several pages — an interstitial looks like this, but so does
  a templated site:
  6× "Just a moment..." e.g. https://www.timesofisrael.com/blocked-0/
2 hosts, seed host www.timesofisrael.com — check whether the scope was wider
  than intended
```

Counting pages that share a title is arithmetic. Whether "Just a moment..." is
a block page or a legitimate title for *this* site is a judgement, so it stays
with the model — with the numbers attached so it can be made. Stall detection is a heuristic with a timeout, and moving it out of
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

## What owning the interface buys

Two things became free, and most of the interface follows from them.

**Facts can go on screen without spending a turn.** The crawl widget, the
inventory table, the review card and the startup summary all render themselves.
Tool results use pi's `renderResult`, so `btrix_list` draws its own table
instead of handing prose to the model to read back. Progress also goes in the
terminal title, so a multi-hour crawl is legible from a backgrounded tab, and a
native terminal notification fires when one finishes — into the window you are
actually looking at.

**Questions can be asked without spending a turn.** So the most expensive
mistake in this domain gets caught at the only moment it is cheap:

```
Crawl sulnews?

  scope   host — every page on library.stanford.edu
  limit   none

This could run for hours and put real load on the site.
  [Crawl anyway]  [Cancel and add a page limit]
```

Declining blocks the crawl and tells the model *why*, so it can suggest the fix
rather than just reporting a refusal.

## Startup

btrix says three lines before you ask anything, chosen by whether they would
change what you do next:

```
btrix · ./btrix · 39G free · anthropic/claude-opus-5
  2 configs · 1 archive 40M · 1 login profile(s)
  still crawling: sulnews — progress below
  ⚠ 3 failed run(s) holding 2.1G — ask me to clear them
```

The important one is invisible when it passes: whether Docker exists and its
daemon is up. Learning that here beats learning it several minutes into a
2.4GB image pull, and it is the likeliest reason btrix does nothing useful on a
fresh machine.

## Layout

| Path | What |
|---|---|
| `src/inventory.ts` | "What do I have here?" as data: configs, runs, archives, orphans, free space |
| `src/pages.ts` | Summarises the crawler's page index: statuses, hosts, repeated titles, thin pages |
| `src/profile.ts` | Login profiles: listing them, and names that cannot escape the store |
| `src/confirm.ts` | Scope in plain words, and the questions worth asking before a crawl |
| `src/complete.ts` | `@` name completion, sourced from the inventory |
| `src/clean.ts` | Planning and applying cleanup, with guards on what must never be deleted |
| `src/notify.ts` | Terminal notifications, on terminals known to understand them |
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
| `index.ts` | pi wiring only: tools, widget, entry renderer, disk-space gate, first run |
| `bin/btrix.js` | The `btrix` command: starts a session with the extension, prompt and tools preloaded |
| `assets/system-prompt.md` | What btrix is, and how it should behave |
| `src/firstrun.ts` | Detects a missing model credential and says something useful about it |
| `scripts/run.sh` | The `docker run`. Stays shell so you can run a crawl by hand |
| `test/fixtures/*.log` | Real crawl logs, so the parser is tested against what browsertrix actually emits |
| `skills/behaviors/` | Writing and debugging custom crawl behaviors — carried over unchanged |
| `skills/replay/` | Diagnosing replay failures: Chrome's local-network prompt, service workers, search |
| `skills/new-crawl/` | Choosing scope, limits and delays; when a site needs a behavior. Carries the config template |
| `skills/login-profile/` | Authenticated crawls: making a profile, and why a logged-in crawl captured login pages |

Container invocation stays in shell on purpose: its whole job is picking an
engine and assembling flags, and a rewrite would only cost you a
copy-pasteable command. Parsing and rendering are in TypeScript, where they
earn it.

## Develop

```bash
npm install
npm test          # 171 tests, no container or model needed
npm run btrix     # run it here; the store lands in ./btrix (gitignored)
npm link          # put `btrix` on your PATH, running this working tree
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
run` needs a `package.json` in the cwd or an ancestor. For a scratch crawl
directory, either `npm link` once and then run `btrix`, or use the `pi -e` form
above.

Then ask it to crawl `example`, and check the things that are the whole point:

- the widget repaints while the transcript shows **no new turns**;
- `/session` token count doesn't grow while the crawl runs;
- Ctrl+C during startup stops the container (`docker ps` comes back empty);
- quitting pi leaves the crawl running, and reopening re-attaches the widget;
- completion produces **one** model turn, plus a summary card;
- the WACZ ends up in `btrix/out/` with its `.btrix.json` sidecar;
- `btrix_view` serves it and ReplayWeb.page replays it through the link.

## Credentials

btrix never handles a password. `btrix_profile` starts a browser served over
noVNC; you log in there yourself, and the resulting profile — a tarball of
browser state including session cookies — is saved into the store. It is a
credential, so `profiles/` is mode 0700, is in the store's own `.gitignore`,
and is mounted **read-only** into a crawl. A url containing credentials is
refused rather than passed to a container command line where `docker ps` would
show it.

## Status

Eight tools: `run`, `stop`, `status`, `list`, `view`, `review`, `profile` and
`clean`, over a self-contained store, installable as a standalone command. No Python: replay
serving is in-process Node, and `node src/serve.ts <dir> [port]` covers serving
a WACZ from outside the store by hand.

Writing configs stays a conversation rather than a tool — scope is the decision
that most affects what you get — with the detail and a template in the
`new-crawl` skill.

One pi-ism remains deliberately visible: signing in is `/login`, because it is a
built-in command, extension commands that collide with a built-in name are
filtered out, and there is no API for triggering it. Everything else — the
prompt, the tools, the frame — is btrix.

## License

MIT
