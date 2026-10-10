// publish-local.js — 레시피 블로그(soeasycook / 냠냠레시피) 전용 자동 발행기 (v1)
//   queue/ 폴더에 글 폴더(body.html + meta.json)를 넣으면 자동 발행
//   recipe-*.zip 을 Downloads/Desktop/Documents 에서 자동 설치
//   하루 2편 · 10분 간격 제한 (캡차·스팸 방지)
// - publish.js(뉴스 자동발행기)의 검증된 발행 엔진을 재사용
// - 카테고리 자동 선택: 실 DOM 셀렉터 기반 (TinyMCE 메뉴, 정규화 매칭)
// - 발행 성공 폴더는 .done 마커 + done/ 이동 → 중복 발행 방지 & queue 자동 정리
//
// 실행 방법:
//   1) 일반:  node publish-local.js        → queue의 글 1회 처리 후 종료
//   2) 감시:  node publish-local.js --watch → queue를 계속 감시, 새 글이 들어오면 자동 발행
//      (감시 모드에서는 터미널 창을 켜둔 채 zip만 queue에 풀면 끝!)
//
// queue 폴더 구조:
//   queue/<아무폴더이름>/
//     meta.json   { "title": "글 제목", "tags": ["태그"], "category": "카테고리명" }
//     body.html   본문 HTML
//     thumb.png   (선택) 대표이미지 1200x630
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile, execSync } = require('child_process');

// ===== [RECIPE] calc-*.zip 자동 설치 + 하루 2편 제한 (감시 창 없이 한 창으로 동작) =====
const ZIP_PREFIX = 'recipe-';
const MAX_PER_DAY = 2;                       // 하루 최대 발행 편수
const GAP_MS = 10 * 60 * 1000;               // 편 사이 최소 간격 10분
const STATE_FILE = path.join(__dirname, '.recipe-state.json');

function installerRoots() {
  const roots = [__dirname, path.join(__dirname, 'inbox')];
  try {
    const usersDir = 'C:\\Users';
    for (const u of fs.readdirSync(usersDir)) {
      if (['Public', 'Default', 'All Users', 'Default User', 'WDAGUtilityAccount'].indexOf(u) !== -1) continue;
      const base = path.join(usersDir, u);
      roots.push(path.join(base, 'Downloads'));
      roots.push(path.join(base, 'Downloads', 'Telegram Desktop'));
      roots.push(path.join(base, 'Documents'));
      roots.push(path.join(base, 'Desktop'));
    }
  } catch (e) { /* 무시 */ }
  return roots;
}

function extractZip(zipPath, destDir) {
  const q = (s) => '"' + String(s).replace(/"/g, '') + '"';
  try {
    execSync('tar -xf ' + q(zipPath) + ' -C ' + q(destDir), { stdio: 'ignore', timeout: 60000 });
    return true;
  } catch (e) {
    try {
      execSync('powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath ' +
        "'" + String(zipPath).replace(/'/g, "''") + "'" + ' -DestinationPath ' + "'" +
        String(destDir).replace(/'/g, "''") + "'" + ' -Force"', { stdio: 'ignore', timeout: 120000 });
      return true;
    } catch (e2) { return false; }
  }
}

function installNewZips() {
  let installed = 0;
  for (const root of installerRoots()) {
    let files = [];
    try { files = fs.readdirSync(root); } catch (e) { continue; }
    for (const f of files) {
      if (f.indexOf(ZIP_PREFIX) !== 0 || f.slice(-4).toLowerCase() !== '.zip') continue;
      if (f.indexOf('recipe-pipeline') === 0) continue;   // 발행기 설치 파일은 제외
      const zipPath = path.join(root, f);
      try { if (!fs.statSync(zipPath).isFile()) continue; } catch (e) { continue; }
      if (extractZip(zipPath, QUEUE_DIR)) {
        console.log('  [INSTALLED] ' + f + '  (' + root + ')');
        try { fs.unlinkSync(zipPath); } catch (e) { /* 무시 */ }
        installed++;
      } else {
        console.log('  [FAIL] ' + f + ' — 압축 해제 실패(파일이 사용 중일 수 있음)');
      }
    }
  }
  if (installed > 0) console.log('  📦 zip ' + installed + '개 설치 완료 → 발행 대기열로 이동');
  return installed;
}

function kstDay() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { day: '', count: 0, lastAt: 0 }; }
}
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { /* 무시 */ } }
function canPublishNow() {
  const s = loadState();
  if (s.day !== kstDay()) {
    s.day = kstDay(); s.count = 0; s.lastAt = 0; saveState(s);
    return { ok: true };
  }
  if (s.count >= MAX_PER_DAY) return { ok: false, why: '오늘 한도(' + MAX_PER_DAY + '편) 도달 — 내일 자동 재개' };
  if (s.lastAt && Date.now() - s.lastAt < GAP_MS) {
    const left = Math.ceil((GAP_MS - (Date.now() - s.lastAt)) / 60000);
    return { ok: false, why: '3시간 간격 대기 중 (약 ' + left + '분 남음)' };
  }
  return { ok: true };
}
function markPublished(n) {
  const s = loadState();
  if (s.day !== kstDay()) { s.day = kstDay(); s.count = 0; }
  s.count = (s.count || 0) + n;
  s.lastAt = Date.now();
  saveState(s);
  console.log('  📊 오늘 발행 ' + s.count + '/' + MAX_PER_DAY + '편');
}

const COOKIES_PATH = path.join(__dirname, 'cookies.json');
const QUEUE_DIR = path.join(__dirname, 'queue');
const DONE_DIR = path.join(__dirname, 'done');
const FAILED_DIR = path.join(__dirname, 'failed');

// ===== 사람 Enter 대기 (캡차 등은 사람이 직접) =====
function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => { rl.close(); resolve(); });
  });
}

