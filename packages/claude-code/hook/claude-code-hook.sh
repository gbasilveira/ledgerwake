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

{
  umask 077
  home="${LW_HOME:-}"
  if [ -z "$home" ] && [ -n "${HOME:-}" ]; then home="$HOME/.ledgerwake"; fi
  if [ -z "$home" ]; then exit 0; fi
  spool="$home/spool/claude-code"
  mkdir -p "$spool/tmp" "$spool/new"
  ms="$(date +%s%3N)"
  case "$ms" in *N) ms="$(date +%s)000" ;; esac
  tmp="$(mktemp "$spool/tmp/$ms-$$-XXXXXX")"
  esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }
  if [ -n "${LW_ITEM:-}" ]; then item="\"$(esc "$LW_ITEM")\""; else item=null; fi
  printf '{"spool":"claude-code/0","received_at":%s,"host":"%s","lw_item":%s}\n' \
    "$ms" "$(esc "$(uname -n)")" "$item" > "$tmp"
  cat >> "$tmp"
  mv "$tmp" "$spool/new/${tmp##*/}.json"
} >/dev/null 2>&1
exit 0
