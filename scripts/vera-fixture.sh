#!/usr/bin/env bash
# Usage: scripts/vera-fixture.sh <path-to-vera-repository> [commit]
# Creates fixtures/vera/: a read-only copy of VERA's tracked docs/ and its format-contract
# checker at one commit. Only reads the VERA repository (git archive); never writes to it.
# fixtures/ is git-ignored. Never point this at a repository holding client data (RACL).
set -euo pipefail
src="${1:?path to the VERA repository}"
commit="${2:-HEAD}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/fixtures/vera"
git_ro() { git -c safe.directory="$src" -C "$src" "$@"; }
sha="$(git_ro rev-parse --verify "$commit^{commit}")"
if [ -d "$dest" ]; then chmod -R u+w "$dest"; rm -rf "$dest"; fi
mkdir -p "$dest"
git_ro archive "$sha" docs scripts/check-format-contract.sh | tar -x -C "$dest"
echo "$sha" > "$dest/COMMIT"
chmod -R a-w "$dest"
echo "fixtures/vera at $sha: $(find "$dest/docs" -type f | wc -l) files (read-only)"
