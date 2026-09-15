#!/bin/bash
# usage: vendor-replay.sh [version]
#        vendor-replay.sh --verify
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

here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/vendor/replaywebpage"

# Digests are recorded in SPDX/CycloneDX shape -- algorithm named, body lower
# hex -- because that is what a bill of materials consumes. Not `sha256-<hex>`,
# which wears the SRI prefix over an SBOM body: SRI wants base64, so anyone
# pasting one into an integrity attribute got a silent failure.
# shasum is a Perl script and is not guaranteed on a Linux box; sha256sum is
# the GNU one and is not on macOS. btrix declares both platforms, so try both.
digest() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d" " -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d" " -f1
  else
    echo "need shasum or sha256sum" >&2
    exit 1
  fi
}

# Re-hash what is on disk against what was recorded. Without this the digests
# are decorative: the script hashes the files it just copied, so provenance.json
# agrees with vendor/ by construction -- including after a bad copy, a hand
# edit, or a compromised download.
if [ "${1:-}" = "--verify" ]; then
  manifest="$out/provenance.json"
  [ -f "$manifest" ] || { echo "no $manifest" >&2; exit 1; }
  status=0
  while IFS=$'\t' read -r rel want; do
    [ -n "$rel" ] || continue
    if [ ! -f "$out/$rel" ]; then
      echo "MISSING  $rel" >&2; status=1; continue
    fi
    got="$(digest "$out/$rel")"
    if [ "$got" = "$want" ]; then
      echo "ok       $rel"
    else
      echo "CHANGED  $rel" >&2
      echo "  recorded $want" >&2
      echo "  on disk  $got" >&2
      status=1
    fi
  done < <(python3 -c '
import json, sys
m = json.load(open(sys.argv[1]))
for rel, meta in m["files"].items():
    print(rel + "\t" + meta["checksumValue"])
' "$manifest")
  exit "$status"
fi

version="${1:-2.5.3}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "fetching replaywebpage@$version"
(cd "$work" && npm pack "replaywebpage@$version")

# Globbed into an array and counted, not through `echo`: zero matches would
# have left the literal pattern as the filename and two -- a leftover from an
# interrupted run -- would have left both, either way failing later at `tar`
# with a confusing message instead of naming the real problem.
tarballs=("$work"/replaywebpage-*.tgz)
if [ "${#tarballs[@]}" -ne 1 ] || [ ! -f "${tarballs[0]}" ]; then
  echo "expected exactly one tarball in $work, found ${#tarballs[@]}" >&2
  exit 1
fi
tar xzf "${tarballs[0]}" -C "$work"

# Cleared first, so an upstream rename cannot leave the previous version's
# files behind in vendor/ -- still served, and still hashed as if current.
rm -rf "$out"
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
  echo "  \"sourceRepository\": \"https://github.com/webrecorder/replayweb.page\","
  echo "  \"vendoredBy\": \"scripts/vendor-replay.sh\","
  echo "  \"verifyWith\": \"scripts/vendor-replay.sh --verify\","
  echo "  \"files\": {"
  echo "    \"ui.js\": {"
  echo "      \"algorithm\": \"SHA256\","
  echo "      \"checksumValue\": \"$(digest "$out/ui.js")\""
  echo "    },"
  echo "    \"replay/sw.js\": {"
  echo "      \"algorithm\": \"SHA256\","
  echo "      \"checksumValue\": \"$(digest "$out/replay/sw.js")\""
  echo "    }"
  echo "  }"
  echo "}"
} > "$out/provenance.json"

echo "vendored into vendor/replaywebpage:"
ls -l "$out/ui.js" "$out/replay/sw.js" | awk '{printf "  %8d  %s\n", $5, $9}'
echo "  $(wc -c < "$out/provenance.json") bytes of provenance"
