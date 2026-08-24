#!/usr/bin/env bash
# Phase 0 baseline / Phase 6 comparison harness (LOCAL-BRAIN-SPEC section 5 + 11.2).
# Times whole turns through POST /api/device/chat, which is the same brain call the web
# chat makes but without the Google session gate.
#
#   BASE=http://172.21.0.16:3000 DEVICE_TOKEN=... ./test/baseline.sh [runs]
#
# Run it against the Claude brain now and the local brain later; the numbers are comparable
# because the endpoint and the prompt set do not change.
set -uo pipefail

BASE="${BASE:?set BASE, e.g. http://<maverick-ip>:3000}"
TOKEN="${DEVICE_TOKEN:?set DEVICE_TOKEN}"
RUNS="${1:-5}"

# Prompt set. Keep these fixed forever; changing one invalidates the comparison.
declare -a NAMES=(calendar reminder note)
declare -a PROMPTS=(
  "what's on my calendar today"
  "remind me to call the dentist tomorrow at 9"
  "save a note: the boiler filter is 16x25x1"
)

turn() { # $1=prompt $2=conversation_id -> seconds on stdout, reply on fd 3
  local body reply t
  body=$(printf '{"message":%s,"conversation_id":%s}' \
    "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")
  t=$(curl -s -m 180 -o /tmp/.bl_reply -w '%{time_total}' \
        -X POST "$BASE/api/device/chat" \
        -H 'Content-Type: application/json' -H "X-Device-Token: $TOKEN" \
        -d "$body")
  printf '%s' "$t"
}

stats() { # reads seconds on stdin
  python3 -c '
import sys,statistics as st
v=sorted(float(x) for x in sys.stdin.read().split() if x.strip())
if not v: print("no data"); raise SystemExit
print(f"n={len(v)}  min={v[0]:.2f}s  median={st.median(v):.2f}s  max={v[-1]:.2f}s  mean={st.mean(v):.2f}s")'
}

echo "baseline: $RUNS runs per prompt against $BASE"
echo

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"; prompt="${PROMPTS[$i]}"
  echo "## $name  ->  \"$prompt\""
  times=""
  for r in $(seq 1 "$RUNS"); do
    # fresh conversation per run: a resumed session would measure history growth, not the turn
    t=$(turn "$prompt" "baseline-$name-$r")
    printf '  run %d: %ss  %s\n' "$r" "$t" "$(head -c 90 /tmp/.bl_reply)"
    times="$times $t"
  done
  echo -n "  "; printf '%s\n' $times | stats
  echo
done
rm -f /tmp/.bl_reply
