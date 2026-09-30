/**
 * 砚读 · 真路径自测（在真浏览器里跑真页面：真 www/index.html + 真 js/db.js 的 IndexedDB +
 * 真 <input type=file> 导入，不注假数据桩）。
 *
 * 为什么还要再加这一份：design/_sim-driver.js 那 11 组跑的是 _sim-stub.js 的假 DB，
 * 「导入」这一步压根没走过（驱动是直接 addBook 进库的）；design/phone-real.html 的
 * ?case=big 又只压「打开卡死」那一件事。空文件、一批里有一本失败、编码探测、
 * 长按之后点不点得动、自动翻页滚到章尾 —— 这几条正好落在两套测试中间的缝里，谁都没盖到。
 *
 * 跑（两条命令，都在仓库根目录，都要【本机】执行）：
 *   node tools/serve.js 8899
 *   node tools/cdp-run.js "http://127.0.0.1:8899/www/index.html" 4000 ACTOUT tools/selftest-cases.js
 *
 * ⚠️ 必须是 http：file:// 源没有存储权限，IndexedDB 直接不可用。
 * ⚠️ 所有动作都走真 UI（点标签 / 点行 / 点面板上的键），不直接调 app.js 内部函数 ——
 *    它藏在闭包里，也从外面调不到。判据看的是 DOM、window.__reader() 和库里的数据。
 * ⚠️ 一次导航 = 一个新的临时 Edge profile = 一个空库，用例之间共用这一份库，
 *    所以一律按「书名」认书、按「增量」认本数，不假设库是干净的。
 */
'use strict';

var log = [];
var notes = [];
var outEl = null;
var running = '';

/* 每跑完一条就把已有结果写进 #ACTOUT；再加一道 2 秒心跳 ——
   万一某一条卡住（await 永远不回来），外面用 CDP 读 #ACTOUT 就能看到
   "跑到第几条、最后完成的是哪条"，从而定位卡在哪一条，而不是干等。
   URL 上加 ?c=1,2,3 可以只跑其中几条（定位卡调用，一次别跑全表）。 */
setInterval(flush, 2000);
var ONLY = (function () {
  var m = /[?&]c=([\d,b]+)/.exec(location.search);
  return m ? m[1].split(',') : null;
})();
function shouldRun(tag) {
  return !ONLY || ONLY.some(function (x) { return tag.toUpperCase().indexOf(x.toUpperCase()) === 0; });
}
function flush() {
  if (!outEl) {
    outEl = document.getElementById('ACTOUT');
    if (!outEl) { outEl = document.createElement('pre'); outEl.id = 'ACTOUT'; document.body.appendChild(outEl); }
  }
  var rep = {
    跑到: log.length,
    正在跑: running,
    通过: log.filter(function (x) { return x.判定 === '✓'; }).length,
    未通过: log.filter(function (x) { return x.判定 !== '✓'; }).length,
    结果: log,
    备注: notes
  };
  outEl.textContent = 'ACTOUTSTART' + JSON.stringify(rep, null, 1) + 'ACTOUTEND';
  return rep;
}

/* 每条用例开始前打个点：卡住的时候一眼看出卡在哪一条 */
function start(tag) { running = tag; outEl = null; flush(); }

