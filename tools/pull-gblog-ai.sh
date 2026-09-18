#!/bin/bash
# ============================================================
# gblog AI 블로그(ai-workflow-lab) 자동 발행 풀러 v1
#   - 별도 큐: ai/queue/*.json  /  blogId=1972526406298916789
#   - 상태 파일 분리(.gblog-ai-*) → 기존 건강 블로그와 간섭 없음
#   - 하루 2개·성공 간격 3시간·심야(23시 이후) 제외
#   - 성공 판별: history.json(error 유무) — 실패해도 publish.js는 exit 0
#   - 실패 시 20분 후 재시도, 5회 실패 시 failed 등록
# ============================================================
PROJ="$HOME/g-blogger-auto-publish"
REPO="neogjr0/gblog-content-"
BLOG_ID="1972526406298916789"
QUEUE_URL="https://api.github.com/repos/$REPO/contents/ai/queue"
TOOLS_URL="https://api.github.com/repos/$REPO/contents/tools"
DAILY_MAX=2
MIN_GAP=10800          # 성공 간격 3시간
RETRY_GAP=1200         # 실패 재시도 20분
QUIET_AFTER=23
MAX_ATTEMPTS=5
STATE="$HOME/.gblog-ai-state.json"
DONE="$HOME/.gblog-ai-done.txt"
FAILED="$HOME/.gblog-ai-failed.txt"
HIST="$PROJ/history.json"
CHECK="$HOME/.gblog-check.js"
QDIR="$HOME/.gblog-ai-queue"
POSTS="posts-ai.json"

# 로그 자체 기록 (크론 리다이렉션 불필요 → 등록 명령 짧게)
exec >> "$HOME/pull-gblog-ai.log" 2>&1
echo "===== $(date) 실행 ====="

# ── node 자동 탐지 ────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  export PATH="$(dirname "$(command -v node)"):$PATH"
elif [ -d "$HOME/.nvm/versions/node" ]; then
  NV=$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)
  if [ -n "$NV" ] && [ -x "$HOME/.nvm/versions/node/$NV/bin/node" ]; then
    export PATH="$HOME/.nvm/versions/node/$NV/bin:$PATH"
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[$(date)] node를 찾을 수 없음 — 중단"
  exit 0
fi

# ── 헬퍼 항상 최신으로 ────────────────────────────────────────
curl -sf --max-time 20 -H "Accept: application/vnd.github.raw" "$TOOLS_URL/gblog-check.js" -o "$CHECK" || true

# 세션 락 대기
for i in $(seq 1 20); do
  if [ ! -d "$PROJ/.blogger-session-lock" ]; then break; fi
  sleep 15
done

TODAY=$(date +%Y-%m-%d)
HOUR=$(date +%H)
NOW=$(date +%s)

CNT=0; LASTOK=0; LASTATT=0; SDAY=""
if [ -f "$STATE" ]; then
  SDAY=$(node -e "try{console.log(require('$STATE').date||'')}catch(e){console.log('')}" 2>/dev/null)
  CNT=$(node -e "try{console.log(require('$STATE').count||0)}catch(e){console.log('0')}" 2>/dev/null)
  LASTOK=$(node -e "try{console.log(require('$STATE').lastOkTs||0)}catch(e){console.log('0')}" 2>/dev/null)
  LASTATT=$(node -e "try{console.log(require('$STATE').lastAttemptTs||0)}catch(e){console.log('0')}" 2>/dev/null)
fi
[ -z "$CNT" ] && CNT=0
[ -z "$LASTOK" ] && LASTOK=0
[ -z "$LASTATT" ] && LASTATT=0
if [ "$SDAY" != "$TODAY" ]; then CNT=0; LASTOK=0; LASTATT=0; fi

if [ "${HOUR#0}" -ge "$QUIET_AFTER" ]; then exit 0; fi
if [ "$CNT" -ge "$DAILY_MAX" ]; then exit 0; fi

LIST=$(curl -sf --max-time 30 "https://api.github.com/repos/$REPO/contents/ai/queue" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{ const d=JSON.parse(s); d.filter(f=>f.name.endsWith('.json')).sort((a,b)=>a.name<b.name?-1:1).forEach(f=>console.log(f.name)) }catch(e){}
})")

mkdir -p "$QDIR"
cd "$QDIR" || exit 1

for fname in $LIST; do
  grep -q "^$fname$" "$DONE" 2>/dev/null && continue
  grep -q "^$fname$" "$FAILED" 2>/dev/null && continue

  curl -sf --max-time 30 -H "Accept: application/vnd.github.raw" "$QUEUE_URL/$fname" -o "$fname" || continue
  [ -s "$fname" ] || continue

  TITLE=$(node -e "try{const p=require('./$fname');console.log(p[0].headline||p[0].title||'')}catch(e){console.log('')}" 2>/dev/null)
  [ -z "$TITLE" ] && continue

  OUT=$(node "$CHECK" "$HIST" "$TITLE" 2>/dev/null)
  OKCNT=$(echo "$OUT" | cut -d' ' -f1); ERRCNT=$(echo "$OUT" | cut -d' ' -f2)
  [ -z "$OKCNT" ] && OKCNT=0
  [ -z "$ERRCNT" ] && ERRCNT=0

  if [ "$OKCNT" -gt 0 ]; then
    echo "$fname" >> "$DONE"
    echo "[$(date)] 이미 발행됨 → 건너뜀: $fname"
    continue
  fi

  if [ "$ERRCNT" -gt 0 ]; then GAP=$RETRY_GAP; else GAP=$MIN_GAP; fi
  DIFF=$((NOW - LASTATT))
  if [ "$DIFF" -lt "$GAP" ]; then exit 0; fi

  cp "$fname" "$PROJ/$POSTS"
  echo "[$(date)] AI블로그 발행 시도 ($((ERRCNT + 1))회차): $fname"
  (cd "$PROJ" && BLOGGER_BLOG_ID="$BLOG_ID" node publish.js --posts="$POSTS")
  RC=$?

  OUT2=$(node "$CHECK" "$HIST" "$TITLE" 2>/dev/null)
  OKNOW=$(echo "$OUT2" | cut -d' ' -f1)
  [ -z "$OKNOW" ] && OKNOW=0
  NOW2=$(date +%s)

  if [ "$OKNOW" -gt 0 ]; then
    echo "$fname" >> "$DONE"
    CNT=$((CNT + 1))
    node -e "require('fs').writeFileSync('$STATE', JSON.stringify({date:'$TODAY',count:$CNT,lastOkTs:$NOW2,lastAttemptTs:$NOW2}))"
    echo "[$(date)] AI블로그 발행 성공: $fname (오늘 $CNT/$DAILY_MAX)"
  else
    node -e "require('fs').writeFileSync('$STATE', JSON.stringify({date:'$TODAY',count:$CNT,lastOkTs:$LASTOK,lastAttemptTs:$NOW2}))"
    echo "[$(date)] AI블로그 발행 실패(exit=$RC) — 20분 후 재시도: $fname"
    if [ "$ERRCNT" -ge $((MAX_ATTEMPTS - 1)) ]; then
      echo "$fname" >> "$FAILED"
      echo "[$(date)] 5회 실패 — 중단 처리: $fname"
    fi
  fi
  exit 0
done
exit 0
