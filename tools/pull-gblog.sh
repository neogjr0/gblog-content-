#!/bin/bash
# gblog 자동 발행 풀러 — GitHub의 guides/posts.json이 바뀌면 자동 발행
PROJ="$HOME/g-blogger-auto-publish"
REPO_RAW="https://raw.githubusercontent.com/neogjr0/gblog-content-/main/guides/posts.json"
cd "$PROJ"
if [ $? -ne 0 ]; then exit 1; fi
curl -sf --max-time 30 "$REPO_RAW" -o /tmp/gblog_incoming.json
if [ $? -ne 0 ]; then exit 0; fi
if [ ! -s /tmp/gblog_incoming.json ]; then exit 0; fi
HASH=$(sha256sum /tmp/gblog_incoming.json | cut -d' ' -f1)
LAST=$(cat ~/.last-gblog-hash 2>/dev/null)
if [ -z "$LAST" ]; then LAST=none; fi
if [ "$HASH" != "$LAST" ]; then
  for i in $(seq 1 20); do
    if [ ! -d "$PROJ/.blogger-session-lock" ]; then break; fi
    sleep 15
  done
  cp /tmp/gblog_incoming.json "$PROJ/posts.json"
  echo "$HASH" > ~/.last-gblog-hash
  node publish.js
fi
