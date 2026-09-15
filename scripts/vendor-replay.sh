#!/bin/bash
# usage: vendor-replay.sh [version]
#
# Vendors the two files btrix needs to replay an archive without sending the
# browser to replayweb.page: the ReplayWeb.page app bundle and its service
# worker. Run it to update; it rewrites vendor/replaywebpage/ in place and
# records what it took.
#
# Why vendored rather than depended on: `replaywebpage` declares twenty runtime
# dependencies -- electron-updater among them -- and none are needed, because
# ui.js and sw.js are self-contained webpack output with the modules already
# inlined. Depending on the package would pull an Electron tree into a CLI to
# get two files that do not use it.
#
# ReplayWeb.page is AGPL-3.0-or-later. Its LICENSE travels with the bundle.

set -euo pipefail

version="${1:-2.5.3}"
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/vendor/replaywebpage"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "fetching replaywebpage@$version"
(cd "$work" && npm pack "replaywebpage@$version" >/dev/null)
tarball="$(echo "$work"/replaywebpage-*.tgz)"
tar xzf "$tarball" -C "$work"

mkdir -p "$out/replay"
cp "$work/package/ui.js" "$out/ui.js"
# sw.js has to sit under replay/: the element asks for ./replay/sw.js, which is
# the default replayBase, and the worker's scope has to cover the path the
# archived pages are served from. Beside ui.js it is simply not found.
cp "$work/package/sw.js" "$out/replay/sw.js"
cp "$work/package/LICENSE" "$out/LICENSE"

# Provenance, so a stale bundle is visible rather than mysterious.
{
  echo "{"
  echo "  \"name\": \"replaywebpage\","
  echo "  \"version\": \"$version\","
  echo "  \"license\": \"AGPL-3.0-or-later\","
  echo "  \"source\": \"https://www.npmjs.com/package/replaywebpage/v/$version\","
  echo "  \"vendoredBy\": \"scripts/vendor-replay.sh\","
  echo "  \"files\": {"
  echo "    \"ui.js\": \"sha256-$(shasum -a 256 "$out/ui.js" | cut -d' ' -f1)\","
  echo "    \"replay/sw.js\": \"sha256-$(shasum -a 256 "$out/replay/sw.js" | cut -d' ' -f1)\""
  echo "  }"
  echo "}"
} > "$out/provenance.json"

echo "vendored into vendor/replaywebpage:"
ls -l "$out/ui.js" "$out/replay/sw.js" | awk '{printf "  %8d  %s\n", $5, $9}'
echo "  $(wc -c < "$out/provenance.json") bytes of provenance"
