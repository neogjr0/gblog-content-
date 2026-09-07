// gblog-check.js — history.json에서 특정 제목의 성공/실패 횟수 출력
// 사용법: node gblog-check.js <history.json 경로> <글 제목>
// 출력: "성공횟수 실패횟수"
const fs = require('fs')
const histPath = process.argv[2]
const title = process.argv[3] || ''
let recs = []
try {
  recs = JSON.parse(fs.readFileSync(histPath, 'utf8'))
} catch (e) {
  // history.json이 없거나 깨져 있으면 0 0
}
const matched = recs.filter(r => (r.title || '') === title)
const err = matched.filter(r => r.error).length
const ok = matched.length - err
console.log(`${ok} ${err}`)