function rec(用例, 判定, 实测) {
  log.push({ 用例: 用例, 判定: 判定 ? '✓' : '✗ 未通过', 实测: 实测 });
  flush();
  return !!判定;
}
function note(s) { notes.push(s); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function id(x) { return document.getElementById(x); }
function q(s) { return document.querySelector(s); }
function qa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
function tap(el) {
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
}
function waitFor(cond, ms, step) {
  step = step || 120;
  return new Promise(function (resolve) {
    var t0 = Date.now();
    (function poll() {
      var v;
      try { v = cond(); } catch (e) { v = false; }
      /* ⚠️ 命中就 resolve(true)，别 resolve(Date.now()-t0)：
         第一次轮询就命中的时候耗时是 0，而 0 是假值 —— 上一版就这么把
         "秒成的条件"当成了超时，整批用例白跑（夹具坑，不是 App 的坑）。 */
      if (v) { resolve(true); return; }
      if (Date.now() - t0 > (ms || 8000)) { resolve(false); return; }
      setTimeout(poll, step);
    })();
  });
}

/* toast 是没有 id 的临时 div，只能从 body 的新增节点里捡 */
var toasts = [];
new MutationObserver(function (muts) {
  muts.forEach(function (m) {
    Array.prototype.slice.call(m.addedNodes).forEach(function (n) {
      if (n.nodeType === 1 && n.tagName === 'DIV' && !n.id) toasts.push(n.textContent);
    });
  });
}).observe(document.body, { childList: true });
function lastToast() { return toasts.length ? toasts[toasts.length - 1] : ''; }
function toastHits(re) { return toasts.filter(function (t) { return re.test(t); }); }

/* ---------------- 夹具 ---------------- */
var u8 = new TextEncoder();
function utf16leBytes(str) {
  var b = [0xFF, 0xFE];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    b.push(c & 0xFF); b.push(c >> 8);
  }
  return new Uint8Array(b);
}
/* 真 GBK 的字节流：浏览器没有 GBK 编码器，所以这份夹具是 iconv 从 UTF-8 源文本转出来
   存在 tools/fixtures/gbk.txt 里的（598 字节，反读一遍能还原成源文本，已核对）。
   四种编码的同一本书都从这一份文本派生，判据只认内容不认文件名。 */
var GBK_BUF = null;      // 运行时填：Uint8Array，真 GBK 字节
var GBK_TEXT = '';       // 运行时填：把上面那份字节按 GBK 解出来的 UTF-8 文本
function loadGbkFixture() {
  return fetch('/tools/fixtures/gbk.txt').then(function (r) {
    if (!r.ok) throw new Error('夹具取不到：/tools/fixtures/gbk.txt → ' + r.status);
    return r.arrayBuffer();
  }).then(function (buf) {
    GBK_BUF = new Uint8Array(buf);
    GBK_TEXT = new TextDecoder('gbk').decode(GBK_BUF);
    return GBK_TEXT;
  });
}

function para(i) {
  return '第' + (i + 1) + '段：这是一段占位正文，用来量渲染开销和排版效果。'
    + '砚读把一整本书读成一条很长的书页，所以每一段都刻意写得差不多长一些，'
    + '免得短到被分章那一步当成孤行并回上一章去。';
}
/* n 章、每章 p 段 */
function makeNovel(n, p) {
  var a = [];
  for (var c = 1; c <= n; c++) {
    a.push('第' + c + '章 章节' + c);
    for (var k = 0; k < p; k++) a.push(para(c * 100 + k));
  }
  return a.join('\n');
}

