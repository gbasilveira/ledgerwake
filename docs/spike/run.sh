#!/bin/bash
# Spike harness (M0). Hook settings live in $SPIKE_DIR/proj/.claude/settings.local.json; remove it afterwards.
# usage: run.sh <name> <receiver-mode|down>
S=${SPIKE_DIR:?set SPIKE_DIR to a scratch directory containing receiver.py and proj/}
name=$1; mode=$2
if [ "$mode" != down ]; then python3 $S/receiver.py 47811 "$mode" $S/$name.jsonl & RP=$!; sleep 1; fi
cd $S/proj; t0=$(date +%s.%N)
timeout 600 claude -p "Read note.txt with the Read tool and reply with its contents only." --allowedTools Read --output-format json < /dev/null > $S/$name.out.json 2>$S/$name.err
rc=$?; t1=$(date +%s.%N)
[ -n "$RP" ] && kill $RP
echo "$name mode=$mode exit=$rc elapsed=$(echo "$t1 - $t0" | bc)s result=$(python3 -c "import json;d=json.load(open('$S/$name.out.json'));print(repr(d.get('result'))[:40], d.get('is_error'), d.get('duration_ms'))" 2>&1)"
[ -f $S/$name.jsonl ] && echo "  received: $(wc -l < $S/$name.jsonl) $(python3 -c "import json;print([json.loads(l)['body']['hook_event_name'] for l in open('$S/$name.jsonl')])")"
head -c 300 $S/$name.err
