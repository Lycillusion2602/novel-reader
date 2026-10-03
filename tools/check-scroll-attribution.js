/**
 * 滚动归因守卫 —— 静态检查：写了阅读视口的 scrollTop，有没有紧接着登记 markProgScroll()。
 *   node tools/check-scroll-attribution.js
 *
 * 为什么要这么一条规矩（详见 README §4.18）：
 *   自动翻页要靠 looksProgrammatic() 分辨"这次 scroll 是我们自己推的还是人滑的"，
 *   它唯一的凭据就是 progTop —— 上一次**我们写出去**的位置。写入点漏登记，
 *   那一下就被算成"用户在滑"，症状是自动翻页莫名其妙让位、收下去的栏又抖出来；
 *   凭空多登记，真正的用户滑动会被吞掉。两头都不报错、不影响功能跑通，
 *   只有跑测试才勉强逮得住。所以宁可在改代码的当场就拦下来。
 *
 * 它做四件事：
 *   1. 在 www/js/*.js 里找出对 scrollTop 的**写入**（= 和 +=）；读取、比较、注释里出现的不算；
 *   2. 分清写的是哪个元素：readerEl() 那个视口要管；别的滚动容器（#toc-list）不该管，
 *      硬要求它们登记反而会写出没意义的调用。认不出来源的一律按"要管"从严处理 ——
 *      新代码想放行，就得把元素来源写清楚，或者把它加进下面的可识别路径。
 *   3. 写入之后（同一句里，或紧随其后的 8 行内）必须出现 markProgScroll()；
 *      中间不许先有 return/throw —— 免得把登记写在与 return 同一句的后面，成死代码。
 *   4. 自带控制组：拿几段合成源码喂给同一个扫描器，逐条要求"该过的过、该报的报"。
 *      守卫这种东西，平时只会打 ✓，恰恰是最没用的时候；控制组让它坏掉的那天会自己叫。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KEY = '.scrollTop';
const MARK = 'markProgScroll';
const WINDOW_LINES = 8;          // 写入之后最多隔几行还认（中间只允许注释/空行）

/* ------------------------------------------------------------------ *
 * 1. 把注释挖空，只在真代码上判断
 *    字符串保持原样：#toc-list 这类元素名就藏在字符串里，得留着认来源。
 * ------------------------------------------------------------------ */
