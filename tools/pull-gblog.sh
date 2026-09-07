#!/bin/bash
# ============================================================
# gblog 자동 발행 풀러 v2 — 하루 발행 수량 조절
#   - guides/queue/*.json 을 하나씩, 하루 DAILY_MAX 개까지만 발행
#   - 발행 간격 MIN_GAP_MS 이상 (뉴스 자동발행 등 다른 글과 간격 유지)
#   - 완료 파일은 해시로 기록 (중복 발행 방지)
# ============================================================
PROJ="$HOME/g-blogger-auto-publish"
QUEUE_URL="https://raw.githubusercontent.com/neogjr0/gblog-content-/main/guides/queue"
DAILY_MAX=2          # 하루 최대 지식형 글 수
MIN_GAP=10800        # 발행 최소 간격(초) = 3시간
QUIET_AFTER=23       # 23시 이후엔 다음날로
STATE="$HOME/.gblog-state.json"
DONE="$HOME/.gblog-done.txt"
LOCKWAIT=20

cd "$PROJ" || exit 1

# 뉴스 자동발행 락 대기
for i in $(seq 1 20); do
  if [ ! -d "$PROJ/.blogger-session-lock" ]; then break; fi
  sleep 15
done

# 오늘 상태 로드
TODAY=$(date +%Y-%m-%d)
HOUR=$(date +%H)
if [ -f "$STATE" ]; then
  CNT=$(python3 -c "import json;print(json.load(open('$STATE')).get('count',0))" 2>/dev/null)
  STAMP=$(python3 -c "import json;print(json.load(open('$STATE')).get('lastTs',0))" 2>/dev/null)
  SDAY=$(python3 -c "import json;print(json.load(open('$STATE')).get('date',''))" 2>/dev/null)
else
  CNT=0; STAMP=0; SDAY=""
fi
if [ "$SDAY" != "$TODAY" ]; then CNT=0; STAMP=0; fi

# 하루 한도 도달 → 종료
if [ "$CNT" -ge "$DAILY_MAX" ]; then exit 0; fi
# 심야 시간 → 다음날로
if [ "${HOUR#0}" -ge "$QUIET_AFTER" ]; then exit 0; fi
# 최소 간격 안 지남 → 종료
NOW=$(date +%s)
DIFF=$((NOW - STAMP))
if [ "$STAMP" -gt 0 ] && [ "$DIFF" -lt "$MIN_GAP" ]; then exit 0; fi

# queue 목록 갱신 (원격에서 파일명 받아오기 — 간단히 로컬 캐시 사용)
mkdir -p "$HOME/.gblog-queue"
cd "$HOME/.gblog-queue" || exit 1
# GitHub API로 queue 파일 목록 조회
LIST=$(curl -sf --max-time 30 "https://api.github.com/repos/neogjr0/gblog-content-/contents/guides/queue" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for f in sorted(d, key=lambda x:x['name']): print(f['name'])
except Exception: pass
")

for fname in $LIST; do
  case "$fname" in
    *.json) ;;
    *) continue ;;
  esac
  # 이미 발행한 파일인지 확인 (다운로드URL 기반 해시)
  if grep -q "^$fname$" "$DONE" 2>/dev/null; then continue; fi
  # 파일 다운로드
  curl -sf --max-time 30 "$QUEUE_URL/$fname" -o "$fname" || continue
  if [ ! -s "$fname" ]; then continue; fi
  # 발행 실행 (1건)
  cp "$fname" "$PROJ/posts.json"
  node publish.js
  RC=$?
  # 성공 시 기록 (실패해도 재시도 방지 위해 실패 마커는 두지 않음 → 다음 틱 재시도)
  if [ $RC -eq 0 ]; then
    echo "$fname" >> "$DONE"
    python3 -c "
import json
json.dump({'date':'$TODAY','count':$((CNT+1)),'lastTs':$(date +%s)}, open('$STATE','w'))
"
    echo "[$(date)] 발행 완료: $fname (오늘 $((CNT+1))/$DAILY_MAX)"
  else
    echo "[$(date)] 발행 실패(다음 틱 재시도): $fname"
  fi
  exit 0
done

exit 0