/* ---------------- 走真 UI 的动作 ---------------- */
function importViaUI(files) {
  var before = toasts.length;
  return DB.listBooks().then(function (b0) {
    var dt = new DataTransfer();
    files.forEach(function (f) {
      dt.items.add(new File([f.bytes], f.name, { type: 'text/plain' }));
    });
    var input = id('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return waitFor(function () { return !id('loading').classList.contains('on'); }, 20000)
      .then(function () { return sleep(300); })
      .then(function () {
        return DB.listBooks().then(function (b1) {
          return {
            新增本数: b1.length - b0.length,
            全部: b1,
            提示: toasts.slice(before).join(' ／ ')
          };
        });
      });
  });
}

function bookByTitle(list, t) {
  for (var i = 0; i < list.length; i++) if (list[i].title === t) return list[i];
  return null;
}

function openBookRow(title) {
  tap(q('.tab[data-page="list"]'));
  return waitFor(function () {
    return qa('#list-body .bk-row').some(function (r) { return r.textContent.indexOf(title) >= 0; });
  }, 8000).then(function (found) {
    if (!found) return false;
    var rows = qa('#list-body .bk-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].textContent.indexOf(title) >= 0) { tap(rows[i]); break; }
    }
    return waitFor(function () { return id('page-reader').classList.contains('active'); }, 9000)
      .then(function () { return sleep(700); });
  });
}

function backToShelf() {
  tap(id('btn-back'));
  return sleep(600);
}

/* 用真 UI 切「章节连续阅读」：设置 → 更多阅读设置 → 开/关 */
function setAutoNext(on) {
  tap(id('btn-set'));
  return sleep(300).then(function () {
    tap(id('rs-more'));
    return sleep(300);
  }).then(function () {
    var ok = tap(q('#auto-pick .pill[data-auto="' + (on ? '1' : '0') + '"]'));
    tap(id('set-mask'));
    return sleep(300).then(function () { return ok; });
  });
}

/* ---------------- 用例 ---------------- */
async function run() {
  await waitFor(function () { return window.DB && window.Parser && window.__reader && window.Shelf; }, 10000);
  await sleep(300);
  await loadGbkFixture();

  /* ===== C1 编码探测：四种字节流走同一套导入 ===== */
  var r1 = await importViaUI([
    { name: '编UTF8本', bytes: u8.encode(GBK_TEXT) },
    { name: '编BOM本', bytes: new Uint8Array([0xEF, 0xBB, 0xBF].concat(Array.prototype.slice.call(u8.encode(GBK_TEXT)))) },
    { name: '编16本', bytes: utf16leBytes(GBK_TEXT) },
    { name: '编GBK本', bytes: GBK_BUF }
  ]);
  var bad1 = [];
  ['编UTF8本', '编BOM本', '编16本', '编GBK本'].forEach(function (t) {
    var b = bookByTitle(r1.全部, t);
    if (!b) { bad1.push(t + ' 没进库'); return; }
    if (!b.toc || b.toc.length !== 4) bad1.push(t + ' 分章=' + (b.toc ? b.toc.length : 'n/a') + '（应为 4）');
    if (b.totalChars < 100) bad1.push(t + ' 字数=' + b.totalChars);
  });
  var enc = {};
  r1.全部.forEach(function (b) { if (/^编(UTF8|BOM|16|GBK)本$/.test(b.title)) enc[b.title] = b.encoding; });
  rec('C1 编码探测：UTF8/BOM/UTF-16LE/GBK 各分 4 章、字数不为零',
    bad1.length === 0 && r1.新增本数 === 4,
    { 新增: r1.新增本数, 识别到的编码: enc, 问题: bad1 });

  var gbkBook = bookByTitle(r1.全部, '编GBK本'), c1b = false, gbkDetail = {};
  if (gbkBook) {
    var t1 = await DB.getChapter(gbkBook.id, 0);
    var mojibake = String(t1).indexOf('\uFFFD') >= 0 || String(t1).indexOf('锟') >= 0;
    gbkDetail = { 首章开头: String(t1).slice(0, 20), 有乱码: mojibake };
    c1b = String(t1).indexOf('那天的风很大') === 0 && !mojibake;
  }
  rec('C1b GBK 正文解得开（第一段就该是「那天的风很大」）', c1b, gbkDetail);

  /* ===== C2 只有空白字符的文件：不该进库、更不该生成一本 0 章的书 ===== */
  var r2 = await importViaUI([{ name: '空本', bytes: u8.encode('\n\n   \n\t\n  ') }]);
  var emptyBook = bookByTitle(r2.全部, '空本');
  rec('C2 空正文不入库（也不留下 0 章的幽灵书）', !emptyBook,
    { 新增本数: r2.新增本数, 库里有这本: !!emptyBook, 它的章数: emptyBook ? emptyBook.toc.length : null, 提示: r2.提示 });
  if (emptyBook) {
    await openBookRow('空本');
    await sleep(1000);
    note('当前「空本」点开之后：正文段数=' + qa('#chapter-content p').length
      + '，页眉="' + id('reader-title').textContent + '"，章名="'
      + id('fc-title').textContent + '"，提示="' + lastToast() + '"，遮罩还开着='
      + id('loading').classList.contains('on'));
    await backToShelf();
  }

  /* ===== C3 一批三本，中间一本抛错：另外两本必须照常进库 ===== */
  var realSplit = Parser.splitChapters;
  window.Parser.splitChapters = function (text) {
    if (String(text).indexOf('BOOM') >= 0) throw new Error('模拟解析失败');
    return realSplit.apply(Parser, arguments);
  };
  var r3 = await importViaUI([
    { name: '坏前本', bytes: u8.encode(makeNovel(2, 3)) },
    { name: '坏本', bytes: u8.encode('BOOM 这本解析会抛') },
    { name: '坏后本', bytes: u8.encode(makeNovel(2, 3)) }
  ]);
  window.Parser.splitChapters = realSplit;
  rec('C3 一批里有一本失败：其余照常导入，且有汇总提示',
    !!bookByTitle(r3.全部, '坏前本') && !!bookByTitle(r3.全部, '坏后本')
      && !bookByTitle(r3.全部, '坏本') && /导入完成|成功/.test(r3.提示),
    { 坏前本进了: !!bookByTitle(r3.全部, '坏前本'), 坏后本进了: !!bookByTitle(r3.全部, '坏后本'), 提示: r3.提示 });

  /* ===== C4 关掉「章节连续阅读」：章末挂按钮，下一章不该预先挂在下面 ===== */
  await importViaUI([{ name: '手动本', bytes: u8.encode(makeNovel(6, 18)) }]);
  await openBookRow('手动本');
  var switched = await setAutoNext(false);
  await backToShelf();
  await openBookRow('手动本');
  var st = window.__reader();
  var blocksBefore = st.blocks.map(function (b) { return b.idx; });
  var btn = q('.ce-next-btn');
  rec('C4 手动模式：刚打开只挂当前章（下一章要点按钮才接上来）',
    switched && blocksBefore.length === 1 && !!btn,
    { 开关按到了: switched, 挂着哪几章: blocksBefore, 有章末按钮: !!btn, 按钮文字: btn ? btn.textContent : '无' });

  if (btn) {
    tap(btn);
    await waitFor(function () { return window.__reader().blocks.length >= 2; }, 5000);
    await sleep(500);
    var st2 = window.__reader();
    var btns = qa('.ce-next-btn');
    var newest = st2.blocks[st2.blocks.length - 1];
    rec('C4b 点「下一章」才把第二章接上来，旧卡片收掉、只剩最新那一章的',
      st2.blocks.length >= 2 && btns.length === 1
        && !!btns[0].closest('.chapter-block[data-idx="' + newest.idx + '"]'),
      { 挂着哪几章: st2.blocks.map(function (b) { return b.idx; }), 章末按钮数: btns.length, 按钮挂在: newest ? '第' + (newest.idx + 1) + '章' : 'n/a' });
  }
  await setAutoNext(true);
  await backToShelf();

  /* ===== C5 自动翻页滚到卷轴底部：要接着往下走，不该停、更不该说「已经读完了」 ===== */
  await openBookRow('手动本');
  tap(id('btn-set'));
  await sleep(300);
  tap(id('rs-auto'));
  await sleep(700);
  var el = id('reader-body');
  var before5 = window.__reader().index;
  var running5 = window.__reader().autoPage;
  /* 直接把视口推到底 = 匀速滚到底那一刻的状态，下一帧 autoTick 就会撞上「到底」 */
  el.scrollTop = el.scrollHeight - el.clientHeight;
  el.dispatchEvent(new Event('scroll'));
  await sleep(3000);
  var st5 = window.__reader();
  var pillOn = id('ap-pill').classList.contains('on');
  var doneToast = toastHits(/已经读完了/).length > 0;
  rec('C5 自动翻页到卷轴底部：接上下一章继续滚，不停下也不报「已经读完了」',
    running5 && st5.autoPage && pillOn && !doneToast && st5.index > before5,
    { 之前读到: before5 + '章', 现在读到: st5.index + '章', 开关还开着: st5.autoPage, 小胶囊还在: pillOn, 最后一条提示: lastToast() });
  tap(id('sp-exit'));
  await sleep(500);

  /* ===== C6 程序化改 scrollTop 不该被当成「人一滑」 ===== */
  var canSeePause = 'autoPaused' in window.__reader();
  if (!canSeePause) {
    note('C6 判据不可用：window.__reader() 还没暴露 autoPaused');
  } else {
    await openBookRow('手动本');
    await sleep(500);
    var el6 = id('reader-body');
    /* 一路往上滑到顶 → 触发「接上一章」→ preserve() 会自己写 scrollTop，全程没有人为滚动 */
    el6.scrollTop = 0;
    el6.dispatchEvent(new Event('scroll'));
    await sleep(1800);
    var paused = window.__reader().autoPaused;
    rec('C6 没人滑的时候不该进「让位暂停」（程序化滚动不算人滑）', !paused,
      { 上滑接章之后暂停标志: paused, 挂着哪几章: window.__reader().blocks.map(function (b) { return b.idx; }) });
    await backToShelf();
  }

  /* ===== C7 搜索词按纯文本处理，不拼进 innerHTML ===== */
  var si = id('search-input');
  si.value = '<b id=zzz>不存在</b>';
  si.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(600);
  var injected = !!id('zzz');
  var shown = id('list-empty').textContent;
  rec('C7 搜索词原样显示，不当 HTML 解析',
    !injected && shown.indexOf('<b id=zzz>') >= 0,
    { 被解析成元素了: injected, 空状态文案: shown.slice(0, 46) });
  si.value = '';
  si.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);

  /* ===== C8 长按拿书之后，下一次点书得真的能打开 ===== */
  var manualBook = bookByTitle(await DB.listBooks(), '手动本');
  if (manualBook) {
    await DB.setSlot('s0', [manualBook.id]);
    tap(q('.tab[data-page="shelf"]'));
    await waitFor(function () { return qa('#shelf-stage .bk').length >= 1; }, 6000);
    var g0 = qa('#shelf-stage .bk')[0];
    if (!g0) {
      note('C8 跳过了：架子上摆不出书');
    } else {
      var brect = g0.getBoundingClientRect();
      var pt = { bubbles: true, clientX: brect.left + brect.width / 2, clientY: brect.top + brect.height / 2, pointerId: 1 };
      g0.dispatchEvent(new PointerEvent('pointerdown', pt));
      await sleep(800);                     // 550ms 的长按已经触发；手指没在原地松开 → 浏览器不会补发 click
      var confirmOpen = id('sheet-confirm').classList.contains('open');
      tap(id('confirm-no'));
      await sleep(300);
      /* 再做一次完整的"点"：按下 → 抬起 → click */
      var g1 = qa('#shelf-stage .bk')[0] || g0;
      var r1b = g1.getBoundingClientRect();
      var pt2 = { bubbles: true, clientX: r1b.left + r1b.width / 2, clientY: r1b.top + r1b.height / 2, pointerId: 2 };
      g1.dispatchEvent(new PointerEvent('pointerdown', pt2));
      g1.dispatchEvent(new PointerEvent('pointerup', pt2));
      g1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: pt2.clientX, clientY: pt2.clientY }));
      var opened8 = await waitFor(function () { return id('page-reader').classList.contains('active'); }, 3000);
      rec('C8 长按拿书之后，第一次点书不被吞掉', !!opened8,
        { 长按弹了确认: confirmOpen, 紧接着这次点击打开了吗: !!opened8 });
      if (opened8) await backToShelf();
    }
  } else note('C8 跳过了：没有「手动本」可摆');

  /* ===== C9 分章：正文里的编号不许抢走「第X章」；真按 1. 2. 3. 排的书还得能认 ===== */
  var withLists = '';
  for (var i = 1; i <= 8; i++) {
    withLists += '第' + i + '章 标题' + i + '\n' + para(i * 10 + 1) + '\n' + para(i * 10 + 2) + '\n';
    for (var j = 1; j <= 4; j++) withLists += j + '. 正文里的一条编号，不该被当成章标题\n';
  }
  var c9a = Parser.splitChapters(withLists);
  var dotNovel = '';
  for (var d = 1; d <= 60; d++) dotNovel += d + '. 第' + d + '节内容\n' + para(d * 3) + '\n' + para(d * 3 + 1) + '\n';
  var c9b = Parser.splitChapters(dotNovel);
  var fat = '楔子\n' + new Array(3000).join('这一段很长很长，专门用来把单章撑过八千字的上限。') + '\n';
  var c9c = Parser.splitChapters(fat);
  var longest = c9c.reduce(function (m, c) { return Math.max(m, c.text.length); }, 0);
  rec('C9 分章三条规矩：编号正文不抢章 / 真编号书认得出 / 超长单章再切小',
    c9a.length === 8 && /^第1章/.test(c9a[0].title) && c9b.length === 60 && /^1\./.test(c9b[0].title)
      && c9c.length >= 3 && longest <= 8000,
    { 八章带编号的书切成: c9a.length + '章', 首条标题: c9a[0] && c9a[0].title, 纯编号书切成: c9b.length + '章', 超长单章切成: c9c.length + '块', 最长一块字数: longest });

  /* ===== C10 真库进度：滚到深处 → 退出 → 重开，位置接得上 ===== */
  await importViaUI([{ name: '进度本', bytes: u8.encode(makeNovel(12, 40)) }]);
  var b10 = bookByTitle(await DB.listBooks(), '进度本');
  await openBookRow('进度本');
  var el10 = id('reader-body');
  el10.scrollTop = 2400;
  el10.dispatchEvent(new Event('scroll'));
  await sleep(1400);                        // saveProgress 有 400ms 防抖
  var idxA = window.__reader().index;
  await backToShelf();
  await openBookRow('进度本');
  await sleep(1500);
  var st10 = window.__reader();
  var p10 = b10 ? await DB.getProgress(b10.id) : null;
  rec('C10 真库读完退出再打开，接得上同一章、同一处',
    !!p10 && st10.index === idxA && Math.abs(el10.scrollTop - 2400) < 400,
    { 滚到: 2400, 库里存的是: p10 ? { 章: p10.index, 章内px: Math.round(p10.scrollY) } : null, 重开读到: st10.index + '章', 重开位置: Math.round(el10.scrollTop) });
  await backToShelf();

  /* ===== C11 整轮跑下来不许有未捕获错误 ===== */
  rec('C11 全程没有未捕获的报错', window.__errs.length === 0, window.__errs.slice(0, 6));

  return {
    通过: log.filter(function (x) { return x.判定 === '✓'; }).length,
    未通过: log.filter(function (x) { return x.判定 !== '✓'; }).length,
    结果: log,
    备注: notes
  };
}

window.__errs = [];
window.addEventListener('error', function (e) { window.__errs.push(String(e && e.message)); });
window.addEventListener('unhandledrejection', function (e) {
  window.__errs.push('Promise: ' + String((e && e.reason && (e.reason.message || e.reason)) || 'unknown'));
});

return run().then(function (rep) {
  var pre = id('ACTOUT');
  if (!pre) { pre = document.createElement('pre'); pre.id = 'ACTOUT'; document.body.appendChild(pre); }
  pre.textContent = 'ACTOUTSTART' + JSON.stringify(rep, null, 1) + 'ACTOUTEND';
  return rep;
}).catch(function (e) {
  var pre = id('ACTOUT');
  if (!pre) { pre = document.createElement('pre'); pre.id = 'ACTOUT'; document.body.appendChild(pre); }
  pre.textContent = 'ACTOUTSTART' + JSON.stringify({ 测试脚本自己崩了: String(e && e.stack || e), 已记录: log, 备注: notes }, null, 1) + 'ACTOUTEND';
  return { 测试脚本自己崩了: String(e && e.message || e) };
});
