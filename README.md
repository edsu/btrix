# btrix

Make high-fidelity web archives with [Browsertrix
Crawler](https://github.com/webrecorder/browsertrix-crawler), by chatting with
your favorite LLM, and describing what you want archived. Crawls run locally in
a container and produce WACZ files you can replay in
[ReplayWeb.page](https://replayweb.page).

## Install

Requires [Docker or Podman](https://docs.docker.com/get-docker/) and Node 22.19+.

```bash
npm install -g btrix
btrix
```

On first run btrix asks you to connect a language model: type `/login` for a
Claude, ChatGPT or Copilot subscription, or set an API key such as
`ANTHROPIC_API_KEY`. Crawling itself needs no account.

btrix is built on the [pi](https://pi.dev) agent harness, which comes along as a
dependency. If you already use pi, load btrix as an extension instead with
`pi install git:github.com/edsu/btrix`.

## Use

`cd` to a working directory and run `btrix`. It opens with what is in the store
and what to do next:

```
  ╭──╮  ╭──╮  ╭──╮
  │▒▒│→│▒▒│→│▒▒│        btrix  ·  high-fidelity web archives
  ╰──╯  ╰──╯  ╰──╯      Browsertrix Crawler, driven by conversation
      ╲   │   ╱
      ╭───────╮         ./btrix · 39G free · anthropic/claude-opus-5
      │ .wacz │         3 configs · 2 archives 41M · 1 login profile
      ╰───────╯

  cultprotest              crawling      12/30
  sulnews → stanford-news  done          25/25  40M
  toi                      stopped       18/25

  cultprotest is still crawling — watch the progress below.
```

Then say what you want.

| You say | What happens |
|---|---|
| "archive the news section of library.stanford.edu" | Writes a config, having settled the scope with you first |
| "crawl sulnews" | Starts the crawl in the background; progress appears in the widget |
| "how's it going?" | Reads the crawl's state — though the widget is usually already showing it |
| "stop it" | Asks the crawler to shut down cleanly, keeping what it captured |
| "what do I have?" | Configs, crawls, archives, failed runs, free space |
| "did that crawl work?" | What was actually captured, with anything suspicious flagged |
| "replay stanford-news" | Serves the archive and gives you a ReplayWeb.page link |
| "this site needs a login" | Opens a browser for **you** to log into; btrix never sees the password |
| "why did this site only give me one page?" | Opens a real browser to work out a custom behavior |
| "what's taking up space?" | Reports old working directories, and clears them if you agree |

Keys and commands:

| | |
|---|---|
| `@` | Completes config, collection, archive and profile names |
| `ctrl+r` | Open the replay link for a served archive |
| `ctrl+g` | Open the live crawl screencast |
| `/btrix [name]` | Repaint the progress widget, or show the inventory |
| `/model`, `/login` | Switch model, add a provider |

While a crawl runs, a widget updates once a second, and progress also appears in
the terminal title:

```
btrix │ crawling sulnews · 142/201 · 71% · 3.2 pg/min · 1.2M/min
      archive 880M · profile 300M · 12G free · rate-limited 3 · screencast :9037
      fetching https://library.stanford.edu/news/some-page
```

Crawls are detached, so they outlive the session — quit, come back tomorrow, and
the widget picks the crawl back up. When one finishes you get a notification and
a summary.

## Where things go

Everything lives in one directory beside your work:

```
./
├── btrix/
│   ├── config/sulnews.yaml         your crawl configs
│   ├── out/sulnews.wacz            finished archives
│   ├── out/sulnews.btrix.json      how each was made
│   ├── profiles/                   browser logins
│   ├── runs/                       working files, kept for inspection
│   └── failed/                     runs that produced nothing
└── notes.md, .git/                 your stuff, untouched
```

`btrix --dir /Volumes/archive/sulnews` puts the whole store somewhere else —
useful for a large crawl on an external disk. `$BTRIX_DIR` does the same.

The store writes its own `.gitignore`, so archives and profiles stay out of
version control while `config/` remains yours to commit.

## Credentials

btrix never handles a password. For a site behind a login it opens a browser
over noVNC at `localhost:6080`; you sign in there, and the resulting profile is
saved into the store. Profiles hold session cookies, so they are kept private,
ignored by git, and mounted read-only into a crawl. Sessions expire — if a
logged-in crawl comes back full of login pages, make the profile again.

## Writing a custom behavior

Sites whose content appears only after a click — "Load More", infinite scroll,
expandable sections — need a custom behavior. btrix opens a real Chrome on the
page, which you can watch and click at `localhost:6080`, and evaluates
expressions against it:

```
document.querySelectorAll('.load-more').length   => 1
document.querySelectorAll('article').length      => 20
document.querySelector('.load-more').click()     => clicked
document.querySelectorAll('article').length      => 40
```

That answers what a behavior needs to know: whether the control exists, what it
matches, and how many items a click adds. Put the result in
`btrix/config/behaviors/`, reference it from the config with `customBehaviors`,
and check it with a small crawl.

## Develop

```bash
npm install
npm test          # no container or model needed
npm run check     # tsc --noEmit
npm link          # put `btrix` on your PATH, running this working tree
```

There is no build step; pi loads `.ts` directly. To try it end to end, make a
config with `pageLimit: 3` in a scratch directory and run `btrix` there.

## Status

All the crawl tooling works: writing configs, running, watching, stopping,
listing, reviewing, replaying, login profiles, behavior authoring and cleanup.

Signing in to a model provider is `/login` — pi's own command, and the one place
btrix's vocabulary does not reach.

## License

MIT
