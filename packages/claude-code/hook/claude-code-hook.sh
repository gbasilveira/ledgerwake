#!/bin/sh
# Ledgerwake capture hook for Claude Code (spool format claude-code/0).
#
# Reads the hook payload on stdin and stores it as one file in the spool:
#   line 1: {"spool":"claude-code/0","received_at":<ms>,"host":"…","lw_item":"…"|null}
#   rest:   the hook payload, unchanged
# The file is written under spool/tmp and renamed into spool/new, so a reader
# never sees a partial event and concurrent hooks never interleave.
#
# It must never block or fail the agent (SPEC §6.1): no network, no output on
# stdout, every error ignored, exit status always 0.

capture() {
  umask 077
  home="${LW_HOME:-}"
  if [ -z "$home" ] && [ -n "${HOME:-}" ]; then home="$HOME/.ledgerwake"; fi
  [ -n "$home" ] || return 0
  spool="$home/spool/claude-code"
  mkdir -p "$spool/tmp" "$spool/new" || return 0
  ms="$(date +%s%3N)"
  case "$ms" in *N) ms="$(date +%s)000" ;; esac
  tmp="$(mktemp "$spool/tmp/$ms-$$-XXXXXX")" || return 0
  esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }
  if [ -n "${LW_ITEM:-}" ]; then item="\"$(esc "$LW_ITEM")\""; else item=null; fi
  printf '{"spool":"claude-code/0","received_at":%s,"host":"%s","lw_item":%s}\n' \
    "$ms" "$(esc "$(uname -n)")" "$item" > "$tmp" || return 0
  cat >> "$tmp" || return 0
  mv "$tmp" "$spool/new/${tmp##*/}.json"
}

capture >/dev/null 2>&1
# Whatever happened above, read what is left of the payload, so the process writing it to us never
# sees a broken pipe: failing the agent's hook runner is exactly what this script must not do.
cat >/dev/null 2>&1
exit 0