function blankComments(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2; out[i - 2] = ' '; out[i - 1] = ' ';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { if (src[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
        if (q !== '`' && src[i] === '\n') break;      // 单双引号不许跨行，遇到就停
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/* 从 .scrollTop 向左把整条接收者表达式吃回来：
   el / readerEl() / $('toc-list') / a.b.c —— 括号配平，字符串整段跳过。 */
function readReceiver(code, pos) {
  let k = pos;
  while (k > 0 && /\s/.test(code[k - 1])) k--;
  const end = k;
  let depth = 0;
  while (k > 0) {
    const c = code[k - 1];
    if (c === ')') { depth++; k--; continue; }
    if (c === '(') { if (!depth) break; depth--; k--; continue; }
    if (/[\w$.]/.test(c)) { k--; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let h = k - 1;
      while (h > 0 && code[h - 1] !== q) h--;
      if (h === 0) break;                             // 找不到配对的引号，别硬吃
      k = h - 1;
      continue;
    }
    break;
  }
  const text = code.slice(k, end).trim();
  return { text: text, ok: depth === 0 && text.length > 0 };
}

/* ------------------------------------------------------------------ *
 * 2. 作用域：算出每个 function 的字符区间，好在里面找 var X = ...
 * ------------------------------------------------------------------ */
function functionRanges(code) {
  const ranges = [];
  let i = 0;
  while ((i = code.indexOf('function', i)) !== -1) {
    let j = code.indexOf('{', i);
    if (j === -1) break;
    let d = 0, k = j;
    for (; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (!d) break; }
    }
    ranges.push({ start: j, end: Math.min(k, code.length - 1) });
    i = j + 1;
  }
  return ranges;
}

/* 由内向外找 var NAME = <初始化表达式>；找不到给 null。 */
function lookupDecl(name, code, ranges) {
  const re = new RegExp('var\\s+' + name + '\\s*=\\s*([^;\n]*)');
  for (const r of ranges) {
    const m = re.exec(code.slice(r.start, r.end));
    if (m) return m[1].trim();
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 3. 分类：这次写入归不归我们管
 * ------------------------------------------------------------------ */
function classify(recv, code, ranges) {
  if (!recv.ok) return { kind: 'unknown', why: '表达式没吃全：' + recv.text };
  if (/\breaderEl\b/.test(recv.text)) {
    return { kind: 'reader', why: recv.text + ' 直接来自 readerEl()' };
  }
  let m = /^\$\(\s*['"]([^'"]+)['"]\s*\)$/.exec(recv.text);
  if (m) return { kind: 'container', why: '写的是 #' + m[1] };
  const root = /^([A-Za-z_$][\w$]*)/.exec(recv.text);
  if (!root) return { kind: 'unknown', why: '认不出根：' + recv.text };
  const decl = lookupDecl(root[1], code, ranges);
  if (decl) {
    if (/readerEl\s*\(/.test(decl)) return { kind: 'reader', why: 'var ' + root[1] + ' = ' + decl };
    const mm = /\$\(\s*['"]([^'"]+)['"]\s*\)|querySelector\(\s*['"]([^'"]+)['"]/.exec(decl);
    if (mm) return { kind: 'container', why: 'var ' + root[1] + ' → ' + (mm[1] ? '#' + mm[1] : mm[2]) };
    return { kind: 'unknown', why: 'var ' + root[1] + ' = ' + decl + '（看不出是哪个元素）' };
  }
  return { kind: 'unknown', why: '变量 ' + root[1] + ' 没有本作用域的 var 赋值，看不出来源' };
}

/* ------------------------------------------------------------------ *
 * 4. 扫描一个源码串，返回 { writes, violations, containers }
 * ------------------------------------------------------------------ */
function scan(src, tag) {
  const code = blankComments(src);
  const rangesAll = functionRanges(code);
  const lines = code.split('\n');
  const lineStart = [];
  {
    let acc = 0;
    for (const L of lines) { lineStart.push(acc); acc += L.length + 1; }
  }
  const lineOf = (idx) => {
    let lo = 0, hi = lineStart.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo;                                   // 0-based 行号
  };

  const writes = [], containers = [], violations = [];
  let i = 0;
  while ((i = code.indexOf(KEY, i)) !== -1) {
    const recv = readReceiver(code, i);
    let j = i + KEY.length;
    while (j < code.length && /\s/.test(code[j])) j++;
    let op = '';
    if (code[j] === '+' && code[j + 1] === '=') op = '+=';
    else if (code[j] === '=' && code[j + 1] !== '=') op = '=';
    if (op) {
      const ln = lineOf(i);
      const enclosing = rangesAll
        .filter((r) => r.start <= i && i <= r.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start));
      const cls = classify(recv, code, enclosing);
      const site = { tag: tag, line: ln + 1, recv: recv.text, op: op, kind: cls.kind, why: cls.why };
      if (cls.kind === 'container') {
        containers.push(site);
      } else {
        writes.push(site);
        const bad = markedAfter(code, lines, lineStart, ln, i);
        if (bad) { site.why2 = bad; violations.push(site); }
      }
    }
    i += KEY.length;
  }
  return { writes: writes, violations: violations, containers: containers };
}

/* 写入之后有没有紧跟登记。返回 '' 表示没问题，否则返回为什么算漏。 */
function markedAfter(code, lines, lineStart, ln, at) {
  const lineEnd = (lines[ln] || '').length + lineStart[ln];
  const hay = [];
  hay.push({ text: code.slice(at + KEY.length, lineEnd), from: at });
  for (let k = 1; k <= WINDOW_LINES; k++) {
    const L = ln + k;
    if (L >= lines.length) break;
    hay.push({ text: lines[L], from: lineStart[L] });
  }
  let markAt = -1, stopAt = -1, stopWhy = '';
  let acc = 0;
  for (const seg of hay) {
    const mk = seg.text.search(new RegExp('\\b' + MARK + '\\s*\\('));
    if (mk >= 0 && markAt < 0) markAt = acc + mk;
    const rt = seg.text.search(/\b(return|throw)\b/);
    if (rt >= 0 && stopAt < 0) { stopAt = acc + rt; stopWhy = seg.text.slice(rt).split('\n')[0].trim(); }
    acc += seg.text.length + 1;
  }
  if (markAt < 0) return '往后 ' + WINDOW_LINES + ' 行内没有 ' + MARK + '()';
  if (stopAt >= 0 && stopAt < markAt) return '登记排在 ' + stopWhy + ' 后面，够不着';
  return '';
}

/* ------------------------------------------------------------------ *
 * 5. 控制组：守卫必须在该报的时候报出来
 * ------------------------------------------------------------------ */
const FIXTURES = [
  {
    name: 'A 写了也登记了 → 该过',
    src: "function moveTo(y){var el=readerEl();el.scrollTop=y;markProgScroll();}",
    wantWrites: 1, wantViolations: 0
  },
  {
    name: 'B 同句里连着登记 → 该过',
    src: "function moveTo(y){var el=readerEl();if(1){el.scrollTop=y;markProgScroll();return;}}",
    wantWrites: 1, wantViolations: 0
  },
  {
    name: 'C 漏登记 → 该报',
    src: "function moveTo(y){var el=readerEl();el.scrollTop=y;repaint();}",
    wantWrites: 1, wantViolations: 1
  },
  {
    name: 'D 隔太远才登记（比窗口还多 ' + 3 + ' 行）→ 该报，证明窗口真的有限',
    src: "function f(y){var el=readerEl();el.scrollTop=y;\n" +
      Array.from({ length: WINDOW_LINES + 3 }, (_, k) => 'var v' + k + '=1;').join('\n') +
      "\nmarkProgScroll();}",
    wantWrites: 1, wantViolations: 1
  },
  {
    name: 'E 登记排在 return 同一句后面 → 该报，那是死代码',
    src: "function f(y){var el=readerEl();el.scrollTop=y;return;markProgScroll();}",
    wantWrites: 1, wantViolations: 1
  },
  {
    name: 'F 别的滚动容器 → 不该管，也不该报',
    src: "function r(){var list=$('toc-list');list.scrollTop=0;$('toc-list').scrollTop=0;}",
    wantWrites: 0, wantViolations: 0
  },
  {
    name: 'G 读取和比较 → 不该被当成写入',
    src: "function q(){var el=readerEl();var a=el.scrollTop;if(el.scrollTop===0)return el.scrollTop!=3;}",
    wantWrites: 0, wantViolations: 0
  },
  {
    name: 'H 注释里写的 scrollTop = 不算，+= 才算',
    src: "/* el.scrollTop = 5; 这里没登记 */\nfunction h(){var el=readerEl();el.scrollTop=9;markProgScroll();el.scrollTop+=1;}",
    wantWrites: 2, wantViolations: 1
  },
  {
    name: 'I 认不出来源的元素 → 从严，照样要登记（这条故意不给登记）',
    src: "function u(y){viewport.scrollTop=y;}",
    wantWrites: 1, wantViolations: 1
  }
];

function runFixtures() {
  const fails = [];
  for (const fx of FIXTURES) {
    const got = scan(fx.src, fx.name);
    if (got.writes.length !== fx.wantWrites || got.violations.length !== fx.wantViolations) {
      fails.push(fx.name + '\n      期望 写入' + fx.wantWrites + '/漏' + fx.wantViolations +
        '，实得 写入' + got.writes.length + '/漏' + got.violations.length);
    }
  }
  return fails;
}

/* ------------------------------------------------------------------ *
 * 跑
 * ------------------------------------------------------------------ */
function main() {
  const dir = path.join(__dirname, '..', 'www', 'js');
  const files = fs.readdirSync(dir).filter((f) => /\.js$/.test(f)).sort();
  let allWrites = [], allViolations = [], allContainers = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const r = scan(src, 'www/js/' + f);
    allWrites = allWrites.concat(r.writes);
    allViolations = allViolations.concat(r.violations);
    allContainers = allContainers.concat(r.containers);
  }

  console.log('【控制组】守卫自己先过一遍：' + FIXTURES.length + ' 段合成源码');
  const fx = runFixtures();
  if (fx.length) {
    console.log('  ✗ 守卫失灵，下面这些用例结果不对 —— 先修守卫，别信它报的任何数：');
    fx.forEach((s) => console.log('      · ' + s));
    process.exit(1);
  }
  console.log('  ✓ 该过的都过了、该报的都报了（漏登记 / 隔太远 / 死代码 / 误判写入 四种都能抓到）\n');

  console.log('【真源码】' + files.join(' · '));
  console.log('  归它管的 scrollTop 写入：' + allWrites.length + ' 处');
  allWrites.forEach((w) => {
    const bad = allViolations.indexOf(w) >= 0;
    console.log('    ' + (bad ? '✗' : '✓') + ' ' + w.tag + ':' + w.line +
      '  ' + w.recv + '.scrollTop ' + w.op + '   ' + w.why + (bad ? '   ← ' + w.why2 : ''));
  });
  if (allContainers.length) {
    console.log('  不归它管的其它容器（写的是目录列表之类，本来就不该登记）：' + allContainers.length + ' 处');
    allContainers.forEach((c) => console.log('    · ' + c.tag + ':' + c.line + '  ' + c.recv + '.scrollTop   ' + c.why));
  }

  const unknown = allWrites.filter((w) => w.kind === 'unknown');
  if (unknown.length) {
    console.log('  ⚠ 有 ' + unknown.length + ' 处认不出元素来源，按"要管"从严处理了：' +
      unknown.map((w) => w.tag + ':' + w.line).join('、'));
    console.log('    想让它闭嘴就把元素写成 readerEl() / $(id) 这种可追溯的形式，别加绕过开关。');
  }

  if (allViolations.length) {
    console.log('\n✗ ' + allViolations.length + ' 处写入没登记，自动翻页的"让位"判断会不准。');
    console.log('  补法：写完 scrollTop 立刻 markProgScroll()（回读落在哪就登记哪，越界被夹住的值要以回读为准）。');
    process.exit(1);
  }
  console.log('\n✓ 每个归它管的 scrollTop 写入后面都跟着 ' + MARK + '()。');
}

if (require.main === module) main();
module.exports = { scan: scan, blankComments: blankComments, FIXTURES: FIXTURES };
