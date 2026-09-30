/**
 * 真库验收：**用一本超大章节的书，量打开到底要多久、主线程有没有被占死。**
 *
 * 为什么走真库 + http：CDP 直连 file:// 时 IndexedDB 不可用，
 * 而"打开卡死"恰恰只在真库那条路上出现。
 *
 * 造的书：第一章 20000 段（约 72 万字，就是那种没切开的天书），
 *         并且把进度设成"读到很深处"，逼它去还原一个很远的位置 ——
 *         这正是以前"一直停在正在排版正文"的场景。
 *
 * 判据（缺一条就算没修好）：
 *   ① 遮罩要在 2 秒内收掉（不再等排完那 20000 段）
 *   ② 打开期间主线程还在跳（心跳次数 > 20）—— 没被同步任务独占
 *   ③ 最终位置落在上次读的地方附近（续排把它推过去了）
 *
 * 跑：node tools/serve.js 8899
 *     node tools/cdp-run.js "http://127.0.0.1:8899/design/phone-real.html?case=big" 40000
 */
(function () {
  var q = new URLSearchParams(location.search);
  if (q.get('case') !== 'big') return;

  var out = [];
  window.onerror = function (m, s, l) { out.push('报错 ' + m + ' @' + l); };
  function dump() {
    var pre = document.createElement('pre');
    pre.id = 'ACTOUT';
    pre.textContent = 'ACTOUTSTART' + JSON.stringify(out, null, 1) + 'ACTOUTEND';
    document.body.appendChild(pre);
  }
  function para(i) {
    return '第' + (i + 1) + '段：这是一段用来撑开正文的模拟文字，'
      + '长度刻意做成中等偏长，好让排版工作量接近真实的小说章节。'
      + '窗外雨还在下，他把灯拧亮了一点，翻过这一页继续往下读。';
  }
  function makeChapter(n, title) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(para(i));
    return { t: title, text: a.join('\n') };
  }

  var STEP = 'bigDone';
  var stage = '';
  try { stage = sessionStorage.getItem(STEP) || ''; } catch (e) { }

  /* ---------- 第一次：造书 + 存一个很深的进度，然后重开 ---------- */
  if (stage !== 'book') {
    try { sessionStorage.setItem(STEP, 'book'); } catch (e) { }

    var N = +(q.get('n') || 20000);
    var ch0 = makeChapter(N, '大第一章');
    var ch1 = makeChapter(300, '第二章');
    var book = {
      id: 'bigbook', title: '天书·没切开的大章',
      totalChars: ch0.text.length + ch1.text.length,
      encoding: 'utf-8', addedAt: Date.now(),
      toc: [{ t: ch0.t, len: ch0.text.length }, { t: ch1.t, len: ch1.text.length }]
    };

    /* ⚠️ 真库是持久的：上一轮测试点开过的开关会留在这儿。
       自动翻页开着的话它会一路往下滚，把测量结果全带偏 —— 先关掉。 */
    DB.setSetting('autoPage', false)
      .then(function () {
        return DB.addBook(book);
      })
      .then(function () {
        return DB.putChapters(book.id, [{ text: ch0.text }, { text: ch1.text }]);
      })
      .then(function () {
        /* 进度：第 0 章、读到第 8000 段那么深（≈ 300000px 往下） */
        return DB.setProgress({
          bookId: book.id, index: 0, scrollY: 300000, mark: null, updatedAt: Date.now()
        });
      })
      .then(function () { location.reload(); })
      .catch(function (e) { out.push({ 阶段: '造书失败', 原因: String(e && e.message || e) }); dump(); });
    return;
  }

  /* ---------- 第二次：真正的打开 ---------- */
  setTimeout(function () {
    document.querySelector('.tab[data-page="list"]').click();
    setTimeout(function () {
      var rows = document.querySelectorAll('#list-body .bk-row');
      var row = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].textContent.indexOf('天书') >= 0) { row = rows[i]; break; }
      }
      row = row || rows[0];

      var beats = 0, running = true;
      var hb = setInterval(function () { if (running) beats++; }, 100);

      var t0 = Date.now();
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      var openMs = -1;
      (function poll() {
        var on = document.getElementById('loading').classList.contains('on');
        if (!on) {
          openMs = Date.now() - t0;
          out.push({
            阶段: '遮罩收掉',
            耗时ms: openMs,
            判定: openMs <= 2000 ? '正常（没等排版）' : '✗ 太久，还是在等排版',
            那时已排出多少段: document.querySelectorAll('#chapter-content p').length
          });
          return;
        }
        if (Date.now() - t0 > 15000) {
          openMs = Date.now() - t0;
          out.push({
            阶段: '✗ 15 秒了遮罩还没收',
            遮罩上的字: (document.getElementById('loading-text') || {}).textContent,
            已排出多少段: document.querySelectorAll('#chapter-content p').length
          });
          return;
        }
        setTimeout(poll, 50);
      })();

      /* 每 400ms 采一次：看段数和 scrollTop 是怎么爬的 */
      var samples = [];
      var sampler = setInterval(function () {
        var e2 = document.getElementById('reader-body');
        var rr = window.__reader ? window.__reader() : {};
        samples.push(
          document.querySelectorAll('#chapter-content p').length + '段/' + Math.round(e2.scrollTop)
          + ' 欠=' + JSON.stringify(rr.pendingWant) + ' 续排=' + rr.filling + ' 容器=' + (function(){var e=document.getElementById('reader-body'),c=document.getElementById('chapter-content');return 'body '+e.clientHeight+'/'+e.scrollHeight+' content '+c.offsetHeight+' 溢出='+getComputedStyle(e).overflowY;})()
        );
      }, 400);

      /* 打开之后再等 6 秒，看续排有没有把位置推到目标 */
      setTimeout(function () {
        running = false;
        clearInterval(hb);
        clearInterval(sampler);
        var el = document.getElementById('reader-body');
        var r = window.__reader ? window.__reader() : {};
        var blk = r.blocks && r.blocks[0] ? r.blocks[0] : null;
        out.push({
          阶段: '打开 6 秒之后',
          心跳次数: beats,
          主线程没被占死: beats > 20,
          当前章: r.index,
          挂着几章: r.blocks ? r.blocks.map(function (b) { return b.idx; }) : 'n/a',
          本章已排出段数: blk ? blk.shown : 'n/a',
          DOM里段数: document.querySelectorAll('#chapter-content p').length,
          scrollTop: Math.round(el.scrollTop),
          目标位置: 300000,
          落到位了吗: Math.abs(el.scrollTop - 300000) < 400,
          遮罩还开着吗: document.getElementById('loading').classList.contains('on'),
          采样_段数斜杠scrollTop: samples,
          页面报错: out.filter(function (x) { return typeof x === 'string'; })
        });
        /* 再等 3 秒，确认段数不再涨（续排已经收尾，不会一直跑） */
        var before = document.querySelectorAll('#chapter-content p').length;
        setTimeout(function () {
          out.push({
            阶段: '再等 3 秒',
            段数: before + ' → ' + document.querySelectorAll('#chapter-content p').length,
            续排停了: document.querySelectorAll('#chapter-content p').length === before
          });
          dump();
        }, 3000);
      }, 6500);
    }, 900);
  }, 1200);
})();