function systemBeep() {
  return new Promise((resolve) => {
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      '$s.Volume = 100;',
      '$s.Rate = 1;',
      "$s.Speak('캡차 확인해주세요');",
      "$s.Speak('캡차 확인해주세요');",
    ].join(' ');
    execFile('powershell', ['-NoProfile', '-Command', script], (err) => {
      if (err) console.log('  ⚠️ 알림 음성 재생 실패(무시):', err.message);
      resolve();
    });
  });
}

// ===== 쿠키 로드 =====
function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    throw new Error(
      `cookies.json 파일이 없습니다. (${COOKIES_PATH})\n` +
      `Cookie-Editor 확장으로 soeasycook.tistory.com 로그인 후 쿠키를 내보내서 저장해주세요.`
    );
  }
  const raw = fs.readFileSync(COOKIES_PATH, 'utf-8');
  const cookies = parseJsonTolerant(raw, 'cookies.json');
  return normalizeCookieDomain(cookies).map((c) => {
    const cleaned = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' };
    if (typeof c.expirationDate === 'number') cleaned.expires = c.expirationDate;
    if (typeof c.httpOnly === 'boolean') cleaned.httpOnly = c.httpOnly;
    if (typeof c.secure === 'boolean') cleaned.secure = c.secure;
    if (['Strict', 'Lax', 'None'].includes(c.sameSite)) cleaned.sameSite = c.sameSite;
    return cleaned;
  });
}

// [RECIPE] 쿠키 도메인을 .tistory.com 으로 통일해 새 블로그에서도 세션 적용
function normalizeCookieDomain(cookies) {
  return cookies.map((c) => {
    const d = String(c.domain || '');
    if (d.indexOf('tistory.com') !== -1) {
      return Object.assign({}, c, { domain: '.tistory.com' });
    }
    return c;
  });
}

// [RECIPE] 관대한 JSON 파서 — 붙여넣기 사고(뒤에 찌꺼기) 자동 복구
function parseJsonTolerant(raw, what) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const arr = raw.match(/\[[\s\S]*?\]\s*(?=\[|$)/);
    if (arr) {
      try {
        const v = JSON.parse(arr[0]);
        if (Array.isArray(v) && v.length) {
          console.log('  🛠 ' + what + ' 파일에 불필요한 내용이 있어 앞부분만 사용합니다 (자동 복구)');
          return v;
        }
      } catch (e2) { /* 계속 */ }
    }
    const start = raw.indexOf('[');
    if (start !== -1) {
      let depth = 0, end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '[') depth++;
        else if (raw[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > start) {
        try {
          const v = JSON.parse(raw.slice(start, end + 1));
          if (Array.isArray(v) && v.length) {
            console.log('  🛠 ' + what + ' 파일 끝에 찌꺼기가 있어 잘라내고 사용합니다 (자동 복구)');
            return v;
          }
        } catch (e3) { /* 계속 */ }
      }
    }
    throw new Error(
      what + ' 파일 형식이 깨졌습니다. (' + e.message + ')\n' +
      '   → Cookie-Editor로 다시 내보내 저장하세요:\n' +
      "     ① Chrome에서 티스토리 로그인 → Cookie-Editor → Export → 'Export as JSON'\n" +
      '     ② 저장된 파일을 이 폴더에 덮어쓰기 (메모장 복붙 대신 다운로드 방식 권장)'
    );
  }
}

// ===== v12: 쿠키 자동 재로드 (파일이 바뀌면 다음 글부터 자동 적용 — 재시작 불필요) =====
let lastCookieMtime = 0;

function loadCookiesIfChanged(currentCookies) {
  try {
    const st = fs.statSync(COOKIES_PATH);
    if (st.mtimeMs !== lastCookieMtime) {
      const fresh = loadCookies(); // 파일을 다시 읽어 파싱
      lastCookieMtime = st.mtimeMs;
      console.log(`  🔄 cookies.json 변경 감지 → 새 쿠키 ${fresh.length}개 자동 적용 (재시작 불필요)`);
      return fresh;
    }
  } catch (e) {
    // 파일이 잠깐 비어 있거나 저장 중일 수 있음 — 기존 쿠키 유지
  }
  return currentCookies;
}

