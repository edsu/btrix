---
name: login-profile
description: Crawl a site that requires signing in, using a browser login profile — creating one, referencing it from a config, and fixing a logged-in crawl that comes back full of login pages or an expired session. Use when a site is behind a login, or when an authenticated crawl captured the wrong thing.
---

# Crawling a site behind a login

A **login profile** is a tarball of browser state, including session cookies,
captured by a person logging in by hand. `btrix_profile` starts that browser;
the person does the logging in.

**Never type the user's credentials and never ask for a password.** They enter
it in the browser themselves. A profile is a credential, so it is not shared,
not committed, and not copied between machines. The store's `.gitignore` keeps
`profiles/` out of version control.

## Making one

```
btrix_profile https://example.org/login
```

Then tell the user, in these words:

1. Open <http://127.0.0.1:9223>.
2. Log in to the site in that window, completing any two-factor step.
3. Click "Create Profile" on that page to save it.

9223, not 6080. The crawler serves the profile UI — the browser in an iframe,
plus the "Create Profile" button — on 9223. 6080 is the bare VNC websocket
that iframe connects to, and returns an empty reply to a browser, so sending
someone there shows them nothing and hides the only button that finishes the
job.

It lands in the store at `profiles/<name>.tar.gz`. Give the profile the site's
name unless the user wants something else — one profile per site is the usual
shape, and per-account profiles need distinct names.

`btrix_profile` with no url lists what already exists.

## Using one

Add it to the config and crawl as normal:

```yaml
profile: /crawls/profiles/example.org.tar.gz
```

That path is the container's view, which is why it starts `/crawls`, and it is
the same regardless of where the store lives on disk.

## When the browser will not load

- **An empty reply** — check the port. 6080 answers exactly that way; the page
  is on 9223.
- **Nothing at 127.0.0.1:9223** — the image may still be pulling on a first
  run; that is a 2.4GB download. Check again after a minute.
- **Port already in use** — another profile browser, or something else, holds
  9223 or 6080. `btrix_profile` refuses to start a second one; finish or stop
  the first.
- **The page loads but the browser pane is blank or frozen** — the iframe's
  noVNC connection sometimes needs a reload.

## When a logged-in crawl captures login pages anyway

In order of likelihood:

1. **The session expired.** Cookies have a lifetime, often days. A profile made
   last month is probably logged out. Remake it — this is the usual cause.
2. **The profile was never saved.** The browser closed before the on-screen
   save control was used, so the file is absent or stale. `btrix_profile` with
   no url shows when each profile was made.
3. **The config does not reference it**, or references the wrong path. It must
   be the container path, `/crawls/profiles/<name>.tar.gz`.
4. **The site ties the session to more than cookies** — a device check, or an
   IP the crawl does not share. Nothing btrix can do; say so rather than
   retrying.

`btrix_review` is how to tell: a logged-out crawl shows many pages sharing one
title and very little text, exactly like an anti-bot interstitial.

## Before crawling a logged-in site at all

Worth raising once, without labouring it: authenticated content is often
licensed or personal, and a WACZ of it carries whatever the account could see.
Ask what the archive is for and where it will live if the answer is not already
obvious. Do not help crawl an account the user does not have a right to use.
