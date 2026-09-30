/**
 * 手机模拟器的驱动脚本（由 tools/build-phone-sim.js 注入，跑在 app.js 之后）
 *   ?edit=1   进编辑态
 *   ?page=list 切到列表页
 *   ?dbg=1    把量到的尺寸塞进 <pre id="DBGOUT">，配合 msedge --dump-dom 读
 *   ?act=edit 脚本化点一遍「编辑 → 点格子 → 加一本」，结果塞进 <pre id="ACTOUT">
 *   ?act=roll 连续卷轴的八项验收（必须配 cdp-run.js 跑，见 README 3.1）
 *
 * headless 浏览器上跑不了真手指，所以用这个来验交互有没有断。
 */
(function () {
  var q = new URLSearchParams(location.search);
  function $(s) { return document.querySelector(s); }

  /* ?repro=page|ar|all：故意把新特性关掉，用来复现「老 WebView 上会变成什么样」。
     page = 装作 inset 不生效（页面收缩到内容大小、浮层跑到视口外）
     ar   = 装作 aspect-ratio 不生效（架子高度塌成 0，靠 JS 兜底救回来）
     all  = 两个都关（就是她那台机器的状态） */
  var repro = q.get('repro');
  if (repro) {
    var css = '';
    if (repro === 'page' || repro === 'all') {
      css += '.page,.sheet,.drawer{top:auto;right:auto;bottom:auto;left:auto;width:auto;height:auto}';
    }
    if (repro === 'ar' || repro === 'all') {
      css += '.shelf-canvas{aspect-ratio:auto;height:0}';
    }
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ?narrow=1：把书名那一列捏窄到 110px，用来在宽窗口里也能试出「放不下 → 滚动」 */
  if (q.get('narrow') === '1') {
    var st2 = document.createElement('style');
    st2.textContent = '#roster-list .pick-name, #list-body .bk-name { max-width: 110px; }';
    document.head.appendChild(st2);
  }

  function measure() {
    var r = function (el) {
      if (!el) return null;
      var b = el.getBoundingClientRect();
      return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
    };
    return {
      vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio,
      docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight,
      pageShelf: r($('#page-shelf')),
      head: r($('.shelf-head')),
      stage: r($('.shelf-stage')),
      canvas: r($('.shelf-canvas')),
      svg: r($('.shelf-canvas svg')),
      tip: r($('#shelf-tip')),
      editbar: r($('#edit-bar')),
      tabbar: r($('#tabbar')),
      addSvg: r($('.tab-add svg')),
      tabs: [].map.call(document.querySelectorAll('.tab'), function (t) {
        return t.getAttribute('data-page') + ':' + JSON.stringify(r(t));
      })
    };
  }

  function dump(id, body) {
    var pre = document.getElementById(id) || document.createElement('pre');
    pre.id = id;
    pre.textContent = id + 'START' + JSON.stringify(body, null, 1) + id + 'END';
    if (!pre.parentNode) document.body.appendChild(pre);
  }

  setTimeout(function () {
    if (q.get('edit') === '1') $('#btn-edit').click();
    if (q.get('roster') === '1') $('#btn-roster').click();
    if (q.get('page') === 'list') $('.tab[data-page="list"]').click();

    if (q.get('dbg') === '1') {
      setTimeout(function () { dump('DBGOUT', measure()); }, 400);
    }

    if (q.get('act') === 'fill') {
      var log2 = [];
      setTimeout(function () {
        $('#btn-edit').click();
        setTimeout(function () {
          $('#btn-fill').click();
          setTimeout(function () {
            window.DB.getSlots().then(function (s) {
              var total = 0;
              log2.push({ 摆位: s, 上架总数: Object.keys(s).reduce(function (a, k) { return a + s[k].length; }, 0) });
              log2.push({ 架子上的书: $('#shelf-stage').querySelectorAll('.bk').length,
                          提示: $('#shelf-tip').textContent, 副标题: $('#shelf-sub').textContent });
              dump('ACTOUT', log2);
            });
          }, 500);
        }, 400);
      }, 400);
    }

    if (q.get('act') === 'read') {
      // 量「从列表点一本书 → 阅读页真的能看」这一路要多久、有没有卡住
      var log3 = [];
      var errs = [];
      window.onerror = function (msg, src, line) { errs.push(msg + ' @' + line); };
      setTimeout(function () {
        $('.tab[data-page="list"]').click();
        setTimeout(function () {
          var row = document.querySelector('#list-body .bk-row');
          if (!row) { log3.push('列表里没有书行，测试做不了'); dump('ACTOUT', log3); return; }
          var t0 = performance.now();
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          var poll = setInterval(function () {
            var loading = $('#loading').classList.contains('on');
            var readerOn = $('#page-reader').classList.contains('active');
            if (!loading && readerOn) {
              clearInterval(poll);
              var ms = Math.round(performance.now() - t0);
              log3.push({
                打开耗时ms: ms,
                阅读页显示: true,
                残留loading遮罩: false,
                章节标题: $('.chapter-block .chapter-title').textContent,
                页眉: $('#reader-title').textContent,
                正文段数: $('#chapter-content p').length,
                目录条数: $('#toc-list').children.length,
                阅读区可滚动: (function () {
                  var el = $('#reader-body');
                  return { 高: el.clientHeight, 内容高: el.scrollHeight, 可滚: el.scrollHeight > el.clientHeight + 2 };
                })(),
                /* ↓ 2026-09-18 那轮改完加的量：上下栏是不是真的浮起来了、
                   字号/字体有没有落到 <p>、主题是不是只挂在阅读页 */
                上下栏: (function () {
                  function R(sel) {
                    var e = $(sel); if (!e) return 'n/a';
                    var b = e.getBoundingClientRect();
                    return [b.top, b.height].map(Math.round).join('/');
                  }
                  return {
                    head位置: R('.reader-head') + ' pos=' + getComputedStyle($('.reader-head')).position,
                    foot位置: R('.reader-foot') + ' pos=' + getComputedStyle($('.reader-foot')).position,
                    body: R('#reader-body'),
                    bodyPadding: getComputedStyle($('#reader-body')).paddingTop + ' / ' +
                                 getComputedStyle($('#reader-body')).paddingBottom
                  };
                })(),
                正文字号: (function () {
                  var p = $('#chapter-content p');
                  return p ? getComputedStyle(p).fontSize : '没有正文';
                })(),
                正文字体: (function () {
                  var p = $('#chapter-content p');
                  return p ? getComputedStyle(p).fontFamily.slice(0, 40) : '没有正文';
                })(),
                主题: {
                  html: document.documentElement.getAttribute('data-theme'),
                  reader: $('#page-reader').getAttribute('data-theme'),
                  书架背景: getComputedStyle($('#page-shelf')).backgroundColor,
                  阅读页背景: getComputedStyle($('#page-reader')).backgroundColor,
                  亮度遮罩: getComputedStyle($('#dim')).opacity
                },
                底部导航是否收起了: $('#tabbar').style.display === 'none',
                页面报错: errs
              });
              dump('ACTOUT', log3);

              /* 改一遍设置，看有没有真的落到正文上：
                 A+ 两下（18→22）、切成宋体、切黑主题 */
              $('#fs-plus').click();
              $('#fs-plus').click();
              $('#font-pick .pill[data-font="serif"]').click();
              $('#theme-pick .dot[data-theme="dark"]').click();
              var p2 = $('#chapter-content p');
              log3.push({
                改设置后: {
                  字号: p2 ? getComputedStyle(p2).fontSize : 'n/a',
                  字体: p2 ? getComputedStyle(p2).fontFamily.slice(0, 40) : 'n/a',
                  字距: p2 ? getComputedStyle(p2).letterSpacing : 'n/a',
                  标题字体: getComputedStyle($('.chapter-block .chapter-title')).fontFamily.slice(0, 40),
                  阅读页背景: getComputedStyle($('#page-reader')).backgroundColor,
                  书架背景: getComputedStyle($('#page-shelf')).backgroundColor
                }
              });
              dump('ACTOUT', log3);
              // 再验一下「滑到底会自动补下一批段落」
              var rb = $('#reader-body');
              var before = (window.__reader() || { blocks: [] }).blocks.length;
              rb.scrollTop = rb.scrollHeight;
              rb.dispatchEvent(new Event('scroll'));
              setTimeout(function () {
                log3.push({
                /* 连续卷轴之后，"滑到底会追加段落"这个判据作废了：
                   段是按需要补的，短章一开场就画完了。该验的是
                   「滑到底之后下一章被接上来了没有」。 */
                滑到底前挂着几章: before,
                滑到底后挂着几章: (window.__reader() || { blocks: [] }).blocks.length,
                /* 现在打开书就会把前后邻居预挂上（ensureNeighbors），
                   "滑到底又多了几章"不再是判据 —— 改成"至少挂着 2 章"。 */
                挂着至少两章: (window.__reader() || { blocks: [] }).blocks.length >= 2,   // 打开时就预挂了前后邻居
                内容高: rb.scrollHeight
                });
                dump('ACTOUT', log3);
              }, 250);
            }
          }, 60);
          setTimeout(function () {           // 8 秒还没好，就把卡住的样子记下来
            clearInterval(poll);
            if (log3.length) return;
            log3.push({
              打开耗时ms: '超过 8000 仍未完成',
              阅读页显示: $('#page-reader').classList.contains('active'),
              残留loading遮罩: $('#loading').classList.contains('on'),
              正文段数: $('#chapter-content p').length,
              目录条数: $('#toc-list').children.length,
              页面报错: errs
            });
            dump('ACTOUT', log3);
          }, 8000);
        }, 400);
      }, 400);
    }

    if (q.get('act') === 'dbg') {
      // 长按左上角「砚读」应该弹出诊断面板
      var h1 = document.querySelector('#page-shelf h1');
      h1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      setTimeout(function () {
        var el = document.getElementById('dbg');
        dump('ACTOUT', {
          面板出现了: !!el && el.style.display === 'block',
          内容: el ? el.textContent.split('\n') : null
        });
      }, 1100);
    }

    if (q.get('act') === 'roster') {
      // 花名册：架子上有需要编号的书时才出现按钮；点开要能对上号
      var log4 = [];
      function out4() { dump('ACTOUT', log4); }
      setTimeout(function () {
        var btn = $('#btn-roster');
        log4.push({
          按钮存在: !!btn,
          按钮可见: btn && btn.style.display !== 'none',
          按钮文字: btn ? btn.textContent : null,
          书脊上的序号: [].map.call(document.querySelectorAll('#shelf-stage .bk'), function (g) {
            return g.getAttribute('data-no') || g.getAttribute('data-seq');
          })
        });
        out4();
        if (!btn) return;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        setTimeout(function () {
          // 花名册的行复用 .pick-row（加 .plain 表示这本没编号），别找 .roster-row
          var rows = $('#roster-list').querySelectorAll('.pick-row');
          log4.push({
            面板打开: $('#sheet-roster').classList.contains('open'),
            标题: $('#roster-title').textContent,
            计数: $('#roster-count').textContent,
            说明: $('#roster-note').textContent,
            行数: rows.length,
            滚动书名: $('#roster-list').querySelectorAll('.pick-name.roll').length + '/' +
                      $('#roster-list').querySelectorAll('.pick-name').length,
            首行量宽: (function () {
              var e = $('#roster-list .pick-name');
              if (!e || !e.firstChild) return 'n/a';
              return 'box=' + e.clientWidth + ' 内=' + e.firstChild.offsetWidth +
                     ' 超=' + (e.firstChild.offsetWidth - e.clientWidth);
            })(),
            前三行: [].slice.call(rows, 0, 3).map(function (r) { return r.textContent.replace(/\s+/g, ' ').trim(); })
          });
          out4();
          // 点一行应该直接进阅读器
          if (rows.length) {
            rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            setTimeout(function () {
              log4.push({
                阅读页打开: $('#page-reader').classList.contains('active'),
                章节标题: $('.chapter-block .chapter-title').textContent,
                残留遮罩: $('#loading').classList.contains('on')
              });
              out4();
            }, 600);
          }
        }, 500);
      }, 400);
    }

    if (q.get('act') === 'edit') {
      var log = [];
      function click(el, label) {
        if (!el) { log.push(label + ' → 元素不存在'); return; }
        try {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch (e) { log.push(label + ' → 抛错 ' + e.message); }
      }
      function snap(label) {
        var stage = $('#shelf-stage');
        try {
        log.push({
          step: label,
          slotg: stage.querySelectorAll('.slotg').length,
          slothit: stage.querySelectorAll('.slothit').length,
          slotbox: stage.querySelectorAll('.slotbox').length,
          badge: stage.querySelectorAll('.slotbadge').length,
          books: stage.querySelectorAll('.bk').length,
          editBtnText: $('#btn-edit').textContent,
          editBarOn: $('#edit-bar').classList.contains('on'),
          pickOpen: $('#sheet-pick').classList.contains('open'),
          pickRows: $('#pick-list').querySelectorAll('.pick-row').length,
          pickTitle: $('#pick-title').textContent,
          pickCap: $('#pick-cap').textContent,
          confirmOpen: $('#sheet-confirm').classList.contains('open')
        });
        } catch (e) { log.push(label + ' → snap 抛错 ' + e.message); }
        out();   // 每步都落一次盘，中途崩了也能看到走到哪
      }
      function out() { dump('ACTOUT', log); }
      setTimeout(function () {
        snap('初始');
        window.onerror = function (msg, src, line) { log.push('页面报错: ' + msg + ' @' + line); out(); };
        var stage = $('#shelf-stage');
        stage.addEventListener('click', function (e) {
          var t = e.target;
          log.push({
            evt: '点到了',
            tag: t.tagName,
            cls: t.getAttribute && t.getAttribute('class'),
            slotAttr: t.getAttribute && t.getAttribute('data-slot'),
            closestSlot: t.closest && t.closest('[data-slot]') ? t.closest('[data-slot]').getAttribute('data-slot') : null
          });
          out();
        }, true);
        click($('#btn-edit'), '点编辑');
        setTimeout(function () {
          snap('点完编辑');
          click($('.slothit[data-slot="3"]'), '点第4格热区');
          setTimeout(function () {
            snap('点完格子');
            click($('#pick-list .pick-row .pick-act.add'), '点第一本的「放上」');
            setTimeout(function () {
              snap('加完一本');
              click($('#pick-list .pick-row .pick-act.del'), '点「拿下」');
              setTimeout(function () {
                snap('拿下一本');
                window.DB.getSlots().then(function (s) {
                  log.push({ step: 'DB 里的摆位', slots: s });
                  dump('ACTOUT', log);
                });
              }, 250);
            }, 250);
          }, 300);
        }, 400);
      }, 400);
    }

  /* ?act=tab：量底部导航「导入」按钮 —— 圆 ::before 的圆心 vs 加号图标中心。
     测两遍：带 html.native（真机那样 padding-bottom:22）和去掉之后，验证两者是否一样对齐 */
  if (q.get('act') === 'tab') {
    function snapTab() {
      var bar = $('#tabbar'), add = $('.tab-add'), svg = $('.tab-add svg');
      var cs = getComputedStyle(add, '::before');
      var barR = bar.getBoundingClientRect(), addR = add.getBoundingClientRect(), svgR = svg.getBoundingClientRect();
      // 伪元素的 box-sizing 不受 * 选择器管辖（默认 content-box），
            // 这里必须自己把 border/padding 加回去，否则算出来的圆心是错的。
            // 真准绳是 design/_pxcircle.html 的像素测量，算完务必用它核一遍。
            function outer(len, b1, b2, p1, p2) {
              return cs.boxSizing === 'border-box' ? parseFloat(len)
                : parseFloat(len) + parseFloat(b1) + parseFloat(b2) + parseFloat(p1) + parseFloat(p2);
            }
            var bw = outer(cs.width, cs.borderLeftWidth, cs.borderRightWidth, cs.paddingLeft, cs.paddingRight);
            var bh = outer(cs.height, cs.borderTopWidth, cs.borderBottomWidth, cs.paddingTop, cs.paddingBottom);
      var cx = addR.left + parseFloat(cs.left) + parseFloat(cs.marginLeft) + bw / 2;
      var cy = addR.top + parseFloat(cs.top) + parseFloat(cs.marginTop) + bh / 2;
      var sx = svgR.left + svgR.width / 2, sy = svgR.top + svgR.height / 2;
      return {
        按钮高: +addR.height.toFixed(1),
        圆心: { x: +cx.toFixed(2), y: +cy.toFixed(2) },
        图标中心: { x: +sx.toFixed(2), y: +sy.toFixed(2) },
        偏差: { dx: +(sx - cx).toFixed(2), dy: +(sy - cy).toFixed(2) },
        圆顶探出栏顶: +(barR.top - (cy - bh / 2)).toFixed(1),
        圆底距栏底: +(barR.bottom - (cy + bh / 2)).toFixed(1),
        命中: [cy - bh / 2 + 5, cy, cy + bh / 2 - 5].map(function (y) {
          var el = document.elementFromPoint(cx, y);
          return { y: +y.toFixed(0), 命中: el ? (el.className || el.tagName) : 'null' };
        })
      };
    }
    setTimeout(function () {
      var withNative = snapTab();
      document.documentElement.classList.remove('native');
      setTimeout(function () {
        var noNative = snapTab();
        dump('ACTOUT', [{ '真机(native)': withNative, '无 native': noNative }]);
      }, 200);
    }, 300);
  }


   /* ?act=roll：连续卷轴的验收。
      验七件事：
        1) 下滑过程中 DOM 里**提前**挂着下一章（不是滑到底才拉）
        2) 挂着的章节号必须连续，中间不能有空洞（空洞 = 滑到一半是空白）
        3) 相邻块之间只有一截留白，不能有几百 px 的断口
        4) 往上滑能把更早的章节接回来（最早挂的那章变小）
        5) 全程 streamSeq 不变 —— 没发生"整条卷轴拆了重画"，那才是真的连贯
        6) DOM 里的 <p> 数量有上限，不会一路涨到几千
        7) **画面不跳**：手指停下来之后，异步接进来的章节不能把正在读的那一段挪走
           （这条最要紧，也最容易在真机上翻车 —— 见 preserve()）
      ⚠️ 章节别造太长（para 给 25 左右）：每章几万 px 的话，
         模拟的一屏一屏滑动根本走不完一章，测不出"接章节"这件事。
      跑法：node tools/cdp-run.js "file:///.../phone-sim.html?act=roll&chaps=8&para=25" 40000 */
   if (q.get('act') === 'roll') {
     var log5 = [], errs5 = [];
     /* headless 里 rAF 到底跑不跑要先确认：不跑的话滚动回调永远不执行，
        测出来"没接上"会以为是代码的锅（这个坑踩过一次，查了两轮）。 */
     var raf5 = 0;
     (function loop5() { raf5++; requestAnimationFrame(loop5); })();
     window.onerror = function (msg, src, line) { errs5.push(msg + ' @' + line); };

     function R() { return window.__reader ? window.__reader() : null; }
     function el() { return document.getElementById('reader-body'); }

     /* 参考线上那一段的"指纹"：是哪一段 + 它离参考线多少 px。
        画面要是被异步插入的内容顶走了，这两个数一定会变。 */
     function fp() {
       var e = el();
       var ry = e.getBoundingClientRect().top + e.clientHeight * 0.25;
       var ps = document.querySelectorAll('#chapter-content p');
       var best = null, bd = 1e9, by = null;
       for (var i = 0; i < ps.length; i++) {
         var r = ps[i].getBoundingClientRect();
         if (r.top <= ry && r.bottom >= ry) { best = ps[i]; by = r.top - ry; break; }
         var d = Math.abs(r.top - ry);
         if (d < bd) { bd = d; best = ps[i]; by = r.top - ry; }
       }
       return { txt: best ? best.textContent.slice(0, 26) : null, y: by === null ? null : Math.round(by) };
     }
     /* 「手指停下来，画面不许动」：等 1.5 秒（足够异步章节接进来 + 卸载远处的章节），
        前后两次指纹必须完全一致。 */
      function still(tag, cb) {
        var a = fp(); var aTop = Math.round(el().scrollTop);
        /* ⚠️ 光记 scrollTop 不够：要是视口高变了，25% 那条参考线也会跟着挪，
           同一段就会"看起来位移了"几像素（实测 9px）。把视口高和锚点块的位置
           一起记下来，才分得清"画面真跳了"还是"只是尺子变了"。 */
        var ah = el().clientHeight;
        var aBlockTop = (function () {
          var bs = document.querySelectorAll('.chapter-block');
          return bs.length ? Math.round(bs[0].getBoundingClientRect().top) : null;
        })();
        setTimeout(function () {
          var b = fp();
          var bh = el().clientHeight;
          var bBlockTop = (function () {
            var bs = document.querySelectorAll('.chapter-block');
            return bs.length ? Math.round(bs[0].getBoundingClientRect().top) : null;
          })();
          log5.push({
            步骤: tag,
            静止前: a.txt + ' @' + a.y + ' (top ' + aTop + ' 视口 ' + ah + ' 首块top ' + aBlockTop + ')',
            静止后: b.txt + ' @' + b.y + ' (top ' + Math.round(el().scrollTop) + ' 视口 ' + bh + ' 首块top ' + bBlockTop + ')',
            是同一段: a.txt === b.txt,
            视口高变了吗: ah !== bh,
            视口差: bh - ah,
            位移px: (a.y === null || b.y === null) ? null : Math.abs(b.y - a.y)
          });
          cb(a.txt === b.txt && (a.y === null || Math.abs(b.y - a.y) <= 4));
        }, 1600);
      }

     function seamGap() {   // 相邻两块之间的缝隙：只该是一截留白（~3.4em）
       var bs = document.querySelectorAll('.chapter-block');
       var out = [];
       for (var i = 1; i < bs.length; i++) {
         var a = bs[i - 1].getBoundingClientRect(), b = bs[i].getBoundingClientRect();
         out.push(Math.round(b.top - a.bottom));
       }
       return out;
     }
     /* 参考线落在哪一章里 + 离这一章末尾还有多远 —— 用来判"是不是提前加载的" */
     function readPos() {
       var e = el();
       var ry = e.getBoundingClientRect().top + e.clientHeight * 0.25;
       var bs = document.querySelectorAll('.chapter-block');
       var cur = null, ci = -1;
       for (var i = 0; i < bs.length; i++) {
         var r = bs[i].getBoundingClientRect();
         if (r.top <= ry && r.bottom > ry) { cur = r; ci = i; }
       }
       if (!cur) { ci = bs.length - 1; cur = bs[ci] ? bs[ci].getBoundingClientRect() : null; }
       return { i: ci, dist: cur ? Math.round(cur.bottom - ry) : null };
     }
     function snap5(tag) {
       var r = R(), e = el(), p = readPos(), f = fp();
       log5.push({
         步骤: tag,
         index: r ? r.index : 'n/a',
         seq: r ? r.seq : 'n/a',
         挂着第几章: r ? r.blocks.map(function (b) { return b.idx; }) : 'n/a',
         读到第几块: p.i,
         离本章末尾px: p.dist,
         参考线那一段: f.txt,
         块间缝隙: seamGap(),
         scrollTop: Math.round(e.scrollTop),
         卷轴高: e.scrollHeight,
         DOM里段数: document.querySelectorAll('#chapter-content p').length,
         页眉: document.getElementById('reader-title').textContent
       });
     }
     /* 模拟手指一屏一屏地滑：直接写 scrollTop 再手动发事件
        （老 WebView 没有 scrollTo({behavior})）。每步之间留够时间：
        滚动回调是 rAF 节流的，接章节还要等一次异步查库。 */
     function slide(steps, dir, cb) {
       var e = el(), n = 0;
       (function one() {
         e.scrollTop = Math.max(0, e.scrollTop + dir * e.clientHeight * 0.8);
         e.dispatchEvent(new Event('scroll'));
         if (++n % 3 === 0) snap5((dir > 0 ? '下滑' : '上滑') + n + '/' + steps);
         if (n < steps) setTimeout(one, 210);
         else setTimeout(cb, 700);
       })();
     }

     setTimeout(function () {
       document.querySelector('.tab[data-page="list"]').click();
       setTimeout(function () {
         var rows = document.querySelectorAll('#list-body .bk-row');
         if (!rows.length) { log5.push({ 错误: '列表里没书，测不了' }); dump('ACTOUT', log5); return; }
         /* 挑一本有进度的、从中间某章开始（桩里 i%3==0 的那几本才有进度）——
            从第一章开的话上面没东西，测不出上行加载。 */
         var row = rows[3] || rows[0];
         var rowKey = row.textContent.slice(0, 30);
         row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
         setTimeout(function () {
           snap5('刚打开');
           still('打开后静止', function () {
             slide(15, +1, function () {
               var rr = R();
               var downFirst = rr ? rr.blocks[0].idx : -1;
               var downIdx = rr ? rr.index : -1;
               snap5('下滑结束');
               still('下滑后静止', function (ok1) {
                 slide(21, -1, function () {
                   var r = R();
                   var upFirst = r ? r.blocks[0].idx : -1;
                   var upIdx = r ? r.index : -1;
                   snap5('上滑结束');
                   still('上滑后静止', function (ok2) {
                     /* ---- 退出再打开：位置要接得上 ---- */
                     var beforeIdx = upIdx, beforeP = readPos(), beforeFp = fp();
                     document.getElementById('btn-back').click();
                     setTimeout(function () {
                       var rows2 = document.querySelectorAll('#list-body .bk-row');
                       var again = null;
                       for (var i = 0; i < rows2.length; i++) {
                         if (rows2[i].textContent.slice(0, 30) === rowKey) { again = rows2[i]; break; }
                       }
                       (again || rows2[3]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                       setTimeout(function () {
                         var r2 = R(), p2 = readPos(), f2 = fp();
                         snap5('退出再打开');

                         /* ---- 断言 ---- */
                         var seqs = [], holes = 0, gaps = [], maxP = 0;
                         var preloadDist = null, preloadAt = null;
                         log5.forEach(function (x) {
                           if (typeof x.seq === 'number' && x.步骤 !== '退出再打开') seqs.push(x.seq);
                           if (Array.isArray(x.挂着第几章)) {
                             var a = x.挂着第几章;
                             for (var i = 1; i < a.length; i++) if (a[i] !== a[i - 1] + 1) holes++;
                             /* 「下一章已经挂上了」且「人还在这章里」→ 记下离本章末尾还有多远 */
                             if (preloadDist === null && a.length > 1 && x.离本章末尾px > 0 &&
                                 x.读到第几块 >= 0 && x.读到第几块 < a.length - 1) {
                               preloadDist = x.离本章末尾px; preloadAt = x.步骤;
                             }
                           }
                           (x.块间缝隙 || []).forEach(function (g) { gaps.push(g); });
                           if (typeof x.DOM里段数 === 'number') maxP = Math.max(maxP, x.DOM里段数);
                         });
                         var uniq = seqs.filter(function (v, i) { return i === 0 || v !== seqs[i - 1]; });
                         var stills = log5.filter(function (x) { return x.是同一段 !== undefined; });

                         log5.push({
                           结论: {
                             '1_下一章挂上时离本章末尾还有px': preloadDist,
                             提前加载发生在: preloadAt,
                             '2_章节号连续无空洞': holes === 0,
                             '3_块间缝隙最大px': gaps.length ? Math.max.apply(null, gaps) : 'n/a',
                             块间没断口: gaps.length ? Math.max.apply(null, gaps) < 200 : 'n/a',
                             '4_上滑接回了更早的章节': upFirst < downFirst,
                             下滑时最早挂的是: downFirst + 1 + '章',
                             上滑后最早挂的是: upFirst + 1 + '章',
                             下滑读到: downIdx + 1 + '章',
                             上滑读到: upIdx + 1 + '章',
                             '5_全程没重画过整条卷轴': uniq.length === 1,
                             '6_DOM段数峰值': maxP,
                             段数是否封住: maxP < 1600,
                             /* ⚠️ 参考线是『视口高的 25%』。要是两次之间视口高变了（模拟器壳子会变），
                              同一条参考线自己就挪了 —— 那不是画面在跳，是尺子变了，
                              按 25% 扣掉再判。 */
                              '7_静止时画面不跳': stills.every(function (x) {
                                return x.是同一段 && x.位移px <= 4 + Math.abs(x.视口差 || 0) * 0.25;
                              }),
                             静止检查明细: stills.map(function (x) {
                               return x.步骤 + '：' + x.静止前 + ' → ' + x.静止后;
                             }),
                             '8_退出再打开接得上': (r2 ? r2.index : -2) === beforeIdx && beforeFp.txt === f2.txt,
                             重开前: beforeIdx + 1 + '章｜' + beforeFp.txt + ' @' + beforeFp.y,
                             重开后: (r2 ? r2.index + 1 : '?') + '章｜' + f2.txt + ' @' + f2.y,
                             现在挂着: r2 ? r2.blocks.map(function (b) { return b.idx; }) : 'n/a',
                             页面报错: errs5
                           }
                         });
                         dump('ACTOUT', log5);
                       }, 1600);
                     }, 700);
                   });
                 });
               });
             });
           });
         }, 1400);
       }, 700);
     }, 700);
   }

   /* ?act=rollmanual：把「章节连续阅读」关掉之后是什么样。
      预期：章末挂出「下一章 · xxx」按钮，点一下才把下一章接上来；
            往下不会自己接（那是开着时的行为），但往上仍然能接回上一章。
      ⚠️ 顺序很重要：先打开书 → 关开关 → 退出来 → 重新打开。
         直接在第一次打开的卷轴上关开关的话，下一章可能早就挂上了，
         按钮逻辑根本验不到（实测就这么白测过一轮）。 */
   if (q.get('act') === 'rollmanual') {
     var log6 = [], errs6 = [];
     window.onerror = function (msg, src, line) { errs6.push(msg + ' @' + line); };
     function snap6(tag) {
       var r = window.__reader ? window.__reader() : null;
       var ce = document.querySelector('.chapter-end');
       log6.push({
         步骤: tag,
         挂着第几章: r ? r.blocks.map(function (b) { return b.idx; }) : 'n/a',
         章末块: ce ? ce.className + '｜' + ce.textContent.replace(/\s+/g, ' ').trim() : '无',
         按钮文字: (document.querySelector('.ce-next-btn') || {}).textContent || '无',
         页眉: document.getElementById('reader-title').textContent
       });
     }
     function toEndOfBlock0(cb) {
       var e = document.getElementById('reader-body'), n = 0;
       (function push() {
         var b0 = document.querySelectorAll('.chapter-block')[0];
         if (b0) {
           var top = b0.getBoundingClientRect().top - e.getBoundingClientRect().top + e.scrollTop;
           e.scrollTop = top + b0.offsetHeight - e.clientHeight * 0.5;
           e.dispatchEvent(new Event('scroll'));
         }
         if (++n < 10) setTimeout(push, 220);
         else setTimeout(cb, 800);
       })();
     }
     setTimeout(function () {
       document.querySelector('.tab[data-page="list"]').click();
       setTimeout(function () {
         var rows = document.querySelectorAll('#list-body .bk-row');
         var row = rows[1] || rows[0];
         var key = row.textContent.slice(0, 30);
         row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
         setTimeout(function () {
           /* ⚠️ 别写成 $('btn-set')：驱动里的 $ 就是 querySelector，选择器得带 # */
           document.getElementById('btn-set').click();
           setTimeout(function () {
             var off = document.querySelector('#auto-pick .pill[data-auto="0"]');
             if (off) off.click();
             document.getElementById('btn-back').click();   // 退出来，让开关对整条卷轴生效
             setTimeout(function () {
               var rows2 = document.querySelectorAll('#list-body .bk-row');
               var again = null;
               for (var i = 0; i < rows2.length; i++) {
                 if (rows2[i].textContent.slice(0, 30) === key) { again = rows2[i]; break; }
               }
               (again || rows2[1]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
               setTimeout(function () {
                 snap6('关掉后重新打开');
                 toEndOfBlock0(function () {
                   snap6('滑到第一章尾');
                   var beforeLen = window.__reader().blocks.length;
                   var btn = document.querySelector('.ce-next-btn');
                   if (!btn) { log6.push({ 结论: '没出现「下一章」按钮，失败' }); dump('ACTOUT', log6); return; }
                   btn.click();
                   setTimeout(function () {
                     snap6('点按钮之后');
                     var afterLen = window.__reader().blocks.length;
                     log6.push({
                       结论: {
                         没点之前挂着几章: beforeLen,
                         /* ⚠️ 这条断言以前写的是 blocks.length >= 2，
                            而"没点之前"其实已经挂着两章了（下一章被无条件预取）——
                            条件点不点按钮都成立，是个假绿，把一个真 bug 钉成了规格。
                            手动模式的规矩（README 4.7）是：点之前只挂着当前这一章。 */
                         点了才接上第二章: (beforeLen === 1 && afterLen >= 2),
                         按钮换成了再下一章: (document.querySelector('.ce-next-btn') || {}).textContent || '无',
                         报错: errs6
                       }
                     });
                     dump('ACTOUT', log6);
                   }, 900);
                 });
               }, 1400);
             }, 500);
           }, 500);
         }, 1200);
       }, 700);
     }, 700);
   }

   /* ?act=ui：新阅读页 UI 的验收。
      验六件事：
        1) 顶栏 = 返回（左）/ 更多（右），底栏 = 章节标题 + 上一章/进度条/下一章 + 四个功能键
        2) ⭐ 点屏幕收放两条栏时，**正文的 padding 一个像素都不许变**（v-show，不是 v-if）
           —— 顺带量"参考线上那一段的 y"，字也不能移位
        3) 「夜间」一键切黑：主题挂到 <html> 上（body 底色也跟着变，状态栏那条不再是白的）
        4) 拖动进度条能跳章（拖到 50% → 读到中间那一章）
        5) 「更多」按下有提示（位置先留着）
        6) 没有报错
      跑法：node tools/cdp-run.js "file:///.../phone-sim.html?act=ui&chaps=12&para=25" 20000 */
   if (q.get('act') === 'ui') {
     var log7 = [], errs7 = [];
     window.onerror = function (msg, src, line) { errs7.push(msg + ' @' + line); };
     function el() { return document.getElementById('reader-body'); }
     /* 参考线上那一段：它离参考线多少 px —— 画面要是被挪动了，这个数会变 */
     function fpY() {
       var e = el();
       var ry = e.getBoundingClientRect().top + e.clientHeight * 0.25;
       var ps = document.querySelectorAll('#chapter-content p');
       var best = null, bd = 1e9, by = null;
       for (var i = 0; i < ps.length; i++) {
         var r = ps[i].getBoundingClientRect();
         if (r.top <= ry && r.bottom >= ry) { best = ps[i]; by = r.top - ry; break; }
         var d = Math.abs(r.top - ry);
         if (d < bd) { bd = d; best = ps[i]; by = r.top - ry; }
       }
       return { txt: best ? best.textContent.slice(0, 20) : null, y: by === null ? null : Math.round(by) };
     }
     function tap(el, x, y) {
       var t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
       el.dispatchEvent(new TouchEvent('touchstart', { changedTouches: [t], touches: [t], bubbles: true }));
       el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [t], touches: [], bubbles: true }));
     }
     setTimeout(function () {
       document.querySelector('.tab[data-page="list"]').click();
       setTimeout(function () {
         var row = document.querySelector('#list-body .bk-row');
         if (!row) { log7.push({ 错误: '列表里没书' }); dump('ACTOUT', log7); return; }
         row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
         setTimeout(function () {
           var e = el();
           var head = document.getElementById('reader-head');
           var foot = document.getElementById('reader-foot');
           var cs = getComputedStyle(e);

           log7.push({
             步骤: '刚打开',
             顶栏: ['返回', document.getElementById('btn-back').textContent.trim()],
             顶栏右: document.getElementById('btn-more').textContent.trim(),
             章节标题: document.getElementById('fc-title').textContent,
             上一章: document.getElementById('btn-prev').textContent.trim(),
             下一章: document.getElementById('btn-next').textContent.trim(),
             功能键: [].map.call(document.querySelectorAll('.fm-btn'), function (b) { return b.textContent.trim(); }),
             底栏高: Math.round(foot.getBoundingClientRect().height),
             顶栏高: Math.round(head.getBoundingClientRect().height),
             正文padding上下: cs.paddingTop + ' / ' + cs.paddingBottom
           });

           /* ---- 2) 收放两条栏，正文不许动 ---- */
           var before = { pad: cs.paddingTop + '/' + cs.paddingBottom, fp: fpY() };
           tap(e, 200, e.getBoundingClientRect().top + e.clientHeight * 0.5);
           setTimeout(function () {
             var cs2 = getComputedStyle(e);
             var after = { pad: cs2.paddingTop + '/' + cs2.paddingBottom, fp: fpY() };
             var off = document.getElementById('page-reader').classList.contains('bars-off');
             log7.push({
               步骤: '点一下屏幕收起两条栏',
               栏已收起: off,
               收起前padding: before.pad,
               收起后padding: after.pad,
               padding没变: before.pad === after.pad,
               收起前那一段: before.fp.txt + ' @' + before.fp.y,
               收起后那一段: after.fp.txt + ' @' + after.fp.y,
               正文没移位: after.fp.txt === before.fp.txt && Math.abs(after.fp.y - before.fp.y) <= 1
             });
             tap(e, 200, e.getBoundingClientRect().top + e.clientHeight * 0.5);
             setTimeout(function () {
               var cs3 = getComputedStyle(e);
               log7.push({
                 步骤: '再点一下放出来',
                 栏放出来了: !document.getElementById('page-reader').classList.contains('bars-off'),
                 padding: cs3.paddingTop + '/' + cs3.paddingBottom,
                 padding还是没变: (cs3.paddingTop + '/' + cs3.paddingBottom) === before.pad
               });

               /* ---- 3) 夜间 ---- */
               var bg0 = getComputedStyle(document.body).backgroundColor;
               var pg0 = getComputedStyle(document.getElementById('page-reader')).backgroundColor;
               document.getElementById('btn-night').click();
               setTimeout(function () {
                 log7.push({
                   步骤: '点了夜间',
                   html上的主题: document.documentElement.getAttribute('data-theme'),
                   body底色_前: bg0,
                   body底色_后: getComputedStyle(document.body).backgroundColor,
                   阅读页底色_前: pg0,
                   阅读页底色_后: getComputedStyle(document.getElementById('page-reader')).backgroundColor,
                   正文色: getComputedStyle(document.querySelector('#chapter-content p')).color,
                   底栏底色: getComputedStyle(document.getElementById('reader-foot')).backgroundColor,
                   夜间键亮着: document.getElementById('btn-night').classList.contains('on')
                 });
                 document.getElementById('btn-night').click();   // 切回去
                 setTimeout(function () {
                   log7.push({
                     步骤: '再点夜间切回来',
                     主题: document.documentElement.getAttribute('data-theme'),
                     body底色: getComputedStyle(document.body).backgroundColor
                   });

                   /* ---- 4) 拖进度条跳章 ---- */
                   var bar = document.getElementById('fc-bar');
                   var r = bar.getBoundingClientRect();
                   var idx0 = window.__reader().index;
                   /* ⚠️ 真机上走的是 Pointer 分支（window.PointerEvent 存在），
                      所以这里得发 PointerEvent —— 发 TouchEvent 是打不到监听的。 */
                   var px = r.left + r.width * 0.5, py = r.top + 11;
                   bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: px, clientY: py, bubbles: true, pointerId: 2 }));
                   document.dispatchEvent(new PointerEvent('pointermove', { clientX: px, clientY: py, bubbles: true, pointerId: 2 }));
                   document.dispatchEvent(new PointerEvent('pointerup', { clientX: px, clientY: py, bubbles: true, pointerId: 2 }));
                   setTimeout(function () {
                     log7.push({
                       步骤: '把进度条拖到 50%',
                       拖之前读到: idx0 + 1 + '章',
                       拖之后读到: (window.__reader().index + 1) + '章',
                       书籍信息: document.getElementById('toc-meta').textContent,
                       圆点位置: document.getElementById('fc-dot').style.left
                     });

                     /* ---- 5) 更多 ---- */
                     document.getElementById('btn-more').click();
                     setTimeout(function () {
                       var ts = document.getElementById('toast');
                       log7.push({
                         步骤: '点了更多',
                         提示文字: (document.body.lastElementChild || {}).textContent,
                         页面报错: errs7
                       });
                       dump('ACTOUT', log7);
                     }, 400);
                   }, 1400);
                 }, 400);
               }, 400);
             }, 700);
           }, 700);
         }, 1400);
       }, 700);
     }, 700);
   }
   /* ?act=light：底部亮度面板的验收（两行式）。
      验六件事：
        1) 点底栏「亮度」弹出的是这个面板，不是设置面板
        2) 第一行 = 暗太阳 | 滑条（已激活轨道 + 圆滑块 + 未激活轨道）| 亮太阳，
           三个部件的位置对得上（滑块中心落在已激活轨道的末端）
        3) 第二行 = 「亮度跟随系统」文字 + 拨动开关
        4) 拖滑条能改亮度：遮罩透明度跟着变，圆滑块跟着走
        5) 拨「跟随系统」：遮罩撤掉（= 亮度交给系统），滑条压暗并不给拖
        6) 没有报错
      跑法：node tools/cdp-run.js "file:///.../phone-sim.html?act=light&chaps=6&para=25" 18000 */
   if (q.get('act') === 'light') {
     var log8 = [], errs8 = [];
     window.onerror = function (msg, src, line) { errs8.push(msg + ' @' + line); };
     function snap8(tag) {
       var lp = document.getElementById('sheet-light');
       var tr = document.getElementById('lp-track').getBoundingClientRect();
       var fl = document.getElementById('lp-fill');
       var kn = document.getElementById('lp-knob').getBoundingClientRect();
       var sw = document.getElementById('lp-switch');
       log8.push({
         步骤: tag,
         面板开着: lp.classList.contains('open'),
         设置面板开着: document.getElementById('sheet-set').classList.contains('open'),
         屏幕亮度设置: (function () {
           try { return +document.getElementById('brightness').value; } catch (e) { return null; }
         })(),
         遮罩透明度: getComputedStyle(document.getElementById('dim')).opacity,
         已激活轨道宽: Math.round(parseFloat(fl.style.width || '0')) + '%',
         圆滑块中心x: Math.round(kn.left + kn.width / 2),
         轨道: [Math.round(tr.left), Math.round(tr.width)],
         滑块是否落在激活段末端: Math.abs((kn.left + kn.width / 2) - (tr.left + tr.width * (parseFloat(fl.style.width || '0') / 100))) <= 2,
         太阳图标数: document.querySelectorAll('#lp-slider .lp-sun').length,
         开关文字: document.querySelector('.lp-label').textContent,
         开关开着: sw.classList.contains('on'),
         滑条被压暗: document.getElementById('lp-slider').classList.contains('off')
       });
     }
     function drag(x) {
       var track = document.getElementById('lp-track');
       var r = track.getBoundingClientRect();
       var px = r.left + r.width * x, py = r.top + r.height / 2;
       track.dispatchEvent(new PointerEvent('pointerdown', { clientX: px, clientY: py, bubbles: true, pointerId: 3 }));
       document.dispatchEvent(new PointerEvent('pointermove', { clientX: px, clientY: py, bubbles: true, pointerId: 3 }));
       document.dispatchEvent(new PointerEvent('pointerup', { clientX: px, clientY: py, bubbles: true, pointerId: 3 }));
     }
     setTimeout(function () {
       document.querySelector('.tab[data-page="list"]').click();
       setTimeout(function () {
         var row = document.querySelector('#list-body .bk-row');
         if (!row) { log8.push({ 错误: '列表里没书' }); dump('ACTOUT', log8); return; }
         row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
         setTimeout(function () {
           snap8('打开书（面板没开）');
           document.getElementById('btn-light').click();
           setTimeout(function () {
             snap8('点了「亮度」');
             drag(0.25);                       // 拖到 25%
             setTimeout(function () {
               snap8('滑条拖到 25%');
               document.getElementById('lp-switch').click();    // 开「跟随系统」
               setTimeout(function () {
                 snap8('拨开「跟随系统」');
                 document.getElementById('lp-switch').click();  // 再关掉
                 setTimeout(function () {
                   snap8('再关掉');
                   document.getElementById('light-mask').click();
                   setTimeout(function () {
                     snap8('点遮罩关掉面板');
                     log8.push({ 页面报错: errs8 });
                     dump('ACTOUT', log8);
                   }, 400);
                 }, 400);
               }, 400);
             }, 400);
           }, 500);
         }, 1400);
       }, 700);
     }, 700);
   }
   /* ?act=set：阅读设置面板的验收（四行式）。
      验七件事：
        1) 底栏「设置」弹的是这个面板（不是"更多阅读设置"那个老面板）
        2) 第一行：字号标签 + A- / 数字 / A+ / 「思源… ›」（最后一个要贴最右）
           按 A+ 字号真变大，按那个按钮能换字体
        3) 第二行：背景圆点一排，选中的外面套描边；点「青灰」底色真变
        4) 第三行：翻页四个按钮，选中的边框高亮
        5) ⭐ 翻页方式真的生效：
             上下  = 一步到位（采样只有两个值）
             平滑  = 采样能看出一串渐变的值（rAF 推的，老 WebView 没有 scrollTo({behavior})）
             覆盖  = 位置到位 + #chapter-content 挂上 fx-cover
        6) 第四行：自动翻页（开/关会变字）+ 更多阅读设置（打开老面板）
        7) 没有报错
      ⚠️ 判定"有没有动画"必须**采样一串**，只取首尾两个点会假阴性 —— 试过。
      跑法：node tools/cdp-run.js "file:///.../phone-sim.html?act=set&chaps=12&para=25" 24000 */
   if (q.get('act') === 'set') {
     var log9 = [], errs9 = [];
     window.onerror = function (msg, src, line) { errs9.push(msg + ' @' + line); };
     function el() { return document.getElementById('reader-body'); }
     function top9() { return Math.round(el().scrollTop); }
     function snap9(tag) {
       var panel = document.querySelector('.rs-panel').getBoundingClientRect();
       var fbtn = document.getElementById('rs-font').getBoundingClientRect();
       var on = function (sel) {
         var e = document.querySelector(sel);
         return e ? e.getAttribute(Object.keys(e.dataset || {})[0] === 'theme' ? 'data-theme' : 'data-turn') : '无';
       };
       log9.push({
         步骤: tag,
         阅读设置面板: document.getElementById('sheet-readset').classList.contains('open'),
         老设置面板: document.getElementById('sheet-set').classList.contains('open'),
         字号数值: document.getElementById('rs-fs-val').textContent,
         正文字号: getComputedStyle(document.querySelector('#chapter-content p')).fontSize,
         字体按钮: document.getElementById('rs-font-name').textContent,
         字体按钮离右边缘: Math.round(panel.right - fbtn.right) + 'px',
         选中的背景: (document.querySelector('#rs-theme .rs-dot.on') || { getAttribute: function () { return '无'; } }).getAttribute('data-theme'),
          /* 「翻页方式」那一行 2026-09-21 撤掉了：这里必须**不存在**，
             要是哪天有人不小心加回来，这条断言会立刻红。 */
          翻页那一行还在吗: !!document.getElementById('rs-turn'),
          背景色块数: document.querySelectorAll('#rs-theme .rs-dot').length,
         自动翻页那行: document.getElementById('rs-auto').textContent,
         正文背景: getComputedStyle(document.getElementById('page-reader')).backgroundColor
       });
     }
     /* 采样一串 scrollTop：每 35ms 一个点，看它是不是"渐变"过去的 */
     function sampleJump(btnId, tag, done) {
       var before = top9();
       var seqBefore = window.__reader().seq;
       var idxBefore = window.__reader().index;
       var blocksBefore = window.__reader().blocks.map(function (b) { return b.idx; });
       document.getElementById(btnId).click();
       var idxAfter = window.__reader().index;
       var blocksAfter = window.__reader().blocks.map(function (b) { return b.idx; });
       var series = [top9()], k = 0;
       (function tick() {
         setTimeout(function () {
           series.push(top9());
           if (++k < 12) { tick(); return; }
           var uniq = series.filter(function (v, i) { return i === 0 || v !== series[i - 1]; });
           log9.push({
             步骤: tag,
             跳之前: before,
             章_前: idxBefore, 章_后: idxAfter,
             挂着_前: blocksBefore, 挂着_后: blocksAfter,
             scrollTop采样: series.join('→'),
             出现几个不同的值: uniq.length,
             走的是同一条卷轴: seqBefore === window.__reader().seq
           });
           done(uniq.length);
         }, 35);
       })();
     }
     function closeRs() { document.getElementById('sheet-readset').classList.remove('open'); }
     function openRs() { document.getElementById('btn-set').click(); }
      /* 翻页方式已撤掉：没有 pickTurn 了（只保留上下滑动的卷轴） */

     /* 扁平的步骤链：一步一件事，比层层嵌套好改也好看 */
     var steps = [
       [function () { openRs(); }, 600],
       [function () { snap9('点了底栏「设置」'); }, 200],
       [function () { document.getElementById('rs-fs-plus').click(); }, 300],
       [function () { snap9('按了 A+'); }, 200],
       [function () { document.getElementById('rs-font').click(); }, 500],
       [function () {
         log9.push({ 步骤: '字体面板', 开着: document.getElementById('sheet-font').classList.contains('open') });
         document.querySelector('#sheet-font .fp-row[data-font="serif"]').click();
       }, 400],
       [function () { snap9('选了思源宋体'); }, 200],
       [function () { document.querySelector('#rs-theme .rs-dot[data-theme="slate"]').click(); }, 400],
       [function () { snap9('选了青灰背景'); }, 200],
        [function () { closeRs(); }, 400],
       [function () {
         sampleJump('btn-next', '翻页=上下 时跳章', function (n) {
           log9.push({ 结论_上下: n <= 2 ? '一步到位 ✓' : '居然在动（不该）' });
         });
       }, 900],
       [function () { openRs(); }, 600],
        [function () { closeRs(); }, 400],
       [function () {
         sampleJump('btn-next', '翻页=平滑 时跳章', function (n) {
           log9.push({ 结论_平滑: n >= 3 ? '看得到渐变 ✓' : '没动（不该）' });
         });
       }, 900],
       [function () { openRs(); }, 600],
        [function () { closeRs(); }, 400],
       [function () {
         document.getElementById('btn-prev').click();
         var cc = document.getElementById('chapter-content');
         log9.push({
           步骤: '翻页=覆盖 时跳章',
         挂的class: (document.querySelector(".fx-layer.fx-cover, .fx-layer.fx-sim") || {}).className || "（没有浮层在动）",
         浮层里几段: document.querySelectorAll(".fx-layer p").length,
         有fx动画: !!document.querySelector(".fx-layer.fx-cover, .fx-layer.fx-sim"),
         封面浮层吃点击吗: (function () { var s = document.querySelector(".fx-stage"); return s ? getComputedStyle(s).pointerEvents : "（没有浮层）"; })(),
         });
       }, 600],
       [function () { openRs(); }, 600],
       [function () {
         var a1 = document.getElementById('rs-auto').textContent;
         document.getElementById('rs-auto').click();
         log9.push({
           步骤: '点了自动翻页', 前: a1,
           后: document.getElementById('rs-auto').textContent,
           变了: a1 !== document.getElementById('rs-auto').textContent
         });
       }, 300],
       [function () { document.getElementById('rs-more').click(); }, 600],
       [function () {
         log9.push({
           步骤: '点了更多阅读设置',
           老面板开着: document.getElementById('sheet-set').classList.contains('open'),
           设置面板自己关了: !document.getElementById('sheet-readset').classList.contains('open'),
           页面报错: errs9
         });
         dump('ACTOUT', log9);
       }, 100]
     ];
     setTimeout(function () {
       document.querySelector('.tab[data-page="list"]').click();
       setTimeout(function () {
         var row = document.querySelector('#list-body .bk-row');
         if (!row) { log9.push({ 错误: '列表里没书' }); dump('ACTOUT', log9); return; }
         row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
         setTimeout(function () {
           var i9 = 0;
           (function next9() {
             if (i9 >= steps.length) return;
             var s = steps[i9++];
             try { s[0](); } catch (e) { log9.push({ 抛错: String(e) }); }
             setTimeout(next9, s[1] || 400);
           })();
         }, 1400);
       }, 700);
     }, 700);
   }
   /* ?act=toc：左侧目录面板的验收。
      验七件事：
        1) 面板从左边滑出来，宽约占屏幕 76%（70~80% 之间），右边缘有圆角；
           右边的遮罩是半透明黑
        2) 顶部：书名（多行，不截断）+ 副信息栏（左：字数·最新章 / 右：倒序按钮）
           + 下方一条细分割线
        3) 列表每行统一是「第X章：章节名」（标题自带的"第X章"不会重复出现）
        4) 当前在读那一章有高亮（加粗 + 强调色 + 左竖条）
        5) 右侧悬浮胶囊滚动条：短目录不出现；长目录出现且滑块位置跟着滚动走；
           点上下箭头能翻一屏；拖滑块能跳到对应位置
        6) 倒序：点一下列表整个反过来排，再点回来
        7) 没有报错
      跑法（长目录要 chaps 大一点才看得到滚动条）：
        node tools/cdp-run.js "file:///.../phone-sim.html?act=toc&chaps=60&para=25" 20000 */
   if (q.get('act') === 'toc') {
     var logT = [], errsT = [];
     window.onerror = function (msg, src, line) { errsT.push(msg + ' @' + line); };
     function snapT(tag) {
       var inner = document.querySelector('#drawer-toc .drawer-inner').getBoundingClientRect();
       var list = document.getElementById('toc-list');
       var sbar = document.getElementById('toc-sbar');
       var items = document.querySelectorAll('#toc-list .toc-item[data-i]');
       var cur = document.querySelector('#toc-list .toc-item.cur');
       var cs = cur ? getComputedStyle(cur) : null;
       logT.push({
         步骤: tag,
         面板开着: document.getElementById('drawer-toc').classList.contains('open'),
         /* ⚠️ 分母要用抽屉自己的宽度（= 视口宽），别用 window.innerWidth：
            模拟器里书架那个固定宽的画布会把 innerWidth 撑大，除出来偏小。 */
         面板宽px: Math.round(inner.width),
         面板宽占屏比: Math.round(inner.width / document.getElementById('drawer-toc').getBoundingClientRect().width * 100) + '%',
         面板右圆角: getComputedStyle(document.querySelector('#drawer-toc .drawer-inner')).borderTopRightRadius,
         遮罩色: getComputedStyle(document.getElementById('toc-mask')).backgroundColor,
         书名: document.getElementById('toc-title').textContent,
         书名是否多行: document.getElementById('toc-title').getBoundingClientRect().height > 30,
         副信息: document.getElementById('toc-meta').textContent,
         倒序按钮: document.getElementById('toc-order').textContent.trim(),
         倒序开着: document.getElementById('toc-order').classList.contains('on'),
         行格式_前三条: [].map.call(items, function (e) { return e.textContent; }).slice(0, 3),
         行格式_末条: items.length ? items[items.length - 1].textContent : '无',
         当前章: cur ? cur.textContent : '无',
         当前章字重: cs ? cs.fontWeight : '无',
         当前章色: cs ? cs.color : '无',
         当前章左竖条: cs ? cs.boxShadow : '无',
         滚动条出现: !sbar.classList.contains('hide'),
         滑块top: document.getElementById('sb-thumb').style.top,
         列表滚动量: Math.round(list.scrollTop) + '/' + Math.round(list.scrollHeight - list.clientHeight)
       });
     }
     var stepsT = [
       [function () { document.getElementById('btn-toc').click(); }, 700],
       [function () { snapT('打开目录'); }, 300],
       [function () {
         document.getElementById('sb-down').click();          // 往下一屏
       }, 400],
       [function () { snapT('点了滚动条向下箭头'); }, 300],
       [function () {
         var th = document.getElementById('sb-thumb');
         var r = th.getBoundingClientRect();
         var px = r.left + r.width / 2, py = r.top + r.height / 2;
         th.dispatchEvent(new PointerEvent('pointerdown', { clientX: px, clientY: py, bubbles: true, pointerId: 7 }));
         document.dispatchEvent(new PointerEvent('pointermove', { clientX: px, clientY: py + 90, bubbles: true, pointerId: 7 }));
         document.dispatchEvent(new PointerEvent('pointerup', { clientX: px, clientY: py + 90, bubbles: true, pointerId: 7 }));
       }, 400],
       [function () { snapT('把滑块往下拖了 90px'); }, 300],
       [function () { document.getElementById('toc-order').click(); }, 500],
       [function () { snapT('点了倒序'); }, 300],
       [function () { document.getElementById('toc-order').click(); }, 500],
       [function () { snapT('再点回正序'); }, 300],
       [function () {
         var it = document.querySelectorAll('#toc-list .toc-item[data-i]')[2];
         if (it) it.click();
       }, 900],
       [function () {
         logT.push({
           步骤: '点目录里某一章',
           面板关了: !document.getElementById('drawer-toc').classList.contains('open'),
           读到: (window.__reader().index + 1) + '章',
           页面报错: errsT
         });
         dump('ACTOUT', logT);
       }, 200]
     ];
     setTimeout(function () {
       document.querySelector('.tab[data-page="list"]').click();
       setTimeout(function () {
         var row = document.querySelector('#list-body .bk-row');
         if (!row) { logT.push({ 错误: '列表里没书' }); dump('ACTOUT', logT); return; }
         row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
         setTimeout(function () {
           var kT = 0;
           (function nextT() {
             if (kT >= stepsT.length) return;
             var s = stepsT[kT++];
             try { s[0](); } catch (e) { logT.push({ 抛错: String(e) }); }
             setTimeout(nextT, s[1] || 400);
           })();
         }, 1400);
       }, 700);
     }, 700);
   }
   /* ?act=full：全屏沉浸 / 边缘贴合 / 自动翻页 的验收。
      验六件事：
        1) 系统栏那一截（--safeT / --safeB）用的是**量出来的真实值**，不是写死的 46/26
        2) 开全屏沉浸 → 两条数值归零（顶栏底栏直接贴到物理边界）
        3) 顶栏紧贴屏幕顶端（top=0）、底栏紧贴屏幕底端（bottom=视口高）
        4) 自动翻页：开 → 深色速度面板出现 + scrollTop 自己在涨；
           减速/加速能改数值和速度；退出 → 面板收掉并停下
        5) 手动滑一下 → 自动翻页先让位（暂停一下），不跟人对着拽
        6) 没有报错
      ⚠️ 模拟器里没有 Capacitor.Plugins.Immersive（那是真机才有的原生插件），
         所以 1/2 这两条在这里只能验"取不到时不崩、退回默认值"，
         真机上才会真的量到数 —— 这点在结论里写清楚，别当成全绿。
      跑法：node tools/cdp-run.js "file:///.../phone-sim.html?act=full&chaps=40&para=25" 30000 */
   if (q.get('act') === 'full') {
     var logF = [], errsF = [];
     window.onerror = function (msg, src, line) { errsF.push(msg + ' @' + line); };
     function el() { return document.getElementById('reader-body'); }
     function topF() { return Math.round(el().scrollTop); }
     function safe() {
       var cs = getComputedStyle(document.documentElement);
       return cs.getPropertyValue('--safeT').trim() + ' / ' + cs.getPropertyValue('--safeB').trim();
     }
     function snapF(tag) {
       var head = document.getElementById('reader-head').getBoundingClientRect();
       var foot = document.getElementById('reader-foot').getBoundingClientRect();
       logF.push({
         步骤: tag,
         safeTB: safe(),
         顶栏top: Math.round(head.top),
         顶栏高: Math.round(head.height),
         底栏布局bottom: Math.round(document.getElementById("reader-foot").offsetTop + document.getElementById("reader-foot").offsetHeight),
         视口高: window.innerHeight,
         /* ⚠️ 别用 getBoundingClientRect 判贴底：栏收起时带 transform: translateY(100%)，
            rect 会整个挪到屏幕外面（量出来比阅读页底还低一截，看着像 bug 其实是对的）。
            用 offsetTop + offsetHeight —— 这是布局位置，不受 transform 影响。 */
         底栏贴底吗: Math.abs((document.getElementById("reader-foot").offsetTop + document.getElementById("reader-foot").offsetHeight) - document.getElementById("page-reader").clientHeight) <= 1,
         栏收起了吗: document.getElementById("page-reader").classList.contains("bars-off"),
         阅读页底: Math.round(document.getElementById("page-reader").getBoundingClientRect().bottom),
         底栏定位: (function () {
           var f = document.getElementById("reader-foot");
           var cs = getComputedStyle(f); var op = f.offsetParent;
           return cs.position + " top=" + cs.top + " bottom=" + cs.bottom + " 基准=" + (op ? (op.id || op.className) + "(" + Math.round(op.getBoundingClientRect().height) + "px)" : "null");
         })(),
         速度面板开着: document.getElementById('sheet-speed').classList.contains('open'),
         速度值: document.getElementById('sp-val').textContent,
         自动翻页: (document.getElementById('rs-auto') || {}).textContent,
         scrollTop: topF()
       });
     }
     var stepsF = [
       [function () { document.getElementById('btn-set').click(); }, 600],
       [function () { snapF('打开设置面板'); }, 200],
       [function () { document.getElementById('btn-fullscreen').click(); }, 700],
       [function () { snapF('点了沉浸模式（全屏）'); document.getElementById('sheet-set').classList.remove('open'); }, 400],
        /* ★ 点了自动翻页：**设置面板和速度面板都必须自己收掉**，
           只留下右下角那枚小胶囊（她明确要求的："直到用户再次点击的时候才弹出"） */
        [function () { document.getElementById('rs-auto').click(); }, 700],
        [function () {
          logF.push({
            步骤: '点了自动翻页',
            设置面板还开着吗: document.getElementById('sheet-readset').classList.contains('open'),
            速度面板自动弹出来了吗: document.getElementById('sheet-speed').classList.contains('open'),
            小胶囊出现: document.getElementById('ap-pill').classList.contains('on'),
            胶囊上的速度: document.getElementById('ap-speed').textContent
          });
        }, 1600],
        [function () { snapF('等 1.6 秒看自己在滚吗'); }, 200],
        [function () { document.getElementById('ap-pill').click(); }, 700],
        [function () {
          logF.push({
            步骤: '点小胶囊 → 速度面板这时候才出现',
            速度面板: document.getElementById('sheet-speed').classList.contains('open'),
            速度值: document.getElementById('sp-val').textContent
          });
        }, 400],
        /* ★ 轻点正文也能把速度面板叫出来（自动翻页开着时的专用手势）——
           两个面板都收掉之后，这是最顺手的入口。 */
        [function () {
          var e = el();
          function tap() {
            var t1 = new Touch({ identifier: 3, target: e, clientX: 200, clientY: 400 });
            e.dispatchEvent(new TouchEvent('touchstart', { changedTouches: [t1], touches: [t1], bubbles: true }));
            var t2 = new Touch({ identifier: 3, target: e, clientX: 200, clientY: 400 });
            e.dispatchEvent(new TouchEvent('touchend', { changedTouches: [t2], touches: [], bubbles: true }));
          }
          var S = document.getElementById('sheet-speed');
          var wasOpen = S.classList.contains('open');
          tap();
          var a = S.classList.contains('open');
          tap();
          var b = S.classList.contains('open');
          logF.push({
            步骤: '自动翻页开着时轻点正文',
            点之前: wasOpen, 点一下: a, 再点一下: b,
            结论: (wasOpen && !a && b) ? '轻点 = 开/关速度面板 ✓' : '手势不对 ✗'
          });
        }, 400],
       /* ★ 关键：自动翻页开着的时候，别的地方必须还能点 ——
          之前速度面板是铺满全屏的 .sheet，把整屏点击都吃了，
          表现就是开了自动翻页之后哪儿都点不动、面板也关不掉。 */
       [function () {
         document.getElementById("btn-toc").click();
       }, 700],
       [function () {
         logF.push({ 步骤: "自动翻页开着时点底栏「目录」",
           目录开了: document.getElementById("drawer-toc").classList.contains("open"),
           速度面板还在: document.getElementById("sheet-speed").classList.contains("open") });
         document.getElementById("toc-mask").click();
       }, 500],
       [function () {
         document.getElementById("btn-set").click();
       }, 700],
       [function () {
         logF.push({ 步骤: "自动翻页开着时点底栏「设置」",
           设置面板开了: document.getElementById("sheet-readset").classList.contains("open") });
         document.getElementById("sheet-readset").classList.remove("open");
       }, 400],
       [function () {
         document.getElementById('sp-fast').click();
         document.getElementById('sp-fast').click();
       }, 1500],
       [function () { snapF('按了两次加速 +'); }, 200],
       [function () { document.getElementById('sp-slow').click(); }, 800],
       [function () { snapF('按了一次减速 -'); }, 200],
       [function () {
         /* 手动滑一下：自动翻页应该让位（暂停），别跟人对着拽 */
         var e = el();
         var t = new Touch({ identifier: 9, target: e, clientX: 200, clientY: 400 });
         e.dispatchEvent(new TouchEvent('touchstart', { changedTouches: [t], touches: [t], bubbles: true }));
         e.scrollTop = e.scrollTop - 200;
         e.dispatchEvent(new Event('scroll'));
         var t2 = new Touch({ identifier: 9, target: e, clientX: 200, clientY: 400 });
         e.dispatchEvent(new TouchEvent('touchend', { changedTouches: [t2], touches: [], bubbles: true }));
       }, 600],
       [function () { snapF('手动滑了一下（该让位）'); }, 200],
       [function () { document.getElementById('sp-exit').click(); }, 900],
       [function () {
         var a = topF();
         setTimeout(function () {
            logF.push({
              步骤: '退出自动翻页后',
              面板收了: !document.getElementById('sheet-speed').classList.contains('open'),
              小胶囊也收了: !document.getElementById('ap-pill').classList.contains('on'),
              还在滚吗: topF() !== a ? '还在滚（不该）' : '停了 ✓',
              scrollTop: topF(),
              页面报错: errsF
            });
           dump('ACTOUT', logF);
         }, 900);
       }, 100]
     ];
     setTimeout(function () {
       document.querySelector('.tab[data-page="list"]').click();
       setTimeout(function () {
         var row = document.querySelector('#list-body .bk-row');
         if (!row) { logF.push({ 错误: '列表里没书' }); dump('ACTOUT', logF); return; }
         row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
         setTimeout(function () {
           var kF = 0;
           (function nextF() {
             if (kF >= stepsF.length) return;
             var s = stepsF[kF++];
             try { s[0](); } catch (e) { logF.push({ 抛错: String(e) }); }
             setTimeout(nextF, s[1] || 400);
           })();
         }, 1400);
       }, 700);
     }, 700);
   }
   /* ?act=reopen：**「切完翻页方式 → 退回书架 → 再打开这本书」会不会卡死**。
      这条是她报的第二个问题（"切换完翻页逻辑后这本书再次打开彻底卡死"），必须留着常跑。

      复现顺序完全照她说的来：打开书 → 开阅读设置 → 点四种翻页方式 →
      连按两次「下一章」→ 返回 → 从列表再打开同一本。

      复现顺序完全照她说的来：打开书 → 开阅读设置 → 点四种翻页方式 →
         上一版给整个 .chapter-block 挂 perspective + animation，那一块有上千个 <p>、
         十几万像素高 —— 浏览器要把它提成一张巨大的合成层。跳章那一下先卡，
         之后重开要重新排那一大块，直接卡死在「正在排版正文」。
         现在动画只发生在一屏大小的浮层上，这一串就是为了盯住它不再回来。 */
   if (q.get('act') === 'reopen') {
     var logR = [], errR = [];
     window.onerror = function (msg, src, line) { errR.push(msg + ' @' + line); };

     function snapR(tag, extra) {
       var r = window.__reader ? window.__reader() : null;
       var o = {
         步骤: tag,
         遮罩还在: document.getElementById('loading').classList.contains('on'),
         遮罩上的字: document.getElementById('loading-text').textContent,
         阅读页: document.getElementById('page-reader').classList.contains('active'),
         正文段数: document.querySelectorAll('#chapter-content p').length,
         挂着几章: r ? r.blocks.length : 'n/a',
         当前章: r ? r.index : 'n/a'
       };
       Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
       logR.push(o);
     }

     /* ⚠️ 列表是异步画的：点完 tab 立刻 querySelector 可能一行都还没有
        （第一次进来就撞上了），所以这里返回成不成功，让调用方重试。 */
     function clickRow() {
       document.querySelector('.tab[data-page="list"]').click();
       var rows = document.querySelectorAll('#list-body .bk-row');
       if (!rows.length) return false;
       (rows[1] || rows[0]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
       return true;
     }

     /* 打开一本书，轮询等遮罩收掉；超过 12 秒算可疑卡死 */
     function openWatch(tag, cb) {
       var tries = 0;
       (function tryClick() {
         if (clickRow() || ++tries > 20) { watch(); return; }
         setTimeout(tryClick, 250);
       })();
       var t0 = Date.now();
        function watch() {
          t0 = Date.now();
          (function poll() {
            var on = document.getElementById('loading').classList.contains('on');
            var el = Date.now() - t0;
            if (!on) { snapR(tag, { 耗时ms: el, 判定: '正常打开' }); cb(); return; }
            if (el > 12000) { snapR(tag, { 耗时ms: el, 判定: '✗ 超时，疑似卡死' }); cb(); return; }
            setTimeout(poll, 150);
          })();
        }
      }

     function closeAll() {
       ['sheet-readset', 'sheet-speed', 'sheet-set', 'sheet-light', 'sheet-font'].forEach(function (id) {
         var e = document.getElementById(id);
         if (e) e.classList.remove('open');
       });
       var d = document.getElementById('drawer-toc');
       if (d) d.classList.remove('open');
     }

     var MODESR = ['vscroll', 'smooth', 'cover', 'sim'];

     setTimeout(function () {
       openWatch('第一次打开', function () {
         /* 串成一条链：每个模式做完自己的那一段 */
         (function next(i) {
           if (i >= MODESR.length) {
             setTimeout(function () {
               snapR('收尾', {
                 残留浮层: document.querySelectorAll('.fx-stage').length,
                 残留block动画: document.querySelectorAll('.chapter-block.fx-cover, .chapter-block.fx-sim').length,
                 页面报错: errR
               });
               dump('ACTOUT', logR);
             }, 900);
             return;
           }
           var mode = MODESR[i];
           document.getElementById('btn-set').click();
           setTimeout(function () {
             var b = document.querySelector('#rs-turn .rs-seg-btn[data-turn="' + mode + '"]');
             if (b) b.click();
             closeAll();
             setTimeout(function () {
               document.getElementById('btn-next').click();
               /* 动画只有 300~420ms，得趁它在的时候量 —— 等 700ms 就已经被拆掉了 */
               setTimeout(function () {
                 snapR('翻页=' + mode + ' 动画中', {
                   浮层数: document.querySelectorAll('.fx-stage').length,
                   动画class: (document.querySelector('.fx-layer.fx-cover, .fx-layer.fx-sim') || {}).className || '（无）',
                   浮层里几段: document.querySelectorAll('.fx-layer p').length,
                   浮层吃点击吗: (function () {
                     var st = document.querySelector('.fx-stage');
                     return st ? getComputedStyle(st).pointerEvents : '（无浮层）';
                   })()
                 });
               }, 150);
               setTimeout(function () {
                 document.getElementById('btn-next').click();
                 setTimeout(function () {
                   snapR('翻页=' + mode + ' 跳两次之后', {
                     刚跳完有浮层吗: document.querySelectorAll('.fx-stage').length
                   });
                   setTimeout(function () {
                     closeAll();
                     document.getElementById('btn-back').click();
                     setTimeout(function () {
                       openWatch('翻页=' + mode + ' 之后重开', function () {
                         next(i + 1);
                       });
                     }, 800);
                   }, 700);
                 }, 700);
               }, 500);
             }, 500);
           }, 500);
         })(0);
       });
     }, 900);
   }

   /* ?act=page：**真分页（一屏一屏翻）的验收**。
      她要的是「上下 = 卷轴，其余三种 = 一屏一屏」，这条就盯住这件事：

        ① 默认（上下）是卷轴：正文能自由滚，按钮叫「上一章/下一章」
        ② 切到覆盖：正文不能自由滚（overflow hidden），按钮变「上一页/下一页」，
           底栏显示「第 N / 共 M 页」
        ③ 每翻一页，视口顶边必须**正好落在某一段的开头**（误差 ≤3px）——
           这条是分页的灵魂：不对齐段首，看着就是"滚了一下"，不是翻页
        ④ 翻到末页再翻 → 进下一章第 1 页
        ⑤ 切回上下 → 全部还原成卷轴
      跑法：node tools/cdp-run.js "file:///.../phone-sim.html?act=page&chaps=6&para=120" 30000 */
   /* ?act=page：现在测的是**真分页已经停用**（2026-09-21 她定的：只保留上下滑动的卷轴）。

      留着这条不是为了跑分页，是为了**防止它回来**：
        ① 设置面板里不再有「翻页方式」那一行（#rs-turn 不存在）
        ② 打开书之后不是分页模式：正文能自由滚、底栏两个键是「上一章/下一章」
        ③ 底栏标题不带「第 N / 共 M 页」
        ④ 跳章仍然正常（卷轴那条老路没被伤到）
        ⑤ 无报错
      真分页那套引擎还在代码里（paged() 恒 false 关着），将来要捡回来时
      把 paged() 打开、把那一行加回去，再把这条测试改回分页验收。
      跑法：node tools/cdp-run.js "file:///.../phone-sim.html?act=page&chaps=6&para=120" 20000 */
   if (q.get('act') === 'page') {
     var logQ = [], errQ = [];
     window.onerror = function (msg, src, line) { errQ.push(msg + ' @' + line); };
     function el() { return document.getElementById('reader-body'); }
     function snapQ(tag) {
       var r = window.__reader ? window.__reader() : {};
       logQ.push({
         步骤: tag,
         翻页那一行还在吗: !!document.getElementById('rs-turn'),
         分页模式: r.paged,
         能自由滚吗: getComputedStyle(el()).overflowY,
         上一页键: document.getElementById('btn-prev').textContent,
         下一页键: document.getElementById('btn-next').textContent,
         底栏标题: document.getElementById('fc-title').textContent,
         标题里带页码吗: /第 \d+ \/ \d+ 页/.test(document.getElementById('fc-title').textContent),
         页尾遮罩: getComputedStyle(document.getElementById('page-tail')).display,
         当前章: r.index + 1
       });
     }
     setTimeout(function () {
       document.querySelector('.tab[data-page="list"]').click();
       setTimeout(function () {
         var tries = 0;
         (function go() {
           var rs = document.querySelectorAll('#list-body .bk-row');
           if (!rs.length && ++tries < 20) { setTimeout(go, 250); return; }
           (rs[1] || rs[0]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
           setTimeout(function () {
             snapQ('刚打开');
             document.getElementById('btn-set').click();
             setTimeout(function () {
               snapQ('打开阅读设置');
               document.getElementById('sheet-readset').classList.remove('open');
               setTimeout(function () {
                 document.getElementById('btn-next').click();
                 setTimeout(function () {
                   snapQ('点了一次「下一章」');
                   logQ.push({
                     结论: {
                       入口撤掉了: logQ.every(function (x) { return x.翻页那一行还在吗 === false; }),
                       一直是卷轴: logQ.every(function (x) { return x.分页模式 === false; }),
                       能自由滚: logQ.every(function (x) { return x.能自由滚吗 === 'auto'; }),
                       键是上下章: logQ[0].上一页键 === '上一章' && logQ[0].下一页键 === '下一章',
                       标题不带页码: logQ.every(function (x) { return x.标题里带页码吗 === false; }),
                       遮罩没出现: logQ.every(function (x) { return x.页尾遮罩 === 'none'; }),
                       跳章正常: logQ[2].当前章 > logQ[0].当前章 || logQ[2].当前章 >= 1
                     },
                     页面报错: errQ
                   });
                   dump('ACTOUT', logQ);
                 }, 900);
               }, 600);
             }, 700);
           }, 1500);
         })();
       }, 700);
     }, 700);
   }

   /* ?act=drag：**两条滑动条（底栏章节进度条 + 目录胶囊滚动条）的验收**。
      她报的是"滑动卡顿 + 会卡死"，所以这里盯两件事：

        ① 拖动过程中不许每个事件都去读几何（那会逼浏览器反复排版正文/目录）
        ② **pointerup 丢了也要能自愈** —— 3 秒没事件就当松手，
           否则 dragging 永远 true，之后手指随便动一下都在"拖"（就是她说的卡死）

      跑法：node tools/cdp-run.js "file:///.../phone-sim.html?act=drag&chaps=40&para=25" 30000 */
   if (q.get('act') === 'drag') {
     var logD = [], errD = [];
     window.onerror = function (msg, src, line) { errD.push(msg + ' @' + line); };

     function pe(type, x, y) {
       return new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 7 });
     }
     function r(node) { return node.getBoundingClientRect(); }

     /* 拖一串：从 from 到 to，分 n 步 */
     function drag(handle, from, to, axis, steps, cb) {
       var cur = from, frames = 0, running = true;
       /* 拖动期间数帧：卡不卡，看这个数比看耗时准（耗时是 setTimeout 的节奏定的） */
       (function f() { if (!running) return; frames++; requestAnimationFrame(f); })();
       handle.dispatchEvent(pe('pointerdown', axis === 'y' ? 0 : cur, axis === 'y' ? cur : 0));
       var k = 0, t0 = Date.now();
       (function tick() {
         cur = from + (to - from) * (++k / steps);
         document.dispatchEvent(pe('pointermove', axis === 'y' ? 0 : cur, axis === 'y' ? cur : 0));
         if (k < steps) { setTimeout(tick, 16); return; }
         running = false;
         cb(Date.now() - t0, frames);
       })();
     }

     function testSeek(cb) {
       var bar = document.getElementById('fc-bar'), dot = document.getElementById('fc-dot');
       var rb = r(bar);
       var before = window.__reader().index;
       var dotBefore = dot.style.left;
       var y = rb.top + rb.height / 2;
       drag(bar, rb.left + rb.width * 0.1, rb.left + rb.width * 0.8, 'x', 20, function (ms, frames) {
         var dotMid = dot.style.left;
         document.dispatchEvent(pe('pointerup', rb.left + rb.width * 0.8, y));
         setTimeout(function () {
           logD.push({
             步骤: '底栏进度条：拖一大段',
             拖动耗时ms: ms,
             拖动期间帧数: frames,
             折算帧率: Math.round(frames / (ms / 1000)) + 'fps',
             圆点_前: dotBefore, 圆点_拖到一半: dotMid,
             章_前: before + 1, 章_后: window.__reader().index + 1,
             真的跳章了: window.__reader().index !== before
           });
           /* ★ 卡死自愈：只按下 + 拖，**故意不发 pointerup** */
           var x2 = rb.left + rb.width * 0.2;
           bar.dispatchEvent(pe('pointerdown', x2, y));
           document.dispatchEvent(pe('pointermove', x2 + 40, y));
            setTimeout(function () {
              var afterDown = dot.style.left;   /* 等 rAF 落地再读，别读到上一次的旧值 */
              setTimeout(function () {
                /* 三秒多没事件了，dragify 应该已经自己收尾 */
                document.dispatchEvent(pe("pointermove", rb.left + rb.width * 0.95, y));
                setTimeout(function () {
                  logD.push({
                    步骤: "底栏进度条：丢掉 pointerup 之后",
                    按下后圆点: afterDown,
                    三秒后乱动手指_圆点: dot.style.left,
                    自愈了吗: Math.abs(parseFloat(dot.style.left) - parseFloat(afterDown)) < 3,
                    说明: "圆点没跟着手指跑到 95% = 不再被拖着走（不再卡死）"
                  });
                  cb();
                }, 150);
              }, 3300);
            }, 150);
          }, 600);
       });
     }

     function testToc(cb) {
       document.getElementById('btn-toc').click();
       setTimeout(function () {
         var list = document.getElementById('toc-list');
         var th = document.getElementById('sb-thumb');
         var rt = r(th);
         var topBefore = list.scrollTop;
         var y0 = rt.top + rt.height / 2;
         drag(th, y0, y0 + 180, 'y', 20, function (ms, frames) {
           var mid = list.scrollTop;
           document.dispatchEvent(pe('pointerup', 0, y0 + 180));
           setTimeout(function () {
             logD.push({
               步骤: '目录胶囊滚动条：拖一大段',
               拖动耗时ms: ms,
               拖动期间帧数: frames,
               折算帧率: Math.round(frames / (ms / 1000)) + 'fps',
               目录滚动_前: topBefore, 拖之后: mid,
               滚动条动了吗: mid !== topBefore,
               滑块top: th.style.top
             });
             /* 同样的自愈测试 */
             th.dispatchEvent(pe('pointerdown', 0, y0));
             document.dispatchEvent(pe('pointermove', 0, y0 + 30));
             setTimeout(function () {
               var afterDown = list.scrollTop;   /* 同样等 rAF 落地再读 */
               setTimeout(function () {
                 document.dispatchEvent(pe('pointermove', 0, y0 + 400));
                 setTimeout(function () {
                   logD.push({
                     步骤: '目录滚动条：丢掉 pointerup 之后',
                     按下后滚动位置: afterDown,
                     三秒后乱动手指_滚动位置: list.scrollTop,
                     自愈了吗: Math.abs(list.scrollTop - afterDown) < 30,
                     说明: '没被手指拖着跑一大段 = 不再卡死'
                   });
                   document.getElementById('toc-mask').click();
                   cb();
                 }, 150);
               }, 3300);
             }, 150);
           }, 300);
         });
       }, 700);
     }

     setTimeout(function () {
       document.querySelector('.tab[data-page="list"]').click();
       setTimeout(function () {
         var tries = 0;
         (function go() {
           var rs = document.querySelectorAll('#list-body .bk-row');
           if (!rs.length && ++tries < 20) { setTimeout(go, 250); return; }
           (rs[1] || rs[0]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
           setTimeout(function () {
             testSeek(function () {
               testToc(function () {
                 logD.push({ 页面报错: errD });
                 dump('ACTOUT', logD);
               });
             });
           }, 1600);
         })();
       }, 700);
     }, 700);
   }

   /* ?act=shot：给截图用。三种画面：
       ?shot=continue  书架页的「继续阅读」便签（默认就能出，桩里有读过进度的书）
       ?shot=read      阅读页滑到章末，把章末卡片露出来
       ?shot=set       设置面板（看「章末自动翻页」那个开关）
     静态截图走旧 headless（虚拟时间下 rAF 不跑，正好不会自动翻章，能定格） */
  if (q.get('act') === 'shot') {
    var shot = q.get('shot') || 'read';
    if (shot === 'continue') {
      var logS = [];
      setTimeout(function () {
        var c = $('#btn-continue');
        var rc = c.getBoundingClientRect();
        var rsh = document.querySelector('.shelf-canvas').getBoundingClientRect();
        logS.push({
          显示: getComputedStyle(c).display,
          书名: $('#cc-name').textContent,
          副标题: $('#cc-sub').textContent,
          竖条色: getComputedStyle($('#cc-spine')).backgroundColor,
          进度线宽: $('#cc-bar').style.width,
          卡片: [Math.round(rc.left), Math.round(rc.top), Math.round(rc.width), Math.round(rc.height)],
          架子: [Math.round(rsh.left), Math.round(rsh.top), Math.round(rsh.width), Math.round(rsh.height)],
          左右留白: Math.round(rc.left) + ' / ' + Math.round(window.innerWidth - rc.right),
          架子是否还在: !!document.querySelector('.shelf-canvas svg')
        });
        dump('ACTOUT', logS);
      }, 1500);
    } else {
      setTimeout(function () {
        document.querySelector('.tab[data-page="list"]').click();
        setTimeout(function () {
          var row = document.querySelector('#list-body .bk-row');
          if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          setTimeout(function () {
            if (shot === 'set') { document.getElementById('btn-set').click(); return; }
            /* ?shot=seam：把「上一章最后几行 + 下一章的标题」这条接缝摆在屏幕中间。
               这就是这次要的效果 —— 整本书读起来像一条很长的书页，中间没有翻页。 */
            if (shot === 'seam') {
              setTimeout(function () {
                var el2 = document.getElementById('reader-body');
                var bs = document.querySelectorAll('.chapter-block');
                if (bs.length < 2) { dump('ACTOUT', [{ 错误: '只挂了 ' + bs.length + ' 章，接缝出不来' }]); return; }
                var top = bs[1].getBoundingClientRect().top - el2.getBoundingClientRect().top + el2.scrollTop;
                el2.scrollTop = Math.max(0, top - el2.clientHeight * 0.42);
                el2.dispatchEvent(new Event('scroll'));
                setTimeout(function () {
                  dump('ACTOUT', [{
                    挂着几章: (window.__reader() || { blocks: [] }).blocks.map(function (b) { return b.idx; }),
                    接缝上下: [bs[0].textContent.slice(-16), bs[1].textContent.slice(0, 16)]
                  }]);
                }, 400);
              }, 1200);
              return;
            }
            /* ?shot=paged：摆好**分页模式**的画面（底栏显示"第 N / 共 M 页"、
               两个键变成上一页/下一页），给截图用。 */
            /* ?shot=fx&mode=cover|sim：**动画中途**的截图。
               做法：把"点下一章"固定在 2200ms，然后用 cdp-run 的等待时间
               （WAIT=2380）去卡那一瞬间 —— 覆盖 0.30s / 仿真 0.42s 的动画，
               拍到时正好在中间，能看出"新的一屏正在盖上来 / 立起来"。 */
            /* ?shot=auto：自动翻页开着、两个面板都收掉、只留右下角小胶囊 */
            if (shot === 'auto') {
              setTimeout(function () {
                document.getElementById('btn-set').click();
                setTimeout(function () {
                  document.getElementById('rs-auto').click();
                  /* ⚠️ 自动翻页一开始滚，上下两条栏就会自动收起（`top<24` 才摊开），
                     而那枚小胶囊是跟着两条栏一起藏/现的 —— 不把它按在页首，
                     截图就永远只能拍到"胶囊已经被收起来了"。
                     这里每 120ms 把它拨回页首并手动发一次 scroll，栏就一直摊开。 */
                  var pinN = 0;
                  var pin = setInterval(function () {
                    var e = document.getElementById('reader-body');
                    /* ⚠️ 别一直写 0：滚动回调里 `|dy| < 6 就当抖动忽略`，
                       位移太小的话「回到开头就摊开栏」那条永远轮不到。交替 0/10 才行。 */
                    e.scrollTop = (pinN++ % 2) ? 10 : 0;
                    e.dispatchEvent(new Event('scroll'));
                  }, 120);
                  /* ⚠️ 这个 pin 一直不撤：截图是 cdp-run 在等待结束之后才拍的，
                     中途撤掉的话，等它拍的时候自动翻页早把栏收起来了。 */
                  setTimeout(function () {
                    var p = document.getElementById('ap-pill');
                    var r = p.getBoundingClientRect();
                    var foot = document.getElementById('reader-foot').getBoundingClientRect();
                    dump('ACTOUT', [{
                      设置面板收了: !document.getElementById('sheet-readset').classList.contains('open'),
                      速度面板收了: !document.getElementById('sheet-speed').classList.contains('open'),
                      胶囊可见: p.classList.contains('on'),
                      胶囊位置: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
                      阅读页: (function () {
                        var q = document.getElementById('page-reader').getBoundingClientRect();
                        return Math.round(q.left) + '..' + Math.round(q.right) + ' 高' + Math.round(q.height) + ' 视口宽' + window.innerWidth;
                      })(),
                      压到底栏了吗: r.bottom > foot.top,
                      上下栏摊开了吗: !document.getElementById('page-reader').classList.contains('bars-off'),
                      胶囊文字: p.textContent
                    }]);
                  }, 900);
                }, 600);
              }, 900);
              return;
            }
            /* ?shot=speed：摆好自动翻页的速度面板（配色跟亮度面板同一套） */
            if (shot === 'speed') {
              setTimeout(function () {
                document.getElementById('btn-set').click();
                setTimeout(function () {
                  document.getElementById('rs-auto').click();
                  document.getElementById('sheet-readset').classList.remove('open');
                  setTimeout(function () {
                    document.getElementById('ap-pill').click();   // 面板现在是点了胶囊才出来
                  }, 300);
                  setTimeout(function () {
                    dump('ACTOUT', [{
                      速度面板开着: document.getElementById('sheet-speed').classList.contains('open'),
                      面板底色: getComputedStyle(document.querySelector('.sp-panel')).backgroundColor,
                      字色: getComputedStyle(document.getElementById('sp-val')).color,
                      字体: getComputedStyle(document.getElementById('sp-val')).fontFamily.split(',')[0],
                      速度值: document.getElementById('sp-val').textContent,
                      退出按钮: document.getElementById('sp-exit').textContent
                    }]);
                  }, 700);
                }, 600);
              }, 900);
              return;
            }
            /* ?shot=toc：摆好左侧目录面板让截图（书籍信息 + 列表 + 胶囊滚动条） */
            if (shot === 'toc') {
              setTimeout(function () {
                document.getElementById('btn-toc').click();
                setTimeout(function () {
                  var inner = document.querySelector('#drawer-toc .drawer-inner').getBoundingClientRect();
                  dump('ACTOUT', [{
                    面板开着: document.getElementById('drawer-toc').classList.contains('open'),
                    宽占屏: Math.round(inner.width / window.innerWidth * 100) + '%',
                    书名: document.getElementById('toc-title').textContent,
                    副信息: document.getElementById('toc-meta').textContent,
                    当前章: (document.querySelector('#toc-list .toc-item.cur') || {}).textContent,
                    滚动条: !document.getElementById('toc-sbar').classList.contains('hide')
                  }]);
                }, 700);
              }, 900);
              return;
            }
            /* ?shot=setpanel：摆好阅读设置面板让截图（字号 / 背景 / 翻页 / 底部分隔行） */
            if (shot === 'setpanel') {
              setTimeout(function () {
                document.getElementById('btn-set').click();
                setTimeout(function () {
                  dump('ACTOUT', [{
                    面板开着: document.getElementById('sheet-readset').classList.contains('open'),
                    字号: document.getElementById('rs-fs-val').textContent,
                    字体: document.getElementById('rs-font-name').textContent,
                    选中背景: (document.querySelector('#rs-theme .rs-dot.on') || { getAttribute: function () { return '无'; } }).getAttribute('data-theme'),
          /* 「翻页方式」已撤掉，这里不再断言它的选中态 */
                    自动翻页: document.getElementById('rs-auto').textContent,
                    面板高: Math.round(document.querySelector('.rs-panel').getBoundingClientRect().height)
                  }]);
                }, 600);
              }, 900);
              return;
            }
            /* ?shot=light：摆好亮度面板让截图（两行式：滑条 + 跟随系统开关） */
            if (shot === 'light') {
              setTimeout(function () {
                document.getElementById('btn-light').click();
                setTimeout(function () {
                  dump('ACTOUT', [{
                    面板开着: document.getElementById('sheet-light').classList.contains('open'),
                    亮度: document.getElementById('brightness').value,
                    已激活轨道: document.getElementById('lp-fill').style.width,
                    圆滑块: document.getElementById('lp-knob').style.left,
                    开关: document.getElementById('lp-switch').classList.contains('on') ? '开' : '关',
                    面板高: Math.round(document.querySelector('.light-panel').getBoundingClientRect().height)
                  }]);
                }, 500);
              }, 900);
              return;
            }
            /* ?shot=foot / night：摆好新 UI 让截图（两条栏都在，不滚到底） */
            if (shot === 'foot' || shot === 'night') {
              setTimeout(function () {
                if (shot === 'night') document.getElementById('btn-night').click();
                setTimeout(function () {
                  dump('ACTOUT', [{
                    画面: shot,
                    主题: document.documentElement.getAttribute('data-theme'),
                    章节: document.getElementById('fc-title').textContent,
                    顶栏: document.getElementById('btn-back').textContent.trim() + ' / ' + document.getElementById('btn-more').textContent.trim(),
                    功能键: [].map.call(document.querySelectorAll('.fm-btn'), function (b) { return b.textContent.trim(); }).join(' '),
                    底栏高: Math.round(document.getElementById('reader-foot').getBoundingClientRect().height)
                  }]);
                }, 600);
              }, 900);
              return;
            }
            document.querySelector('#auto-pick .pill[data-auto="0"]').click();   // 别让它在截图时翻走
            var el = document.getElementById('reader-body');
            var n = 0;
            (function push2() {
              el.scrollTop = el.scrollHeight;
              el.dispatchEvent(new Event('scroll'));
              if (++n < 6) setTimeout(push2, 120);
            })();
          }, 900);
        }, 700);
      }, 700);
    }
  }

  /* ?act=continue：继续阅读便签的完整验收。
     验四件事：①有读过进度时显示、内容对 ②点它能进那本书
     ③一本都没读过时不显示（且不占位） ④编辑架子时让位 */
  if (q.get('act') === 'continue') {
    var log5 = [], errs5 = [];
    window.onerror = function (msg, src, line) { errs5.push(msg + ' @' + line); };
    var card = document.getElementById('btn-continue');
    function snap5(tag) {
      var on = getComputedStyle(card).display !== 'none';
      var rc = card.getBoundingClientRect();
      var rsh = document.querySelector('.shelf-canvas').getBoundingClientRect();
      var stage = document.querySelector('.shelf-stage');
      log5.push({
         步骤: tag,
         可见: on,
        书名: on ? document.getElementById('cc-name').textContent : '',
        副标题: on ? document.getElementById('cc-sub').textContent : '',
        进宽度: on ? Math.round(rc.width) : 0,
        左右留白: on ? Math.round(rc.left) + '/' + Math.round(window.innerWidth - rc.right) : '',
        架子宽度: Math.round(rsh.width),
        /* 不显示时卡片必须真的不占位：架子顶边应该跟空出卡片时一样 */
        卡片占位高: Math.round(rc.height),
        架子上留白: Math.round(rsh.top - document.querySelector('.shelf-head').getBoundingClientRect().bottom),
        书架页: document.getElementById('page-shelf').classList.contains('active')
      });
    }
    function wait5(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    wait5(900).then(function () {
      snap5('进 App（桩里第 1、4、7 本有进度）');
      return window.DB.getSlots().then(function (sl) {
        log5.push({ 架上: Object.keys(sl).length + ' 格',
                    桩里有进度的: [0, 3, 6].map(function (i) { return 'b' + i; }) });
      });
    }).then(function () {
      card.click();                                   // 点继续阅读 → 应该进那本书
      return wait5(1400);
    }).then(function () {
      log5.push({ 步: '点便签之后', 到了阅读页: document.getElementById('page-reader').classList.contains('active'),
                  章节标题: document.querySelector('.chapter-block .chapter-title').textContent,
                  页眉: document.getElementById('reader-title').textContent });
      document.getElementById('btn-back').click();
      return wait5(900);
    }).then(function () {
      snap5('返回书架');
      var e = document.getElementById('btn-edit');
      e.click();                                      // 编辑态应该收起来
      return wait5(900);
    }).then(function () {
      snap5('编辑态');
      document.getElementById('btn-edit').click();
      return wait5(900);
    }).then(function () {
      snap5('退出编辑态');
      log5.push({ 错误: errs5 });
      dump('ACTOUT', log5);
    });
  }

  /* ?act=io：数一数一次列表渲染到底开了多少次数据库事务。
     进度以前是一本一本地查（每本一个事务），改批量后应该跟书的本数无关。 */
  if (q.get('act') === 'io') {
    setTimeout(function () {
      var names = ['listBooks', 'getSlots', 'getProgress', 'allProgress', 'setProgress'];
      var cnt = {};
      names.forEach(function (k) {
        cnt[k] = 0;
        var f = window.DB[k];
        window.DB[k] = function () { cnt[k]++; return f.apply(window.DB, arguments); };
      });
      var log = [];
      function snap(tag) {
        var o = { 阶段: tag };
        names.forEach(function (k) { o[k] = cnt[k]; });
        log.push(o);
      }
      snap('计数清零');
      names.forEach(function (k) { cnt[k] = 0; });

      var listTab = document.querySelector('.tab[data-page=\'list\']');
      listTab.click();
      setTimeout(function () {
        snap('切到列表页');
        var rosterBtn = document.getElementById('btn-roster');
        if (rosterBtn) rosterBtn.click();
        setTimeout(function () {
          snap('开花名册');
          var bodyEl = document.getElementById('list-body');
          var rows = document.querySelectorAll('#list-body .bk-row').length;
          log.push({ 调试: { 全书bk行数: document.querySelectorAll('.bk-row').length, listBody长度: bodyEl ? bodyEl.innerHTML.length : -1, 前200: bodyEl ? bodyEl.innerHTML.slice(0, 200) : '' } });
          log.push({ 列表行数: rows, 结论: cnt.getProgress === 0 ? '进度已走批量' : '还有 ' + cnt.getProgress + ' 次单本查询' });
          dump('ACTOUT', log);
        }, 600);
      }, 800);
    }, 1200);
  }

  }, 80);

})();