// ===== 공용 헬퍼 =====
async function robustClick(page, selector, { retries = 3, waitTimeout = 8000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: waitTimeout });
      await page.click(selector);
      return true;
    } catch (e) {
      console.log(`  ⚠️ 클릭 실패 [${selector}] (시도 ${attempt}/${retries}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  return false;
}

async function findEditorFrame(page) {
  const SELECTORS = ['.mce-content-body', '[contenteditable="true"]'];
  for (const frame of page.frames()) {
    for (const sel of SELECTORS) {
      try {
        const exists = await frame.evaluate((s) => !!document.querySelector(s), sel);
        if (exists) return { frame, selector: sel };
      } catch (e) { /* cross-origin 등은 무시 */ }
    }
  }
  return { frame: null, selector: null };
}

async function evalInFrames(page, fn) {
  for (const frame of page.frames()) {
    try {
      const r = await frame.evaluate(fn);
      if (r) return r;
    } catch (e) { /* 접근 불가 프레임 등 무시 */ }
  }
  return null;
}

// 이미지 파일(base64)을 본문 맨 앞에 붙여넣기 (티스토리 CDN 업로드 유도)
async function pasteFileIntoBody(page, base64Data, mimeType, filename, altText) {
  const { frame: targetFrame, selector: matchedSelector } = await findEditorFrame(page);
  if (!targetFrame) {
    console.log('  ⚠️ 본문 편집 영역을 못 찾아 이미지 삽입 생략');
    return false;
  }
  try {
    await targetFrame.evaluate((sel) => {
      const target = document.querySelector(sel);
      if (!target) return;
      target.focus();
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(true);
      const selection = target.ownerDocument.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, matchedSelector);
  } catch (e) { /* 무시 */ }

  const result = await targetFrame.evaluate(
    (sel, b64, mime, fname) => {
      try {
        const byteChars = atob(b64);
        const byteNumbers = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
        const byteArray = new Uint8Array(byteNumbers);
        const file = new File([byteArray], fname, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);
        const target = document.querySelector(sel);
        if (!target) return { ok: false, reason: '본문 영역(target)을 못 찾음' };
        target.focus();
        const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        const dispatched = target.dispatchEvent(pasteEvent);
        return { ok: true, dispatched };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    },
    matchedSelector, base64Data, mimeType, filename
  );
  if (!result.ok) {
    console.log(`  ⚠️ 이미지 붙여넣기 실패: ${result.reason}`);
    return false;
  }
  try {
    await page.waitForFunction(() => !document.body.innerText.includes('업로드 중'), { timeout: 6000 });
  } catch (e) { /* 무시 */ }
  if (altText) {
    try {
      const altSet = await targetFrame.evaluate(
        (sel, alt) => {
          const container = document.querySelector(sel);
          const img = container ? container.querySelector('img') : null;
          if (img) { img.alt = alt; return true; }
          return false;
        }, matchedSelector, altText
      );
      if (altSet) console.log('  이미지 alt 속성 설정함 (SEO)');
    } catch (e) { /* 무시 */ }
  }
  console.log('  이미지를 본문 맨 앞에 붙여넣음');
  return true;
}

// 본문 HTML을 text/html paste로 삽입 (TinyMCE 표준 경로)
async function pasteHtmlIntoBody(page, html) {
  const { frame: targetFrame, selector: matchedSelector } = await findEditorFrame(page);
  if (!targetFrame) {
    console.log('  ⚠️ 본문 편집 영역을 못 찾아 본문 삽입 생략');
    return false;
  }
  try {
    await targetFrame.evaluate((sel) => {
      const target = document.querySelector(sel);
      if (!target) return;
      target.focus();
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false); // 맨 끝
      const selection = target.ownerDocument.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, matchedSelector);
  } catch (e) { /* 무시 */ }

  const result = await targetFrame.evaluate(
    (sel, htmlText) => {
      try {
        const target = document.querySelector(sel);
        if (!target) return { ok: false, reason: '본문 영역(target)을 못 찾음' };
        target.focus();
        const dt = new DataTransfer();
        dt.setData('text/html', htmlText);
        dt.setData('text/plain', htmlText.replace(/<[^>]+>/g, ' '));
        const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        const dispatched = target.dispatchEvent(pasteEvent);
        return { ok: true, dispatched };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }, matchedSelector, html
  );
  await new Promise((r) => setTimeout(r, 800));
  if (!result.ok) {
    console.log(`  ⚠️ 본문 붙여넣기 실패: ${result.reason}`);
    return false;
  }
  const textLen = await targetFrame
    .evaluate((sel) => {
      const target = document.querySelector(sel);
      return target ? target.innerText.trim().length : 0;
    }, matchedSelector)
    .catch(() => 0);
  console.log(`  본문 삽입됨 (글자수=${textLen})`);
  return textLen > 20;
}

// ===== 카테고리 자동 선택 (v3 — 정규화 매칭 + category-item ID) =====
async function autoSelectCategory(page, category) {
  if (!category) return false;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').replace(/^[\s·•∙▪◦▶]+|[\s·•∙▪◦]+$/g, '').trim();
  const target = norm(category);

  const clickTrigger = async (frame) => {
    return frame.evaluate(() => {
      const sels = ['#category', '[role="combobox"]', '.mce-listbox', '[aria-haspopup="true"]', '[id*="categor" i]'];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { el.click(); return true; }
      }
      return false;
    }).catch(() => false);
  };

  const findOption = async () => {
    for (const frame of page.frames()) {
      try {
        const r = await frame.evaluate((tgt) => {
          const n = (s) => (s || '').replace(/\s+/g, ' ').replace(/^[\s·•∙▪◦▶]+|[\s·•∙▪◦]+$/g, '').trim();
          const els = Array.from(document.querySelectorAll('[role="option"], [id^="category-item"]'));
          for (const el of els) {
            const rct = el.getBoundingClientRect();
            if (rct.width <= 0 || rct.height <= 0) continue;
            const label = n(el.getAttribute('aria-label'));
            const mce = el.querySelector('.mce-text');
            const mceText = mce ? n(mce.textContent) : '';
            const name = label || mceText || n(el.textContent);
            if (name === tgt) { el.click(); return true; }
          }
          return false;
        }, target);
        if (r) return true;
      } catch (e) { /* 접근 불가 프레임 등 무시 */ }
    }
    return false;
  };

  const dumpOptions = async () => {
    for (const frame of page.frames()) {
      try {
        const names = await frame.evaluate(() => {
          const n = (s) => (s || '').replace(/\s+/g, ' ').replace(/^[\s·•∙▪◦▶]+|[\s·•∙▪◦]+$/g, '').trim();
          return Array.from(document.querySelectorAll('[id^="category-item"]')).slice(0, 15).map((el) => {
            const mce = el.querySelector('.mce-text');
            return n(el.getAttribute('aria-label')) || (mce ? n(mce.textContent) : n(el.textContent));
          });
        }).catch(() => []);
        if (names.length) return names;
      } catch (e) { /* 무시 */ }
    }
    return [];
  };

  const frames = page.frames();
  for (let attempt = 0; attempt < frames.length; attempt++) {
    const frame = frames[attempt];
    if (attempt > 0) {
      try { await page.keyboard.press('Escape'); } catch (e) { /* 무시 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    const clicked = await clickTrigger(frame);
    if (!clicked) continue;
    await new Promise((r) => setTimeout(r, 900));
    const found = await findOption();
    if (found) {
      await new Promise((r) => setTimeout(r, 400));
      return true;
    }
  }

  const found = await findOption();
  if (found) {
    await new Promise((r) => setTimeout(r, 400));
    return true;
  }

  const names = await dumpOptions();
  if (names.length) console.log(`  현재 드롭다운에 보이는 카테고리: ${names.join(' | ')}`);
  return false;
}

// ===== 글 1건 발행 =====
// ===== v17: 대표이미지 파일 찾기 (thumb.png / thumb.jpg / thumb.jpeg 모두 지원) =====
function resolveThumbPath(itemDir) {
  for (const name of ['thumb.png', 'thumb.jpg', 'thumb.jpeg', 'thumb.JPG']) {
    const p = path.join(itemDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function publishOne(browser, cookies, itemDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(itemDir, 'meta.json'), 'utf-8'));
  const bodyHtml = fs.readFileSync(path.join(itemDir, 'body.html'), 'utf-8');
  const thumbPath = resolveThumbPath(itemDir);
  const hasThumb = !!thumbPath;

  const title = meta.title || '제목 없음';
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const category = meta.category || null;

  const srcTableCount = (bodyHtml.match(/<table[\s>]/gi) || []).length;
  console.log(`\n=== 발행: ${title} ===`);
  console.log(`  소스상 <table> 개수: ${srcTableCount}, 대표이미지: ${hasThumb ? '있음' : '없음'}`);

  const page = await browser.newPage();
  await page.setCookie(...cookies);

  page.on('dialog', async (dialog) => {
    const msg = dialog.message();
    if (msg.includes('이어서 작성')) {
      console.log(`  대화상자 "${msg}" → 취소 (새 글로 시작)`);
      await dialog.dismiss();
    } else {
      await dialog.accept();
    }
  });

  // ===== 글쓰기 페이지 진입 (v9: 타임아웃·일시 오류 대비 재시도) =====
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    try {
      await page.goto('https://soeasycook.tistory.com/manage/newpost/?type=post', {
        waitUntil: 'domcontentloaded', timeout: 45000,
      });
      loaded = true;
    } catch (e) {
      console.log(`  ⚠️ 새 글 페이지 로드 ${attempt}/3 실패 (${String(e.message).split('\n')[0]}) — 3초 후 재시도...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!loaded) {
    // 마지막 수단: 로드 완료 대기 없이 진입 후 에디터가 뜰 때까지 직접 대기
    try {
      await page.goto('https://soeasycook.tistory.com/manage/newpost/?type=post', {
        waitUntil: 'commit', timeout: 60000,
      });
    } catch (e) { /* 무시 — 아래에서 에디터 확인 */ }
  }

  // 로그인 세션 만료 여부 확인
  const curUrl = page.url();
  if (curUrl.includes('login') || curUrl.includes('auth')) {
    await page.close();
    throw new Error('SESSION_EXPIRED — 쿠키를 새로 내보내서 cookies.json 갱신 필요');
  }

  // 에디터(제목 입력창)가 실제로 나타날 때까지 대기 (최대 60초)
  try {
    await page.waitForSelector('textarea#post-title-inp', { timeout: 60000 });
  } catch (e) {
    const errUrl = page.url();
    await page.close();
    throw new Error(`글쓰기 에디터가 나타나지 않음 (현재 URL: ${errUrl}) — 네트워크 상태 확인 후 재시도`);
  }

  // 제목 입력
  await page.click('textarea#post-title-inp', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('textarea#post-title-inp', title);

  if (hasThumb) {
    const b64 = fs.readFileSync(thumbPath).toString('base64');
    const imgOk = await pasteFileIntoBody(page, b64, 'image/png', 'thumb.png', title);
    if (!imgOk) console.log('  ⚠️ 대표이미지 본문 삽입 실패 — 발행 모달에서 직접 선택 필요');
  }

  const bodyPasted = await pasteHtmlIntoBody(page, bodyHtml);
  if (!bodyPasted) {
    console.log('  ⚠️ 본문 삽입이 확실치 않음 — 지금 브라우저에서 직접 확인/보완해주세요.');
    await waitForEnter('  확인(또는 직접 붙여넣기)했으면 Enter...');
  }

  if (srcTableCount > 0) {
    try {
      let liveTableCount = 0;
      for (const frame of page.frames()) {
        try {
          liveTableCount += await frame.evaluate(() => {
            const body = document.querySelector('.mce-content-body');
            return body ? body.querySelectorAll('table').length : 0;
          });
        } catch (e) { /* 무시 */ }
      }
      if (liveTableCount > 0) {
        console.log(`  ✅ 에디터에 표 ${liveTableCount}개 살아있음`);
      } else {
        console.log('  ⚠️ 소스에는 <table>이 있었는데 에디터에서 표가 안 보임 — 표가 깨졌을 수 있음.');
        await waitForEnter('  표 상태를 브라우저에서 직접 확인했으면 Enter...');
      }
    } catch (e) { /* 무시 */ }
  }

  try {
    const shotPath = path.join(__dirname, `debug-${Date.now()}.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
    console.log(`  디버그 스크린샷: ${shotPath}`);
  } catch (e) { /* 무시 */ }

  if (tags.length) {
    await page.waitForSelector('input#tagText');
    await page.click('input#tagText', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('input#tagText', tags.join(','));
    await page.keyboard.press('Enter');
  }

  if (!(await robustClick(page, 'button#publish-layer-btn'))) {
    console.log('  ⚠️ "완료" 버튼 클릭 실패. 직접 눌러주세요.');
    await waitForEnter('  "완료"를 직접 눌렀으면 Enter...');
  }
  try {
    await page.waitForSelector('button#publish-btn', { visible: true, timeout: 15000 });
  } catch (e) {
    throw new Error(`발행 모달(button#publish-btn)이 안 뜸. 카테고리 미선택 때문일 수 있음: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));

  if (hasThumb) {
    try {
      const fileInput = await page.$('input.inp_g[type="file"]');
      if (fileInput) {
        await fileInput.uploadFile(thumbPath);
        console.log('  대표이미지 업로드함');
        await new Promise((r) => setTimeout(r, 800));
      } else {
        console.log('  ⚠️ 대표이미지 input을 못 찾음 — 직접 선택해주세요.');
      }
    } catch (e) {
      console.log('  ⚠️ 대표이미지 자동 업로드 실패(계속 진행):', e.message);
    }
  }

  if (category) {
    const catOk = await autoSelectCategory(page, category);
    if (catOk) {
      console.log('  ✅ 카테고리 자동 선택됨 — 확인용 Enter 없이 바로 발행 진행');
    } else {
      console.log(`  ⚠️ 카테고리 "${category}" 자동 선택 실패 — 발행 창에서 직접 선택해주세요.`);
      console.log('  ▶ [필요] 카테고리를 직접 선택한 뒤, 터미널에서 Enter를 눌러 계속 진행하세요.');
      await waitForEnter('  카테고리 직접 선택 후 Enter... (그다음 발행 버튼 자동 클릭)');
    }
  } else {
    console.log('  (카테고리 미지정 상태로 발행 진행 — 나중에 글 관리에서 변경 가능)');
  }

  // ===== [RECIPE] 공개 설정 강제 — 비공개로 저장되는 문제 방지 =====
  try {
    const vis = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('.ReactModal__Content, [role="dialog"], .modal, .layer_post, .wrap_btn'));
      const scopes = dialogs.length ? dialogs : [document.body];
      const log = [];
      for (const sc of scopes) {
        const els = Array.from(sc.querySelectorAll('button, label, li, a, span, div[role="radio"], input[type="radio"]'));
        for (const e of els) {
          const t = (e.textContent || '').trim();
          if (t !== '공개') continue;                     // '비공개'는 t가 '비공개'라 제외됨
          const tag = e.tagName;
          const cls = String(e.className || '');
          if (tag === 'INPUT') { e.click(); return { ok: true, how: 'input' }; }
          log.push(tag + '.' + cls.slice(0, 30));
          e.click();
          return { ok: true, how: tag + '.' + cls.slice(0, 40) };
        }
      }
      return { ok: false, log: log };
    });
    if (vis.ok) console.log('  🔓 공개 설정 선택: ' + vis.how);
    else console.log('  ⚠️ 공개 설정 항목을 못 찾음 — 글 관리에서 비공개면 직접 공개로 변경하세요');
    await new Promise((r) => setTimeout(r, 400));
  } catch (e) {
    console.log('  ⚠️ 공개 설정 시도 실패(계속 진행):', e.message);
  }

  console.log('  발행 버튼 클릭 중...');
  if (!(await robustClick(page, 'button#publish-btn'))) {
    console.log('  ⚠️ "발행" 버튼 클릭 3번 실패. 직접 눌러주세요.');
    await waitForEnter('  "발행"을 직접 눌렀으면 Enter...');
  }

  // ===== v11: 발행 완료 자동 감지 — Enter 불필요 =====
  // 발행 후 URL이 /manage/posts 또는 /entry/ 로 바뀌면 성공으로 판단.
  // 캡차가 뜨면 사람이 풀 때까지 대기(주기적으로 소리 알림), 풀면 자동으로 다음 진행.
  await systemBeep();
  try { await page.bringToFront(); } catch (e) { /* 무시 */ }
  console.log('  🔔 캡차가 뜨면 직접 풀어주세요 (주기적으로 소리로 알려드립니다)');
  console.log('  발행 완료를 자동 감지합니다 — Enter 필요 없음, 기다려 주세요...');

  const startTime = Date.now();
  let isPublished = false;
  let beepCount = 0;
  while (Date.now() - startTime < 10 * 60 * 1000) { // 최대 10분 대기
    try {
      const u = page.url();
      if (u.includes('/manage/posts') || u.includes('/entry/')) { isPublished = true; break; }
    } catch (e) { break; }
    beepCount++;
    if (beepCount % 8 === 0) { // 약 24초마다 알림 (캡차 미해결 안내)
      try { await systemBeep(); } catch (e) { /* 무시 */ }
      console.log('  🔔 아직 발행 완료 안 됨 — 캡차가 떠 있으면 풀어주세요...');
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const finalUrl = page.url();
  if (!isPublished) {
    console.log(`  ⚠️ 10분 내 발행 완료를 감지하지 못함 (현재 URL: ${finalUrl})`);
    await waitForEnter('  브라우저 상태 직접 확인 후 Enter... (성공했으면 done 처리됩니다)');
    isPublished = finalUrl.includes('/manage/posts') || finalUrl.includes('/entry/');
  }
  await page.close();
  return { success: isPublished, publishedUrl: finalUrl, title };
}

// ===== queue 아이템 폴더 찾기 =====
function resolveItemDir(dir) {
  let cur = dir;
  for (let depth = 0; depth < 3; depth++) {
    if (fs.existsSync(path.join(cur, 'meta.json'))) return cur;
    const subs = fs.readdirSync(cur).filter((n) => {
      try { return fs.statSync(path.join(cur, n)).isDirectory(); } catch (e) { return false; }
    });
    if (subs.length === 1) cur = path.join(cur, subs[0]);
    else break;
  }
  return cur;
}

function listItemContents(dir) {
  try {
    return fs.readdirSync(dir).join(', ');
  } catch (e) {
    return `(읽기 실패: ${e.message})`;
  }
}

function listQueueDirs() {
  try {
    return fs.readdirSync(QUEUE_DIR).filter((name) => {
      try { return fs.statSync(path.join(QUEUE_DIR, name)).isDirectory(); } catch (e) { return false; }
    }).sort();
  } catch (e) { return []; }
}

function isAlreadyProcessed(name, rawDir, itemDir) {
  return (
    fs.existsSync(path.join(rawDir, '.done')) ||
    fs.existsSync(path.join(itemDir, '.done')) ||
    fs.readdirSync(DONE_DIR).some((d) => d.endsWith('-' + name))
  );
}

// ===== 대기열 1회 처리 (watch/일반 공용) =====
async function processAllPending(browser, cookies, { onConnExhausted } = {}) {
  let processedAny = false;
  for (const name of listQueueDirs()) {
    const rawDir = path.join(QUEUE_DIR, name);
    const itemDir = resolveItemDir(rawDir);

    if (isAlreadyProcessed(name, rawDir, itemDir)) {
      console.log(`  ⏭️ [${name}] 이미 발행 처리된 글 — queue에서 자동 정리(done/로 이동)`);
      try { fs.renameSync(rawDir, path.join(DONE_DIR, `${Date.now()}-dup-${name}`)); } catch (e) { /* 무시 */ }
      continue;
    }

    if (!fs.existsSync(path.join(itemDir, 'meta.json'))) {
      console.log(`  ❌ [${name}] 폴더 안에 meta.json이 없습니다.`);
      console.log(`     현재 폴더 내용: ${listItemContents(rawDir)}`);
      console.log(`     필요 파일: meta.json (제목/태그), body.html (본문), thumb.png (선택)`);
      try { fs.renameSync(rawDir, path.join(FAILED_DIR, `${Date.now()}-${name}`)); } catch (e) { /* 무시 */ }
      console.log('     failed/로 이동했습니다. queue에서 정리 후 다시 실행하세요.');
      continue;
    }
    if (itemDir !== rawDir) {
      console.log(`  [${name}] 중첩 폴더 감지 → 실제 글 폴더: ${path.relative(QUEUE_DIR, itemDir)}`);
    }
    processedAny = true;
    // v10: 일시적 차단/오류 대비 — 글 1건당 최대 3회 시도 (60초 간격)
    let attempt = 1;
    let result = null;
    let lastErr = null;
    let connRestarts = 0;
    while (attempt <= 3) {
      try {
        // v12: 발행 직전마다 쿠키 파일 변경 확인 — 갱신돼 있으면 자동 적용
        cookies = loadCookiesIfChanged(cookies);
        // v16: 남아있는 탭 정리 (앞선 실패로 열린 무거운 에디터 탭이 남으면 메모리 폭증 → 크래시)
        try {
          const opened = await browser.pages();
          if (opened.length > 1) {
            console.log(`  🧹 시작 전 남은 탭 ${opened.length}개 정리`);
            for (const p of opened) { try { await p.goto('about:blank'); } catch (e6) { /* 무시 */ } }
            for (let i = 1; i < opened.length; i++) { try { await opened[i].close(); } catch (e6) { /* 무시 */ } }
          }
        } catch (e6) { /* 무시 */ }
        // v16: 먹통 방지 — 최대 15분(캡차 대기 포함) 응답 없으면 실패로 처리하고 브라우저 재시작
        result = await Promise.race([
          publishOne(browser, cookies, itemDir),
          new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT — 응답 없음(먹통) 15분 초과')), 15 * 60 * 1000)),
        ]);
        break; // 예외 없이 끝나면 성공(여부는 result.success로 판단)
      } catch (e) {
        lastErr = e;
        // v12: 세션 만료 → 재시작/실패 처리 없이, 쿠키를 지금 갱신하면 그대로 재시도
        if (/SESSION_EXPIRED|세션.*만료|login|signin/i.test(String(e.message))) {
          console.log('  🔑 세션이 만료되었습니다. 재시작 필요 없어요!');
          console.log('     → Cookie-Editor로 soeasycook.tistory.com 쿠키를 다시 내보내 cookies.json에 덮어쓰세요.');
          console.log('     → 저장하는 순간 자동 감지되며, 아래 Enter를 누르면 새 쿠키로 바로 재시도합니다.');
          try { await systemBeep(); } catch (be) { /* 무시 */ }
          lastCookieMtime = -1; // 다음 시도에서 무조건 재로드
          await waitForEnter('  쿠키 갱신 후 Enter...');
          continue; // attempt 증가 없이 같은 글 재시도 (쿠키만 새로)
        }
        const msg = String(e.message);
        const isConn = /connection closed|navigation timeout|net::|target closed|protocol error|TIMEOUT|응답 없음/i.test(msg);
        // v16: 실패 시 남아있는 페이지 정리 (페이지 누적 → Chrome 메모리 폭증 → 3번째 글에서 창 닫힘/먹통 방지)
        try {
          const opened = await browser.pages();
          if (opened.length > 0) {
            console.log(`  🧹 남아있는 페이지 ${opened.length}개 정리 (메모리 보호)`);
            for (const p of opened) { try { await p.close(); } catch (e5) { /* 무시 */ } }
          }
        } catch (e5) { /* 브라우저 자체가 죽었으면 무시 */ }
        // v14: 연결 끊김(절전 복귀·브라우저 노후화) → 브라우저 새로 띄우고 같은 글 즉시 재시도
        if (isConn && onConnExhausted && connRestarts < 2) {
          connRestarts++;
          console.log(`  🔄 연결 끊김 감지 (${msg.split('\n')[0]})`);
          console.log(`     → 브라우저를 새로 시작하고 같은 글을 바로 다시 시도합니다 (${connRestarts}/2)`);
          try { const nb = await onConnExhausted(); if (nb) browser = nb; } catch (e4) { /* 무시 */ }
          await new Promise((r) => setTimeout(r, 3000));
          continue; // attempt 증가 없이 같은 글 즉시 재시도
        }
        if (attempt < 3 && isConn) {
          console.log(`  ⚠️ 발행 시도 ${attempt}/3 실패 (${msg.split('\n')[0]}) — 60초 후 재시도...`);
          await new Promise((r) => setTimeout(r, 60000));
          attempt++;
          continue;
        }
        break;
      }
    }
    if (result) {
      if (result.success) {
        try { fs.writeFileSync(path.join(rawDir, '.done'), new Date().toISOString()); } catch (e) { /* 무시 */ }
        fs.renameSync(rawDir, path.join(DONE_DIR, `${Date.now()}-${name}`));
        console.log(`  ✅ 발행 성공 → done/로 이동: ${result.publishedUrl}`);
      } else {
        fs.renameSync(rawDir, path.join(FAILED_DIR, `${Date.now()}-${name}`));
        console.log('  ⚠️ 발행 여부 불확실 → failed/로 이동 (직접 확인해주세요)');
      }
    } else {
      console.log('  ❌ 발행 실패:', lastErr ? lastErr.message : '알 수 없는 오류');
      try { fs.renameSync(rawDir, path.join(FAILED_DIR, `${Date.now()}-${name}`)); } catch (e2) { /* 무시 */ }
      console.log('  failed/로 이동했습니다. (자동 복구 2회까지 시도했으나 실패 — failed/ 폴더의 글을 queue/로 옮기면 다시 시도합니다)');
      await waitForEnter('  확인했으면 Enter를 눌러 다음 글 진행...');
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return processedAny;
}

// ===== 브라우저 실행 (v13: 재시작 가능하도록 함수화) =====
async function launchBrowser() {
  // v9.1: 자동화 탐지 회피 옵션 / v10: 실제 Chrome UA 적용
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized', '--disable-dev-shm-usage'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  // 실제 Windows Chrome과 동일한 User-Agent로 접속 (탐지 회피)
  await browser.userAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  );
  return browser;
}

// ===== 메인 =====
async function main() {
  if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
  fs.mkdirSync(DONE_DIR, { recursive: true });
  fs.mkdirSync(FAILED_DIR, { recursive: true });

  const watchMode = process.argv.includes('--watch');
  const cookies = loadCookies();
  console.log(`쿠키 ${cookies.length}개 로드됨`);
  let browser = await launchBrowser();

  if (watchMode) {
    console.log('👀 감시 모드 시작 — recipe-*.zip 자동 설치 + queue 폴더 감시 (냠냠레시피) (이 창 하나만 켜두면 됩니다)');
    console.log('   (창은 계속 켜두세요. 중지하려면 Ctrl+C)');
    let idleNotified = false;
    let lastRestartAt = Date.now();
    let lastTick = Date.now();
    const closeBrowserSafe = async () => {
      // v15: 절전/최대절전으로 브라우저가 이미 죽었으면 close()가 멈출 수 있음 → 8초 제한
      try {
        await Promise.race([
          browser.close(),
          new Promise((r) => setTimeout(r, 8000)),
        ]);
      } catch (e) { /* 무시 */ }
    };
    const restartBrowser = async (reason) => {
      await closeBrowserSafe();
      console.log(`🔄 브라우저 재시작 (${reason})...`);
      // v15: 새 브라우저 생성 실패 시 최대 3회 재시도 (절전 직후 불안정 대비)
      for (let i = 1; i <= 3; i++) {
        try {
          browser = await launchBrowser();
          break;
        } catch (e) {
          console.log(`   ⚠️ 브라우저 시작 실패 (${i}/3): ${e.message}`);
          if (i < 3) await new Promise((r) => setTimeout(r, 10000));
        }
      }
      // v16: 새 브라우저가 실제로 응답하는지 확인 (크래시 직후 좀비 프로세스 대비)
      try {
        await browser.version();
      } catch (e) {
        console.log('   ⚠️ 새 브라우저 응답 없음 — 5초 후 한 번 더 시작합니다.');
        await new Promise((r) => setTimeout(r, 5000));
        try { browser = await launchBrowser(); await browser.version(); } catch (e2) { console.log('   ⚠️ 브라우저 시작 재실패 — 다음 주기에 다시 시도합니다.'); }
      }
      lastRestartAt = Date.now();
      lastTick = Date.now();
      console.log('   브라우저 재시작 완료 — 계속 감시합니다.');
      return browser; // v14: processAllPending이 새 브라우저를 받아 쓸 수 있게 반환
    };
    while (true) {
      try {
        // v14/v15: 절전(S3)·최대절전(S4) 복귀 감지 — 정상 주기는 6초, 60초 이상 멈췄다면 잠들었던 것
        const gap = Date.now() - lastTick;
        if (gap > 60 * 1000) {
          const mins = Math.max(1, Math.round(gap / 60000));
          console.log(`\n🌙 절전/최대절전에서 복귀한 것 같습니다 (약 ${mins}분 멈춤) — 브라우저 연결이 죽어 있을 수 있어 새로 시작합니다.`);
          await restartBrowser('절전/최대절전 복귀 감지');
        }
        lastTick = Date.now();
        // v13: 장시간 실행으로 인한 연결 문제 예방 — 45분마다 브라우저 주기 재시작
        if (Date.now() - lastRestartAt > 45 * 60 * 1000) {
          await restartBrowser('45분 주기 관리');
        }
        installNewZips();
        const pending = listQueueDirs().length;
        const gate = canPublishNow();
        if (pending > 0 && gate.ok) {
          idleNotified = false;
          console.log(`\n📥 queue에 ${pending}건 발견 — 발행 시작`);
          let doneBefore = 0;
          try { doneBefore = fs.readdirSync(DONE_DIR).length; } catch (e) { /* 무시 */ }
          await processAllPending(browser, cookies, { onConnExhausted: () => restartBrowser('연결 끊김 자동 복구') });
          let doneAfter = doneBefore;
          try { doneAfter = fs.readdirSync(DONE_DIR).length; } catch (e) { /* 무시 */ }
          const n = Math.max(0, doneAfter - doneBefore);   // 실제 발행된 편수만 카운트
          if (n > 0) markPublished(n);
          else console.log('   (실제 발행 0건 — 이미 처리된 글 정리만 발생, 오늘 카운트 유지)');
          console.log('\n✅ 현재 queue의 모든 글 처리 완료 — 계속 감시 중...');
        } else if (pending > 0 && !gate.ok) {
          if (!idleNotified) {
            console.log(`⏸ ${gate.why} — queue에 ${pending}건 대기 중 (계속 지켜봅니다)`);
            idleNotified = true;
          }
        } else if (!idleNotified) {
          console.log('   queue가 비어 있음 — 새 글이 들어오면 자동 시작 (기다리는 중...)');
          idleNotified = true;
        }
      } catch (e) {
        console.log('  ⚠️ 오류 발생(무시하고 계속 감시):', e.message);
      }
      await new Promise((r) => setTimeout(r, 6000));
    }
  } else {
    const items = listQueueDirs();
    if (items.length === 0) {
      console.log('queue/ 폴더에 글이 없습니다. 글 폴더(meta.json + body.html [+ thumb.png])를 넣고 다시 실행하세요.');
      console.log(`queue 위치: ${QUEUE_DIR}`);
      console.log('※ 팁: node publish-local.js --watch 로 실행하면 폴더만 감시해서 자동 발행합니다.');
      await browser.close();
      return;
    }
    console.log(`대기 중인 글 ${items.length}건: ${items.join(', ')}`);
    await waitForEnter('시작하려면 Enter... (브라우저가 뜨면 잠시 후 자동으로 작성됩니다)');
    await processAllPending(browser, cookies);
    await browser.close();
    console.log('\n전체 완료 ✅ (발행된 글은 done/ 폴더에서 확인)');
  }
}

main().catch((e) => {
  console.error('치명적 오류:', e.message);
  process.exit(1);
});
