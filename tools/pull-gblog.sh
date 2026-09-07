#!/bin/bash
# ============================================================
# gblog 자동 발행 풀러 v3 — 실패 복구 + 중복 방지
#   - 성공 판별: history.json에서 해당 제목의 최신 기록에 error 없음 = 성공
#   - 실패 시: 20분 후 자동 재시도 (최대 5회, 이후 failed 목록에 기록)
#   - 하루 2개·3시간 간격, 성공 건만 카운트
# ============================================================
PROJ="$HOME/g-blogger-auto-publish"
QUEUE_URL="https://raw.githubusercontent.com/neogjr0/gblog-content-/main/guides/queue"
DAILY_MAX=2
MIN_GAP=10800          # 성공 간격 3시간
RETRY_GAP=1200         # 실패 재시도 20분
QUIET_AFTER=23
MAX_ATTEMPTS=5
STATE="$HOME/.gblog-state.json"
DONE="$HOME/.gblog-done.txt"
FAILED="$HOME/.gblog-failed.txt"
HIST="$PROJ/history.json"

cd "$PROJ" || exit 1

# 뉴스 자동발행 락 대기
for i in $(seq 1 20); do
  if [ ! -d "$PROJ/.blogger-session-lock" ]; then break; fi
  sleep 15
done

TODAY=$(date +%Y-%m-%d)
HOUR=$(date +%H)
NOW=$(date +%s)

# 상태 로드 (node 사용 — VM에 node는 확실히 있음)
if [ -f "$STATE" ]; then
  SDAY=$(node -e "console.log(require('$STATE').date||'')" 2>/dev/null)
  CNT=$(node -e "console.log(require('$STATE').count||0)" 2>/dev/null)
  LASTOK=$(node -e "console.log(require('$STATE').lastOkTs||0)" 2>/dev/null)
  LASTATT=$(node -e "console.log(require('$STATE').lastAttemptTs||0)" 2>/dev/null)
else
  SDAY=""; CNT=0; LASTOK=0; LASTATT=0
fi
[ -z "$CNT" ] && CNT=0
[ -z "$LASTOK" ] && LASTOK=0
[ -z "$LASTATT" ] && LASTATT=0
if [ "$SDAY" != "$TODAY" ]; then CNT=0; LASTOK=0; LASTATT=0; fi

# 심야 or 일일 한도 → 종료
if [ "${HOUR#0}" -ge "$QUIET_AFTER" ]; then exit 0; fi
if [ "$CNT" -ge "$DAILY_MAX" ]; then exit 0; fi

# queue 파일 목록
LIST=$(curl -sf --max-time 30 "https://api.github.com/repos/neogjr0/gblog-content-/contents/guides/queue" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{ const d=JSON.parse(s); d.filter(f=>f.name.endsWith('.json')).sort((a,b)=>a.name<b.name?-1:1).forEach(f=>console.log(f.name)) }catch(e){}
})")

mkdir -p "$HOME/.gblog-queue"
cd "$HOME/.gblog-queue" || exit 1

for fname in $LIST; do
  # 이미 완료/실패 처리된 파일 스킵
  grep -q "^$fname$" "$DONE" 2>/dev/null && continue
  grep -q "^$fname$" "$FAILED" 2>/dev/null && continue

  curl -sf --max-time 30 "$QUEUE_URL/$fname" -o "$fname" || continue
  [ -s "$fname" ] || continue

  TITLE=$(node -e "const p=require('./$fname');console.log((p[0].headline||p[0].title||''))")
  [ -z "$TITLE" ] && continue

  # history.json에서 이 제목 상태 확인
  # ERRCNT = error 기록 수 / OKCNT = error 없는 기록 수
  read ERRCNT OKCNT <<< $(node -e "
const fs=require('fs');
let h=[];try{h=JSON.parse(fs.readFileSync('$HIST','utf8'))}catch(e){}
const t='$TITLE'.replace(/'/g,\"\\'\"\");
const recs=h.filter(r=>r.title===t);
const err=recs.filter(r=>r.error).length;
const ok=recs.length-err;
console.log(err, ok);
" 2>/dev/null)

  # 이미 성공한 적 있음 → DONE 처리하고 다음 파일로
  if [ "$OKCNT" -gt 0 ]; then
    echo "$fname" >> "$DONE"
    echo "[$(date)] 이미 발행된 글 감지 → 건너뜀: $fname"
    continue
  fi

  # 게이트: 실패 이력 있으면 20분 재시도 간격, 없으면 3시간 성공 간격
  if [ "$ERRCNT" -gt 0 ]; then
    GAP=$RETRY_GAP
  else
    GAP=$MIN_GAP
  fi
  DIFF=$((NOW - LASTATT))
  if [ "$DIFF" -lt "$GAP" ]; then
    exit 0   # 아직 재시도 시간 전
  fi

  # 발행 시도
  cp "$fname" "$PROJ/posts.json"
  echo "[$(date)] 발행 시도 ($((ERRCNT+1))회차): $fname"
  node publish.js

  # 재확인: 이제 error 없는 기록이 생겼는지
  OKNOW=$(node -e "
const fs=require('fs');
let h=[];try{h=JSON.parse(fs.readFileSync('$HIST','utf8'))}catch(e){}
const t='$TITLE'.replace(/'/g,\"\\'\");
console.log(h.filter(r=>r.title===t && !r.error).length);
" 2>/dev/null)

  node -e "require('fs').writeFileSync('$STATE', JSON.stringify({date:'$TODAY',count:$CNT,lastOkTs:$LASTOK,lastAttemptTs:$(date +%s)}))"

  if [ "${OKNOW:-0}" -gt 0 ]; then
    echo "$fname" >> "$DONE"
    CNT=$((CNT + 1))
    node -e "require('fs').writeFileSync('$STATE', JSON.stringify({date:'$TODAY',count:$CNT,lastOkTs:$(date +%s),lastAttemptTs:$(date +%s)}))"
    echo "[$(date)] ✅ 발행 성공: $fname (오늘 $CNT/$DAILY_MAX)"
  else
    echo "[$(date)] ❌ 발행 실패 — 20분 후 자동 재시도: $fname"
    if [ "$ERRCNT" -ge $((MAX_ATTEMPTS - 1)) ]; then
      echo "$fname" >> "$FAILED"
      echo "[$(date)] ⛔ 5회 실패 — 중단 처리됨: $fname (로그: $FAILED)"
    fi
  fi
  exit 0
done
exit 0
