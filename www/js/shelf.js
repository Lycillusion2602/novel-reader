/**
 * 多宝格书架渲染器 —— 数据驱动，不写死
 *
 * 设计原则：
 * 1. 骨架（横板 H / 竖撑 V / 格子 SLOTS）全部是配置，可外部替换，也可存 localStorage。
 * 2. 格子里的「放什么」由 slot.type 决定，渲染器可注册 —— 现在是 books，
 *    以后想摆小挂件就 Shelf.register('ornament', fn) 加一个，不用改这里的代码。
 * 3. 书的颜色统一走绿色系（只用明度/饱和度区分，不引入别的色相）。
 * 4. 格子只描述「大概在哪」，真正的可摆放范围由 fitSlot() 贴着木板算出来，
 *    保证书永远坐在板上、夹在竖撑之间 —— 不会和架子互相穿插（穿模）。
 *
 * 用法：
 *   Shelf.render(el, {
 *     items:  [{id,title,pct}],       // 书库里所有的书
 *     layout: {s0:['b1','b2']},       // 哪个格子摆了哪几本（每格有序）
 *     edit:   false,                  // 编辑态：显示虚线框 / 容量 / 移除标记
 *     onItem: fn(it),                 // 普通态点书
 *     onSlot: fn(idx, info),          // 编辑态点格子
 *     onRemove: fn(it, idx)           // 编辑态点书
 *   })
 *   Shelf.configure({ SLOTS: [...] }, true)     // 第二个参数 true = 存起来
 *   Shelf.register('ornament', function (ctx) { return '<svg片段>'; })
 *   Shelf.slotInfo()                            // [{id,name,index,cap,...}]
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'yandu.shelf.config';

  /* ---------------- 默认配置 ---------------- */
  var DEFAULTS = {
    cx: 200, cy: 200,      // 圆心
    r: 168,                // 内径
    ring: 9,               // 圆环宽度
    T: 8,                  // 板厚
    fillet: 6,             // 倒角半径（0 = 硬直角）
    endRound: 2.5,         // 板端圆角

    /* 骨架：横板 [x1, y, x2] / 竖撑 [x, y1, y2]（400×400 画布） */
    H: [
      [38, 157, 192],
      [250, 294, 339],
      [37, 240, 250],
      [78, 315, 177],
      [192, 131, 285],
      [229, 204, 366]
    ],
    V: [
      [192, 34, 157],
      [285, 131, 204],
      [137, 157, 240],
      [250, 204, 294]
    ],

    /* 格子：[x, y, w, h]（左上角 + 宽高）。
       id   格子编号，摆位数据靠它对号入座
       cap  最多放几本；不写就按可用宽度 / 标准书脊宽算
       type 里面放什么（books / ornament）
       name 展示用名字，不写就叫「第 N 格」 */
    SLOTS: [
      { id: 's0', x: 198, y: 46,  w: 72,  h: 78, type: 'books' },
      { id: 's1', x: 88,  y: 76,  w: 98,  h: 74, type: 'books' },
      { id: 's2', x: 38,  y: 158, w: 96,  h: 76, type: 'books' },
      { id: 's3', x: 144, y: 164, w: 52,  h: 72, type: 'books' },
      { id: 's4', x: 70,  y: 250, w: 104, h: 60, type: 'books' },
      { id: 's5', x: 294, y: 130, w: 56,  h: 66, type: 'books' },
      { id: 's6', x: 228, y: 138, w: 50,  h: 58, type: 'books' },
      { id: 's7', x: 258, y: 212, w: 84,  h: 78, type: 'books' }
    ],

    /* 配色：只用绿色系，靠明暗/色相区分不同书。
       刻意收窄了明度跨度 —— 原来那版有 #1F4A33（太黑）和 #6A9E7C（太粉），
       摆在一起像两家出版社凑的货。现在最暗到最亮只差一档半，是一套。 */
    greens: ['#2E6B4A', '#3D7A57', '#4E8A63', '#2A5F45', '#578F6D', '#356B4E', '#456F57', '#5C9470'],

    /* 编辑态里表示「移除」的一点红，只用在小标记上，不参与书脊配色 */
    markColor: '#B4553F',

    /* 书脊尺寸。
       idealW  一本不挤的时候多宽（只在「格子宽度够」时作为上限用）
       minW    再挤也不能比这个窄
       maxW    单本最宽 —— 一格只放一本时不让它胖成一块砖
       gap     相邻两本之间的缝（1.3，够看见又不散）
       thick   书高占格子净高的比例区间，0.80~1.00 —— 高低错落保留
       lean    格子没放满时，最后一本书往回靠的角度（度）。0 = 都立正
       craft   true = 画书脊的立体感（圆柱明暗/堵头布/落板暗部）。false = 老的平涂 */
    book: {
      idealW: 17, minW: 11, maxW: 23, gap: 1.3, fontSize: 10,
      thickLo: 0.80, thickHi: 1.00, lean: 4.5, craft: true
    },

    /* 书名超过这个字数就不写字了，改标序号（配一本花名册对号） */
    titleMax: 4
  };

  var cfg = JSON.parse(JSON.stringify(DEFAULTS));

  /* ---------------- 配置读写 ---------------- */
  function loadConfig() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) cfg = merge(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(raw));
    } catch (e) { /* 读不到就用默认 */ }
    return cfg;
  }
  function merge(a, b) {
    Object.keys(b || {}).forEach(function (k) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = merge(a[k] || {}, b[k]);
      else a[k] = b[k];
    });
    return a;
  }
  function configure(patch, persist) {
    cfg = merge(cfg, patch || {});
    if (persist) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
    }
    return cfg;
  }
  function resetConfig() {
    cfg = JSON.parse(JSON.stringify(DEFAULTS));
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    return cfg;
  }

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function hash(s) {
    var h = 0;
    for (var i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
    return h;
  }
  /* 带圈序号：①②…⑳，超过 20 就用 [21] 这种。
     花名册靠它对号，所以序号必须稳定（由 app.js 按导入顺序编好塞进 item.seq）。 */
  function circled(n) {
    n = +n || 0;
    if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1);
    return '[' + n + ']';
  }

  /* 书名清洗：去掉书名号/括号这类装饰，顺便压掉首尾空白。
     判断"几个字"要按清洗后的算 —— 《三体》 就是 2 个字，能完整写下来。 */
  function cleanTitle(t) {
    return String(t || '').replace(/[《》〈〉【】\[\]（）()「」『』"'“”‘’\s]/g, '') || '无题';
  }

  function f(n) { return Number(n).toFixed(1); }


  /* ---------------- 倒角：木工 fillet ----------------
     两块板相交的内角：沿两边各退 r，再用半径 r 的弧把两点连起来，
     补出的这块料把 90° 硬角磨成圆滑过渡。只有两侧都有板料的角才是内角。 */
  function filletPaths(r) {
    if (!(r > 0.2)) return '';
    var T = cfg.T, d = '';
    cfg.H.forEach(function (h) {
      var hx1 = Math.min(h[0], h[2]), hx2 = Math.max(h[0], h[2]), hy = h[1];
      cfg.V.forEach(function (v) {
        var vx = v[0], vy1 = Math.min(v[1], v[2]), vy2 = Math.max(v[1], v[2]);
        if (vx + T / 2 < hx1 || vx - T / 2 > hx2) return;
        if (hy + T / 2 < vy1 || hy - T / 2 > vy2) return;
        var x0 = vx - T / 2, x1 = vx + T / 2, y0 = hy - T / 2, y1 = hy + T / 2;
        var cs = [
          { c: [x0, y0], ok: hx1 < x0 - 0.5 && vy1 < y0 - 0.5, d1: [-1, 0], d2: [0, -1] },
          { c: [x1, y0], ok: hx2 > x1 + 0.5 && vy1 < y0 - 0.5, d1: [1, 0], d2: [0, -1] },
          { c: [x1, y1], ok: hx2 > x1 + 0.5 && vy2 > y1 + 0.5, d1: [1, 0], d2: [0, 1] },
          { c: [x0, y1], ok: hx1 < x0 - 0.5 && vy2 > y1 + 0.5, d1: [-1, 0], d2: [0, 1] }
        ];
        cs.forEach(function (k) {
          if (!k.ok) return;
          var C = k.c;
          var A = [C[0] + r * k.d1[0], C[1] + r * k.d1[1]];
          var B = [C[0] + r * k.d2[0], C[1] + r * k.d2[1]];
          var O = [C[0] + r * (k.d1[0] + k.d2[0]), C[1] + r * (k.d1[1] + k.d2[1])];
          // 用 A-O、B-O 的实际坐标算极角（别用 angle(-d)，d 里的 0 会产生 -0 而算错）
          var tA = Math.atan2(A[1] - O[1], A[0] - O[0]);
          var tB = Math.atan2(B[1] - O[1], B[0] - O[0]);
          var dt = tB - tA;
          while (dt <= -Math.PI) dt += 2 * Math.PI;
          while (dt > Math.PI) dt -= 2 * Math.PI;
          d += '<path d="M' + f(A[0]) + ' ' + f(A[1]) +
               ' A' + f(r) + ' ' + f(r) + ' 0 0 ' + (dt > 0 ? 1 : 0) + ' ' + f(B[0]) + ' ' + f(B[1]) +
               ' L' + f(C[0]) + ' ' + f(C[1]) + ' Z"/>';
        });
      });
    });
    return d;
  }

  function frameSVG() {
    var T = cfg.T, body = '', hi = '';
    cfg.H.forEach(function (p) {
      var x = Math.min(p[0], p[2]), w = Math.abs(p[2] - p[0]), y = p[1];
      body += '<rect x="' + f(x) + '" y="' + f(y - T / 2) + '" width="' + f(w) + '" height="' + T +
              '" rx="' + cfg.endRound + '"/>';
      hi += '<rect x="' + f(x + 1.6) + '" y="' + f(y - T / 2 + 0.7) + '" width="' + f(w - 3.2) +
            '" height="1.1" rx="0.5"/>';
    });
    cfg.V.forEach(function (p) {
      var x = p[0], y = Math.min(p[1], p[2]), h = Math.abs(p[2] - p[1]);
      body += '<rect x="' + f(x - T / 2) + '" y="' + f(y) + '" width="' + T + '" height="' + f(h) +
              '" rx="' + cfg.endRound + '"/>';
      hi += '<rect x="' + f(x - T / 2 + 0.7) + '" y="' + f(y + 1.6) + '" width="1.1" height="' + f(h - 3.2) +
            '" rx="0.5"/>';
    });
    var fl = filletPaths(cfg.fillet);
    return { body: body + fl, hi: hi };
  }

  /* ---------------- 格子贴合：防穿模 ----------------
     用户给的 SLOTS 是「大概这块地方」，能放书的范围要以木板为准，
     不然书会陷进板里或者盖住竖撑（就是穿模）：

       · 底边附近有横板  → 书底坐在板的上表面  y - T/2
       · 顶边附近有横板  → 书顶最多到板的下沿  y + T/2
       · 左右有竖撑      → 书往里收到撑的内侧面 x ± T/2

     一块板只要在 10px 以内、并且横向盖住格子的大部分，就算这块格的边界。
     盖不住的不认 —— 板只到一半时，书不该被那半截挡住。 */
  function fitSlot(s) {
    var T = cfg.T;
    var x0 = s.x, x1 = s.x + s.w, top = s.y, bottom = s.y + s.h;

    // 重叠够不够「托得住」：盖住 60% 以上，或者只差 6px 以内没盖满
    function coverOK(a1, a2, b1, b2) {
      var span = b2 - b1;
      var ov = Math.min(a2, b2) - Math.max(a1, b1);
      return ov >= Math.min(0.6 * span, Math.max(0, span - 6));
    }
    function nearH(edge) {
      var best = null;
      cfg.H.forEach(function (h) {
        var hy = h[1], hx1 = Math.min(h[0], h[2]), hx2 = Math.max(h[0], h[2]);
        if (Math.abs(hy - edge) > 10) return;
        if (!coverOK(hx1, hx2, x0, x1)) return;
        if (best === null || Math.abs(hy - edge) < Math.abs(best - edge)) best = hy;
      });
      return best;
    }
    function nearV(edge) {
      var best = null;
      cfg.V.forEach(function (v) {
        var vx = v[0], vy1 = Math.min(v[1], v[2]), vy2 = Math.max(v[1], v[2]);
        if (Math.abs(vx - edge) > 10) return;
        if (!coverOK(vy1, vy2, top, bottom)) return;
        if (best === null || Math.abs(vx - edge) < Math.abs(best - edge)) best = vx;
      });
      return best;
    }

    var hb = nearH(bottom); if (hb !== null) bottom = hb - T / 2;
    var ht = nearH(top);    if (ht !== null) top = ht + T / 2;
    var vl = nearV(x0);     if (vl !== null) x0 = vl + T / 2;
    var vr = nearV(x1);     if (vr !== null) x1 = vr - T / 2;

    // 兜底：万一算出来太窄，还用原始范围，宁可轻微贴边也别把格子算没了
    if (x1 - x0 < 12) { x0 = s.x; x1 = s.x + s.w; }
    if (bottom - top < 22) { top = s.y; bottom = s.y + s.h; }

    return { x0: x0, x1: x1, top: top, bottom: bottom, w: x1 - x0, h: bottom - top };
  }

  /* 一格能放几本：配了 cap 就用 cap（但不能小到书挤成一条），
     没配就按可用宽度 / 标准书脊宽算 */
  function capacityOf(s, fit) {
    var byW = Math.max(1, Math.floor((fit.w - 3) / cfg.book.idealW));
    if (s.cap && s.cap > 0) {
      return Math.max(1, Math.min(s.cap, Math.max(1, Math.floor((fit.w - 3) / cfg.book.minW))));
    }
    return Math.max(1, byW);
  }

  /* ---------------- 内容渲染器（按 type 分派，可扩展） ---------------- */
  var RENDERERS = {};

  function register(type, fn) { RENDERERS[type] = fn; }

  /* 书：竖排书脊，统一绿色系，高低按 hash 错落（这是她要保留的亮点）。
     书底一律坐在格子底板上，书顶不越过顶板 —— 不会和架子穿插。

     书脊上写什么：
       · 书名 ≤ 4 个字（书名号不算）→ 完整竖排写在书脊上
       · 超过 4 个字 → 不写字，画一个带圈序号（①），配花名册对号
         竖排长书名在 15px 宽的书脊上根本没法看，不如干脆标号。 */
  RENDERERS.books = function (ctx) {
    var items = ctx.items, fit = ctx.fit, out = '';
    if (!items.length) return '';

    var B = cfg.book;
    var ft = B.fontSize, gap = B.gap;
    var x = fit.x0 + 1.5;
    var bottom = fit.bottom;
    var room = fit.bottom - fit.top - 1;          // 可摆放净高
    var lo = B.thickLo, hi = B.thickHi;
    var n = items.length;
    var slack = ctx.cap - n;                      // 还剩几个空位

    items.forEach(function (it, k) {
      var hv = hash(it.title || '');
      var step = ((hv >> 3) % 21) / 20;                      // 0 ~ 1
      var thick = lo + step * (hi - lo);                     // lo ~ hi 的槽高
      var bh = Math.max(24, Math.min(room, room * thick));
      // 先把书顶对齐到 0.1 精度，再反推高度，这样 y+h 严格等于底板面，
      // 不会因两次四舍五入差出 0.1px 的缝（看着像悬空）
      var by = Math.round((bottom - bh) * 10) / 10;
      bh = Math.round((bottom - by) * 10) / 10;
      var color = cfg.greens[hv % cfg.greens.length];
      var w = (ctx.widths && ctx.widths[k]) || B.idealW;

      /* 靠着：格子没放满时，最后一本往回倒一点（靠在前一本身上）。
         绕左下角转，头顶最高只抬高 ~0.08×书宽（不到 2px），所以留 3px 余量就够，
         不会顶穿上面的板。觉得别扭就把 cfg.book.lean 设成 0，全部立正。 */
      var lean = 0;
      if (B.lean > 0 && k === n - 1 && k > 0 && slack > 0 && (by - fit.top) >= 3) lean = -B.lean;

      var name = cleanTitle(it.title);
      var shortName = name.length <= (cfg.titleMax || 4);
      /* 太窄就别硬塞字，挤满边反而脏。但**带圈序号必须画**——
         它是这本书在花名册里的名字，画不出来等于这本书认不出来了，所以门槛放低到 11。 */
      var showText = shortName ? (w >= 12.2) : (w >= 11);

      var tf = lean ? ' transform="rotate(' + f(lean) + ' ' + f(x) + ' ' + f(bottom) + ')"' : '';
      out += '<g class="bk" data-book-id="' + esc(it.id) + '" data-slot="' + ctx.index +
             '" data-no="' + (it.no || 0) + '" data-title="' + esc(it.title || '') + '"' + tf + '>';

      if (!B.craft) {
        out += '<rect x="' + f(x) + '" y="' + f(by) + '" width="' + f(w) + '" height="' + f(bh) +
               '" rx="1.6" fill="' + color + '"/>';
      } else {
        // 书脊本体
        out += '<rect x="' + f(x) + '" y="' + f(by) + '" width="' + f(w) + '" height="' + f(bh) +
               '" rx="1.4" fill="' + color + '"/>';
        // 圆柱明暗：书脊是包在圆背上的，两侧压暗、偏左有一道高光。
        // 这一层是"它是一本书"而不是"一个绿方块"的关键
        out += '<rect x="' + f(x) + '" y="' + f(by) + '" width="' + f(w) + '" height="' + f(bh) +
               '" rx="1.4" fill="url(#spineShade)"/>';
        // 落在板上那一截压暗（接触影）
        out += '<rect x="' + f(x) + '" y="' + f(bottom - 2.6) + '" width="' + f(w) +
               '" height="2.6" rx="1.3" fill="rgba(0,0,0,.20)"/>';
        // 书顶那条边（迎光）
        out += '<rect x="' + f(x + 0.7) + '" y="' + f(by + 0.7) + '" width="' + f(w - 1.4) +
               '" height="0.9" rx="0.45" fill="rgba(255,255,255,.42)"/>';
        // 堵头布：上下两道装饰环带
        out += '<rect x="' + f(x) + '" y="' + f(by + 3.4) + '" width="' + f(w) +
               '" height="1.3" fill="rgba(255,255,255,.30)"/>';
        out += '<rect x="' + f(x) + '" y="' + f(bottom - 6.0) + '" width="' + f(w) +
               '" height="1.3" fill="rgba(255,255,255,.22)"/>';
        // 右缘暗缝：把相邻两本分开，不然糊成一条
        out += '<rect x="' + f(x + w - 0.9) + '" y="' + f(by + 1.2) + '" width="0.9" height="' + f(bh - 1.4) +
               '" fill="rgba(0,0,0,.22)"/>';
      }

      /* 阅读进度：不再拿一层白把下半本洗白（那样整排书看着发灰）。
         改成"已读部分极淡地提亮 + 交界处一道米色细线"，像夹了张书签。 */
      var ph = it.pct > 0 ? Math.max(2, bh * Math.min(1, it.pct / 100)) : 0;
      if (ph) {
        out += '<rect x="' + f(x) + '" y="' + f(bottom - ph) + '" width="' + f(w) + '" height="' + f(ph) +
               '" rx="1.2" fill="rgba(255,255,255,.09)"/>';
        out += '<rect x="' + f(x) + '" y="' + f(bottom - ph) + '" width="' + f(w) +
               '" height="1.6" fill="#EDE8DA" fill-opacity=".9"/>';
      }

      // 编辑态：书脊上盖一个「移除」小标记
      if (ctx.edit) {
        var cR = Math.min(4.6, w / 2 - 0.6);
        var cxx = x + w / 2, cyy = by + 6.5;
        out += '<circle cx="' + f(cxx) + '" cy="' + f(cyy) + '" r="' + f(cR) + '" fill="#FFF" fill-opacity=".93" stroke="' +
               cfg.markColor + '" stroke-width="1"/>';
        out += '<path d="M' + f(cxx - cR * 0.45) + ' ' + f(cyy - cR * 0.45) +
               'L' + f(cxx + cR * 0.45) + ' ' + f(cyy + cR * 0.45) +
               'M' + f(cxx + cR * 0.45) + ' ' + f(cyy - cR * 0.45) +
               'L' + f(cxx - cR * 0.45) + ' ' + f(cyy + cR * 0.45) +
               '" stroke="' + cfg.markColor + '" stroke-width="1.1" stroke-linecap="round" fill="none"/>';
      }

      /* ---------- 书名的书写安全区 ----------
         书脊最上和最下各有装饰白边（书顶高光 + 上下两道堵头布 + 落板暗部），
         书名顶到头会把它们盖掉 —— 所以先划一块安全区，字只写在这里面。
         上让 8px（编辑态还得给「移除」圆让位，16px）、下让 9px。
         字号按"整段书名塞得进这个区"反算：塞得下就写全名，塞不下才缩字号，
         不再像以前那样硬截断（截完还会压在堵头布上）。 */
      var padTop = ctx.edit ? 16 : 8;
      var padBot = 9;
      var yTop = by + padTop;
      var yBot = bottom - padBot;
      /* 尽量别压到书签线；但如果"避开书签线"就把区压没了（矮书 + 读到八成），
         那就用满整个区 —— 书名看不见比压到一条 1.6px 的线严重得多，
         而且字是最后画的，本来就盖在线上面。 */
      var yBotSafe = Math.min(yBot, bottom - Math.max(padBot, ph + 2));
      var avail = (yBotSafe - yTop >= 12) ? (yBotSafe - yTop) : (yBot - yTop);
      var FSMIN = 6;                                   // 再小就看不清了
      var GAPV = 2.2;                                  // 竖排字距
      var DESC = 0.15;                                 // 末字基线以下还占一点（降部）

      if (showText) {
        if (shortName) {
          var L = name.length;
          var maxW = w - 3.6;                          // 横向：字不能顶到书脊两边
          // 竖向总高 = (L-1)*(fs+GAPV) + fs*(1+DESC) ≤ avail
          var fs2 = Math.min(ft, maxW, (avail - (L - 1) * GAPV) / (L + DESC));
          if (fs2 < FSMIN) {
            // 极矮的书：字号守在下限，改成少写几个字，也比糊成一团强
            fs2 = FSMIN;
            L = Math.max(1, Math.floor((avail + GAPV) / (FSMIN * (1 + DESC) + GAPV)));
          }
          if (avail >= FSMIN) {
            var lead = fs2 + GAPV;
            for (var i = 0; i < L; i++) {
              out += '<text x="' + f(x + w / 2) + '" y="' + f(yTop + fs2 + i * lead) +
                     '" font-size="' + f(fs2) + '" fill="rgba(255,255,255,.95)" text-anchor="middle" ' +
                     'font-family="Songti SC,SimSun,serif" pointer-events="none">' + esc(name.charAt(i)) + '</text>';
            }
          }
        } else {
          // 长书名 → 带圈序号。这是这本书的"脸"，给足字号，但同样不出安全区
          var label = circled(it.no);
          var lfs = label.length > 1 ? Math.min(9, w * 0.66) : Math.min(13, w * 0.78);
          lfs = Math.min(lfs, w - 3.6, Math.max(FSMIN - 0.5, avail / (1 + DESC)));
          if (avail >= FSMIN - 0.5) {
            out += '<text x="' + f(x + w / 2) + '" y="' + f(yTop + lfs) +
                   '" font-size="' + f(lfs) + '" fill="#fff" ' +
                   'text-anchor="middle" font-family="Songti SC,SimSun,serif" ' +
                   'font-weight="600" pointer-events="none">' + esc(label) + '</text>';
          }
        }
      }
      out += '</g>';
      x += w + gap;
    });
    return out;
  };

  /* 摆件占位：现在画一个小陶罐剪影。以后换成印章/香炉/竹枝，
     只要注册新的 type 或改这个函数，不用动别的地方。 */
  RENDERERS.ornament = function (ctx) {
    var s = ctx.slot, fit = ctx.fit || s, out = '';
    var n = Math.max(1, Math.floor((fit.w || s.w) / 26));
    for (var i = 0; i < n; i++) {
      var cxp = (fit.x0 || s.x) + (fit.w || s.w) * (i + 0.5) / n;
      var cyp = (fit.bottom || (s.y + s.h)) - 12;
      out += '<g class="orn" data-slot="' + ctx.index + '" data-slot-id="' + esc(ctx.slot.id || '') + '">' +
             '<path d="M' + f(cxp - 6) + ' ' + f(cyp) + ' q0 -10 6 -14 q6 4 6 14 z" fill="#245539" opacity=".85"/>' +
             '<rect x="' + f(cxp - 3) + '" y="' + f(cyp - 18) + '" width="6" height="4" rx="1.5" fill="#1F4A33"/>' +
             '</g>';
    }
    return out;
  };

  /* ---------------- 编辑态覆盖层 ---------------- */
  /* 触摸热区：按格子最初划定的矩形（比贴合算出来的范围大一圈）铺一块透明矩形。
     手指点在板缝、边角上也算点到这一格 —— 不然稍微偏一点就没反应，
     用起来就像「这格子根本不能点」。
     它排在书下面一层，所以点书仍然是「移除」。 */
  function slotHit(ctx) {
    var s = ctx.slot, pad = 5;
    return '<rect class="slothit" data-slot="' + ctx.index + '" ' +
      'x="' + f(s.x - pad) + '" y="' + f(s.y - pad) + '" ' +
      'width="' + f(s.w + pad * 2) + '" height="' + f(s.h + pad * 2) + '" rx="4" ' +
      'fill="transparent"/>';
  }

  /* 虚线框：能加是绿框，满了是灰框。空格子正中画一个加号，
     一眼能看出「这里能点、点了能加书」。 */
  function slotBox(ctx) {
    var fit = ctx.fit, n = ctx.items.length, full = n >= ctx.cap;
    var color = full ? '#9A9A95' : '#2E6B4A';
    var o = '<rect class="slotbox" data-slot="' + ctx.index + '" ' +
      'x="' + f(fit.x0 + 1) + '" y="' + f(fit.top + 1) + '" ' +
      'width="' + f(fit.w - 2) + '" height="' + f(fit.h - 2) + '" rx="4" ' +
      'fill="' + (full ? 'rgba(154,154,149,.12)' : 'rgba(255,255,255,.52)') + '" ' +
      'stroke="' + color + '" stroke-width="1.6" stroke-dasharray="5 4" pointer-events="none"/>';
    if (!n) {
      o += '<text x="' + f((fit.x0 + fit.x1) / 2) + '" y="' + f((fit.top + fit.bottom) / 2 + 9) +
        '" font-size="26" fill="' + color + '" fill-opacity=".58" text-anchor="middle" ' +
        'font-family="-apple-system,PingFang SC,Microsoft YaHei,sans-serif" ' +
        'font-weight="300" pointer-events="none">+</text>';
    }
    return o;
  }

  /* 容量角标：n/m，画在格子顶部正中，白底圆角条保证压在书上也能看清。
     尺寸是按 400 画布给的：真机上架子会被缩到 0.9 左右，所以字至少 10.5 才读得出来
     （原来 7.2，缩完只有 6px 多，等于看不见）。 */
  function slotBadge(ctx) {
    var fit = ctx.fit, full = ctx.items.length >= ctx.cap;
    var label = ctx.items.length + '/' + ctx.cap;
    var fs = 10.5, w = fs * 0.6 * label.length + 13, h = 15.6;
    var cx = (fit.x0 + fit.x1) / 2, y = fit.top + 2.4;
    return '<g class="slotbadge" data-slot="' + ctx.index + '" pointer-events="none">' +
      '<rect x="' + f(cx - w / 2) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) +
      '" rx="' + f(h / 2) + '" fill="' + (full ? '#9A9A95' : '#2E6B4A') + '" fill-opacity=".95"/>' +
      '<text x="' + f(cx) + '" y="' + f(y + fs + 1.4) + '" font-size="' + fs + '" fill="#fff" text-anchor="middle" ' +
      'font-family="-apple-system,PingFang SC,Microsoft YaHei,sans-serif" ' +
      'font-weight="600">' + label + '</text></g>';
  }

  /* ---------------- 主渲染 ---------------- */
  function render(el, opts) {
    opts = opts || {};
    var all = opts.items || [];
    var layout = opts.layout || {};
    var slots = cfg.SLOTS;

    var byId = {};
    all.forEach(function (b) { byId[String(b.id)] = b; });

    var fits = slots.map(fitSlot);
    var caps = slots.map(function (s, i) { return capacityOf(s, fits[i]); });

    /* 每格实际摆哪些：按 layout 里的顺序；书被删了就跳过；
       同一本书不会同时在两格；超过容量的截掉（防御，正常不该发生） */
    var seen = {};
    var per = slots.map(function (s, i) {
      var ids = (layout[s.id] || []).filter(function (id) {
        if (!byId[id] || seen[id]) return false;
        seen[id] = 1;
        return true;
      }).slice(0, caps[i]);
      return ids.map(function (id) { return byId[id]; });
    });

    /* 书脊宽度：一格一算，并且**每本都不一样宽**。
       原来取全局最小值 → 整架书全是同一个宽度，排出来像条码，这是"不好看"的主因。
       现在：按书名哈希给每本一个 0.82~1.18 的厚度系数，把该格可用宽度按系数分下去，
       再夹到 [minW, maxW]。同一格里的书有厚有薄，格与格之间也不互相拖累。 */
    var B0 = cfg.book, gapB = B0.gap;
    var widths = per.map(function (list, i) {
      if (!list.length) return [];
      var avail = fits[i].w - 3 - gapB * (list.length - 1);
      if (avail < list.length * B0.minW) avail = list.length * B0.minW;
      var j = list.map(function (it) {
        return 0.82 + ((hash(it.title || '') >> 7) % 37) / 100;   // 0.82 ~ 1.18
      });
      var sum = j.reduce(function (a, b) { return a + b; }, 0) || 1;
      var ws = j.map(function (v) {
        return Math.max(B0.minW, Math.min(B0.maxW, avail * v / sum));
      });
      // 夹完之后总量可能超出（很多本都顶到 maxW），整体缩回去
      var tot = ws.reduce(function (a, b) { return a + b; }, 0);
      if (tot > avail && tot > 0) {
        var k = avail / tot;
        ws = ws.map(function (v) { return Math.max(B0.minW * 0.9, v * k); });
      }
      return ws;
    });

    /* 三层：编辑框（书下面）→ 书 → 容量角标（书上面） */
    var under = '', content = '', over = '';
    var ctxs = slots.map(function (s, i) {
      return {
        slot: s, index: i, fit: fits[i], cap: caps[i],
        items: per[i], widths: widths[i], edit: !!opts.edit
      };
    });
    ctxs.forEach(function (ctx) {
      if (opts.edit) {
        under += '<g class="slotg" data-slot="' + ctx.index + '">' + slotHit(ctx) + slotBox(ctx) + '</g>';
      }
    });
    ctxs.forEach(function (ctx) {
      var fn = RENDERERS[ctx.slot.type];
      if (fn) content += fn(ctx);
    });
    ctxs.forEach(function (ctx) {
      if (opts.edit) over += slotBadge(ctx);
    });

    var R = cfg.r, cx = cfg.cx, cy = cfg.cy;
    var inner = frameSVG();          // 只算一次，三层复用
    var svg =
      '<svg class="bogu" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<linearGradient id="ringG" x1="0.1" y1="0" x2="0.9" y2="1">' +
          '<stop offset="0" stop-color="#FFFFFF"/><stop offset="0.5" stop-color="#F8F9F7"/>' +
          '<stop offset="1" stop-color="#DAE0DA"/></linearGradient>' +
        '<radialGradient id="backG" cx="0.4" cy="0.34" r="0.78">' +
          '<stop offset="0" stop-color="#DBE5DC"/><stop offset="1" stop-color="#C9D7CB"/></radialGradient>' +
        '<linearGradient id="plankG" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#FFFFFF"/><stop offset="0.62" stop-color="#FBFCFA"/>' +
          '<stop offset="1" stop-color="#EDF1ED"/></linearGradient>' +
        '<filter id="ringSh" x="-14%" y="-14%" width="128%" height="132%">' +
          '<feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="#96A79A" flood-opacity="0.42"/></filter>' +
        '<filter id="boguBlur" x="-25%" y="-25%" width="150%" height="160%">' +
          '<feGaussianBlur stdDeviation="1.6"/></filter>' +
        '<clipPath id="boguInner"><circle cx="' + cx + '" cy="' + cy + '" r="' + R + '"/></clipPath>' +
        /* 书脊的圆柱明暗：两侧压暗、偏左一道高光。用 objectBoundingBox（默认），
           所以一个渐变能给所有宽度不同的书脊复用。 */
        '<linearGradient id="spineShade" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0" stop-color="#000000" stop-opacity="0.30"/>' +
          '<stop offset="0.12" stop-color="#000000" stop-opacity="0.10"/>' +
          '<stop offset="0.34" stop-color="#FFFFFF" stop-opacity="0.16"/>' +
          '<stop offset="0.58" stop-color="#FFFFFF" stop-opacity="0.02"/>' +
          '<stop offset="0.86" stop-color="#000000" stop-opacity="0.14"/>' +
          '<stop offset="1" stop-color="#000000" stop-opacity="0.32"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + (R + cfg.ring) + '" fill="url(#ringG)" filter="url(#ringSh)"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + (R + 1.5) + '" fill="none" stroke="#A9B7AC" stroke-width="7" opacity="0.28"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="url(#backG)"/>' +
      '<g clip-path="url(#boguInner)">' +
        '<g filter="url(#boguBlur)" opacity="0.42"><g fill="#7E9484" transform="translate(1.7,3.4)">' + inner.body + '</g></g>' +
        '<g fill="url(#plankG)">' + inner.body + '</g>' +
        '<g fill="#FFFFFF" opacity="0.9">' + inner.hi + '</g>' +
        under + content + over +
      '</g>' +
      '</svg>';

    el.innerHTML = svg;

    /* ---------- 事件 ---------- */
    function pickBook(e) {
      var t = e.target;
      if (!t || !t.closest) return null;
      var g = t.closest('.bk');
      return g ? g.getAttribute('data-book-id') : null;
    }
    function pickSlot(e) {
      var t = e.target;
      if (!t || !t.closest) return -1;
      var g = t.closest('[data-slot]');
      return g ? parseInt(g.getAttribute('data-slot'), 10) : -1;
    }
    function itemOf(id) {
      return all.filter(function (x) { return String(x.id) === String(id); })[0] || { id: id };
    }
    function infoOf(i) {
      return {
        index: i,
        id: slots[i].id,
        name: slots[i].name || ('第 ' + (i + 1) + ' 格'),
        cap: caps[i],
        count: per[i].length,
        full: per[i].length >= caps[i],
        items: per[i]
      };
    }

    el.onclick = function (e) {
      // 长按已经把书拿下来了，紧接着浏览器补发的这次 click 要吃掉，
      // 不然会顺手把这本书打开（弹确认框的同时跳到阅读页）
      if (suppressClick) { suppressClick = false; return; }
      var id = pickBook(e), si = pickSlot(e);
      if (opts.edit) {
        if (id && si >= 0) { if (opts.onRemove) opts.onRemove(itemOf(id), infoOf(si)); return; }
        if (si >= 0) { if (opts.onSlot) opts.onSlot(infoOf(si)); return; }
        return;
      }
      if (id && opts.onItem) opts.onItem(itemOf(id));
    };

    // 普通态长按 = 直接从书架摘下来（不删书），保留原来的快捷操作
    // 注意 suppressClick 必须声明：shelf.js 是 'use strict'，
    // 读一个没声明的变量会直接抛 ReferenceError（点格子当场没反应）
    var timer = null, moved = false, px = 0, py = 0, suppressClick = false;
    el.onpointerdown = function (e) {
      /* ⚠️ 每一次"按下"都把上一次遗留的 suppressClick 清掉。
         这个标志的用途是：长按弹出"拿下来"之后，浏览器会补发一次 click，
         那次要点掉，不然确认框弹出来的同时书也打开了。
         但长按之后手指又挪了一段的话，浏览器**根本不会补发那次 click** ——
         标志就一直挂着，于是"下一次点书"白点一下（实测：长按拿书之后
         紧接着点架上另一本，第一次点击没反应，再点一下才开）。
         新的一次按下代表新的一次意图，遗留的屏蔽必须作废。 */
      suppressClick = false;
      clearTimeout(timer);
      if (opts.edit) return;
      moved = false;
      px = e.clientX; py = e.clientY;
      var id = pickBook(e);
      if (!id) return;
      timer = setTimeout(function () {
        if (moved) return;
        suppressClick = true;
        if (opts.onLongPress) opts.onLongPress(itemOf(id));
      }, 550);
    };
    // 手指挪动超过 8px 才算「在拖动」，否则轻微抖动就把长按取消了
    el.onpointermove = function (e) {
      if (Math.abs(e.clientX - px) > 8 || Math.abs(e.clientY - py) > 8) moved = true;
    };
    el.onpointerup = function () { clearTimeout(timer); };
    el.onpointercancel = function () { clearTimeout(timer); };

    var placed = per.reduce(function (a, l) { return a + l.length; }, 0);
    return {
      placed: placed,
      unplaced: Math.max(0, all.length - placed),
      capacity: caps.reduce(function (a, c) { return a + c; }, 0),
      slots: ctxs.map(function (c) { return infoOf(c.index); })
    };
  }

  /* 给外部用的格子清单（选书面板要显示「第 N 格 2/6」） */
  function slotInfo() {
    var slots = cfg.SLOTS;
    var fits = slots.map(fitSlot);
    return slots.map(function (s, i) {
      return {
        index: i,
        id: s.id,
        name: s.name || ('第 ' + (i + 1) + ' 格'),
        cap: capacityOf(s, fits[i]),
        type: s.type
      };
    });
  }

  global.Shelf = {
    render: render,
    register: register,
    configure: configure,
    getConfig: function () { return cfg; },
    resetConfig: resetConfig,
    slotInfo: slotInfo,
    // 同一本书在书架和列表里颜色要一致，所以取色也走这里
    colorOf: function (title) {
      var hv = hash(title || '');
      return cfg.greens[hv % cfg.greens.length];
    },
    // 花名册要跟书脊上画的符号完全一致，所以这两个也暴露出去
    circled: circled,
    cleanTitle: cleanTitle,
    needsNumber: function (title) {
      return cleanTitle(title).length > (cfg.titleMax || 4);
    },
    DEFAULTS: DEFAULTS
  };

  loadConfig();
})(window);
