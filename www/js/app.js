/**
 * 主逻辑：书架 / 书库列表 / 阅读 / 目录 / 设置 / 手势
 *
 * 两套数据要分清：
 *   · 书库（books）= 所有导入过的书，在「列表」页，可以搜、可以删、可以直接读
 *   · 书架（slots）= 哪个格子里摆了哪几本，在「书架」页，由用户自己摆
 * 从书架拿掉一本书，书还在书库里；从列表删除，才是真删。
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var DEFAULTS = {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', screenLight: 100,
    fontFamily: 'sans', autoNext: true,
    lightFollowSys: false,  // 亮度跟随系统：开着 = 砚读不压暗，亮度全交给系统
    /* 翻页方式。⚠️ 这不是"分页"—— 本 App 是一条连续的长书页，没有页可翻。
       这四个管的是**跳章时怎么过渡**（点上一章/下一章、拖进度条跳章）：
         覆盖 = 新内容从下往上滑上来   上下 = 直接跳（默认，最省）
         仿真 = 带透视的立体翻一下     平滑 = 平滑滚过去（不瞬间跳） */
    pageTurn: 'vscroll',
    autoPage: false,      // 自动翻页：匀速往下滚（速度可调）
    autoSpeed: 19         // 自动翻页速度：数值 ×4 = 每秒滚多少像素（19 ≈ 76px/s）
  };
  /* ⚠️ 只有"设置"能进 DEFAULTS（会被存进库并在启动时回填）。
     像"目录倒着排""现在是不是全屏"这种一次性的界面状态放在 state 里，别混进来。 */

  /* 字体族。安卓 WebView 里 serif 会落到 Noto Serif CJK，mono 落到等宽。
     ⚠️ 但很多机型压根没装中文衬线/等宽字体，切过去会静默回落到同一个黑体 ——
     表现就是"字体改了跟没改一样"。所以每个选项再配一个字距：
     就算字体没换，字距的变化也一定看得出来，选项不至于是个死开关。 */
  var FONTS = {
    sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", sans-serif',
    serif: '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif',
    mono: '"Noto Sans Mono CJK SC", "Courier New", monospace'
  };
  var LETTER = { sans: '0', serif: '0.012em', mono: '0.03em' };
  /* 阅读设置面板「思源… ›」那个按钮上显示的名字。
     真机上没装思源的话会回落到 Noto CJK（CSS 里就是这么排的），
     字距仍然会跟着变 —— 面板下面那行小字已经写明了。 */
  var FONT_NAME = { sans: '思源黑体', serif: '思源宋体', mono: '等宽' };

  var state = {
    book: null,
    index: 0,
    mark: null,
    settings: Object.assign({}, DEFAULTS),
    imersed: false,
    page: 'shelf',        // shelf | list | reader
    from: 'shelf',        // 从哪页进的阅读器，返回时回哪
    edit: false,          // 书架编辑态
    query: '',            // 列表搜索词
    pickSlot: null,       // 正在往哪一格加书
    autoHidden: false,    // 滚动自动隐藏（向下滑收起、向上滑/回顶显示）
    lastTop: 0,           // 上一次的滚动位置，用来判断方向
    streamSeq: 0,         // 整条卷轴重画的序号：换书/跳远章时让在飞的异步请求作废
    /* 连续卷轴：DOM 里同时挂着若干「章节块」，滑到哪就在前后接着补，多余的卸掉。
       每块的结构见 makeBlock()。数组顺序 = DOM 顺序 = 章节顺序，不要乱排。 */
    blocks: [],
    loading: {},          // 正在异步加载的章号，去重用的（否则一次滑动会连发好几个请求）
     pendingWant: null,    // 还欠着没落到位的目标：{blk, voff}，见 applyPendingTop（别存绝对 scrollTop）
    pageNo: 0,            // 分页模式下现在是第几页（从 0 起算），见分页引擎
     lastLightTheme: null, // 点「夜间」之前是哪套浅色主题，切回来还是它
     sysFull: false,       // 全屏沉浸：系统状态栏 + 导航栏都被藏起来了
     autoPauseUntil: 0,    // 自动翻页：手动滑过之后暂停到这个时间为止
     tocDesc: false,       // 目录倒着排
     tocAnchor: null       // 目录分批显示的窗口锚点（null = 以正在读的那一章为中心）
   };

  /* 一次往某一章里放多少段。需要时再追加下一批 —— 这样不管一章有多大，
     DOM 里最多也就几百段，老 WebView 也不会被排版拖死。
     ⚠️ 这个值以前是 160，真机上"一次建 160 段 + 强制排版"能把主线程占掉几百毫秒
        甚至几秒（段落越长越夸张）。64 段 ≈ 两屏半，滚动时当增量补也够用。 */
  var CHUNK = 64;

  /* DOM 里段落的**总量上限**。滚到底时 fillDown 会一路补下去（见 fillDown 里那条注释），
     没有这道闸，一本没切开的大书会把整章几万段全塞进来 —— 内存和排版都扛不住。
     4000 段 ≈ 五六十屏，正常阅读时 trimBlocks 早把远处的卸了，撞不到这个数。 */
  var FILL_MAX = 4000;
  function domParas() {
    var n = 0;
    for (var i = 0; i < state.blocks.length; i++) n += state.blocks[i].shown;
    return n;
  }

  /* 连续卷轴的几个数 */
  /* 本章「看到」这么多就把下一章接上来。
     取 3/4：留 1/4 的富余，IndexedDB 那一趟读（几毫秒到几十毫秒）早就回来了，
     人滑到本章最后一段时下一章已经在下面等着 —— 也就是看不见接缝。
     调小（比如 0.5）更保险但 DOM 里常年挂着更多章节；调大容易露出"断口"。 */
  var PRELOAD_AT = 0.75;
  /* 参考线：认为人已经读到这里的那条横线，取可视区顶部往下 1/4 屏处。
     取可视区顶会晚一屏（底下那一屏其实已经扫过了）；取底边又太早。 */
  var READ_FRAC = 0.25;
  /* DOM 里最多同时挂几章：往前留 1 章（为了能往上滑回去）+ 往后几章。
     章节大小上限是导入时兜住的（单章 >8000 字会再切小节），5 章撑不死老 WebView。 */
  var MAX_BLOCKS = 5;
  /* 往上离顶端不足这么多屏时把上一章接到上面去。
     给两屏富余是因为插入要等一次异步查库，贴着顶端会在快速上滑时顿一下。 */
  var UP_AT = 2;

  var saveTimer = null;
  var pendingTimer = null;   // 「还欠着的滚动位置」的兜底作废计时器
  var confirmCb = null;
  var loadingTimer = null;
  var scrollRaf = 0;      // 滚动回调的帧节流句柄（0 = 这一帧还没排队）
  var searchTimer = null; // 搜索去抖

  /* 我们自己写 scrollTop 的地方一共五处：自动翻页推进、preserve 的视线补偿、
     applyPendingTop 落位、moveTo 跳章、smoothScrollTo 的每一帧插值。
     ⚠️ scroll 回调必须分得清"是人在滑"还是"是我们自己动的"：前者要让自动翻页让位
        （不然两边对着拽），后者不该。以前只有一个 autoStep 标记，只盖住了自动翻页
        那一处，另外四处全漏 → 自动翻页每接一次章就自己停 1.2 秒。

     ⚠️ 但**别用时间窗判**（"离上一次写入不到 150ms 就算程序写的"）：自动翻页每 16ms
        就写一次，时间窗被它自己一直续期，真人的滑动反而永远识别不出来 ——
        等于把"让位"整个废掉。（这条是我自己先写成时间窗，被 selftest C6 的
        控制组照出来的：人在滑，autoPaused 却不亮。）
        现在记的是**上一次写进去、并且回读到的那个值**：事件到来时当前位置还等于它，
        就是我们自己动的；差出去 2px 以上，就是别人（人）挪的。
        写完再回读，是因为越界的目标值会被浏览器夹住，只有回读才是真落点。 */
  var progTop = null;
  function markProgScroll() { progTop = readerEl().scrollTop; }
  function looksProgrammatic() {
    return progTop !== null && Math.abs(readerEl().scrollTop - progTop) <= 2;
  }

  /* ---------------- 通用 ---------------- */
  function showPage(name) {
    state.page = name;
    ['shelf', 'list', 'reader'].forEach(function (p) {
      $('page-' + p).classList.toggle('active', p === name);
    });
    // 阅读页是全屏，底部导航收起来
    $('tabbar').style.display = name === 'reader' ? 'none' : '';
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-page') === name);
    });
    // 亮度遮罩只在阅读页压着，回到书架要散掉；主题也跟着进出（见 syncTheme）
    applyDim(state.settings.screenLight);
    syncTheme();
    /* 离开阅读页就把自动翻页停下 —— 不然它会在后台一直滚 */
    if (name !== 'reader') stopAutoPage(false);
    /* 后台续排也一样：离开阅读页就停，别在看不见的卷轴里继续建 <p> */
    if (typeof stopFill === 'function' && name !== 'reader') stopFill();
    /* 进阅读页自动全屏（藏掉状态栏 + 导航栏），出去就还原 */
    if (name === 'reader') enterImmersive(); else leaveImmersive();
    /* 进阅读页要看一眼分页那套：正文留白得按两条栏的真实高度让位，
       而栏只有在页面显示之后才量得到高度（见 applyPaged）。 */
    applyPaged();
    /* 走的意义是把可能还在飞的翻页动画收掉 —— 离开阅读页后它还浮在上面就成脏东西了 */
    if (typeof fxClear === 'function' && name !== 'reader') fxClear();
  }

  /* 遮罩：showLoading 带看门狗。
     万一某一步（尤其 IndexedDB）卡住不回调，遮罩会一直盖着 —— 表现就是
     「点了没反应、什么都操作不了」。给个上限，到点自己收掉并提示，绝不留死界面。
     ⚠️ 文案别写成"已经中止"：这一层只是把遮罩收掉、界面放开，
        那一步并没有真的被取消（Promise 没法取消），写着"已中止"反而误导人。 */
  function showLoading(txt, ms) {
    $('loading-text').textContent = txt || '处理中';
    $('loading').classList.add('on');
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(function () {
      $('loading').classList.remove('on');
      toast('这一步等太久了，先把界面放开 —— 可以返回再试一次');
    }, ms || 20000);
  }
  function hideLoading() {
    clearTimeout(loadingTimer);
    $('loading').classList.remove('on');
  }

  function toast(msg) {
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;bottom:112px;transform:translateX(-50%);' +
      'background:rgba(0,0,0,.82);color:#fff;padding:10px 18px;border-radius:20px;' +
      'font-size:14px;z-index:400;opacity:0;transition:opacity .2s;pointer-events:none;' +
      'max-width:80vw;text-align:center';
    document.body.appendChild(d);
    requestAnimationFrame(function () { d.style.opacity = '1'; });
    setTimeout(function () {
      d.style.opacity = '0';
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 250);
    }, 1500);
  }

  /* 通用确认面板。danger=true 时确定按钮变红（用于真删除） */
  function confirmSheet(opt) {
    $('confirm-title').textContent = opt.title || '';
    $('confirm-desc').textContent = opt.desc || '';
    $('confirm-yes').textContent = opt.okText || '确定';
    $('confirm-yes').classList.toggle('danger', !!opt.danger);
    confirmCb = opt.onOk || null;
    $('sheet-confirm').classList.add('open');
  }
  function closeConfirm() { $('sheet-confirm').classList.remove('open'); }

  function fmtSize(n) {
    return n >= 10000 ? (n / 10000).toFixed(1) + '万字' : n + '字';
  }

  /* ---------------- 长书名：滚动显示 ----------------
     书名太长时截成"…"等于没给信息。这里改成：放不下就让书名左右滚一遍。
     做法是外层盒子定宽裁剪，里层 <i class="ti"> 撑出真实宽度，
     量出超出的像素数写进 --roll，动画把它平移过去（alternate 来回）。
     量必须在元素已经进 DOM、排完版之后做，所以统一在列表建完后调 fitRolls()。 */
  function titleEl(cls, text) {
    var el = document.createElement('div');
    el.className = cls;
    var inner = document.createElement('i');
    inner.className = 'ti';
    inner.textContent = text;
    el.appendChild(inner);
    return el;
  }
  function fitRoll(el) {
    if (!el) return;
    var inner = el.firstChild;
    if (!inner) return;
    el.classList.remove('roll');
    var over = inner.offsetWidth - el.clientWidth;
    if (over > 4) {
      el.classList.add('roll');
      el.style.setProperty('--roll', Math.round(over) + 'px');
      el.style.setProperty('--dur', Math.max(5, Math.min(20, over / 30)).toFixed(1) + 's');
    }
  }
  function fitRolls(box) {
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('.pick-name, .bk-name'), fitRoll);
  }

  /* 把书库的书取出阅读进度，算成百分比。
     ⚠️ 进度**一次全读**（DB.allProgress），不是一本一本地查 ——
     后者每本开一个事务，40 本书就是 40 次 IO，书架/列表每次渲染都要付一遍。 */
  function withProgress(books) {
    return DB.allProgress().then(function (map) {
      return books.map(function (b) {
        var p = map[b.id];
        var toc = (b.toc && b.toc.length) ? b.toc : null;
        var done = 0;
        var curLen = 0;
        if (p && toc) {
          var upTo = Math.min(p.index, toc.length);
          for (var i = 0; i < upTo; i++) done += toc[i].len;
          curLen = toc[upTo] ? toc[upTo].len : 0;
        }
        /* 章内进度：scrollY 相对本章**估计高度**的比例。
           ⚠️ 只能估，因为这里拿不到真实渲染高度（那要把整章排版一遍）。
           按"本文字数 × 每字行高"折算一个大概值即可 —— 它的用途只是让
           "读到最后"能显示到接近 100%，不需要精确到小数点。
           阅读器里那个即时百分比走的是另一套（有真实 scrollHeight），更准。 */
        var ratio = 0;
        if (p && p.scrollY > 0 && curLen > 0) {
          /* 每 100 字大约占一屏（18px 正文、一行约 20 字，一屏约 25 行）——
             这是个粗估系数，只求量级对得上，不求准。 */
          var estPx = curLen / 100 * 800;
          ratio = Math.max(0, Math.min(1, p.scrollY / Math.max(estPx, 1)));
        }
        var pctChars = done + curLen * ratio;
        return {
          id: b.id,
          title: b.title,
          no: b.no || 0,               // 书脊上的序号（0 = 书名短，直接写字）
          totalChars: b.totalChars,
          chapters: toc ? toc.length : 0,
          addedAt: b.addedAt,
          pct: b.totalChars ? Math.min(100, pctChars / b.totalChars * 100) : 0,
          /* 继续阅读卡片要用：上次读的是第几章、读到哪儿、什么时候停的。
             趁这次批量读进度顺手带上，别为一张卡片再开一次 IO。 */
          read: p ? {
            index: p.index || 0,
            scrollY: p.scrollY || 0,
            chapter: toc && toc[p.index] ? toc[p.index].t : '',
            at: p.updatedAt || 0
          } : null
        };
      });
    });
  }

  /* 书脊编号：书名超过 4 个字的才编号，按导入顺序连续排 ① ② ③…
     只在"需要编号的那些书"里连续，所以第一本标号书就是 ①，不会出现断号。
     花名册是照同一份数据现生成的，所以以后加了新书、后面几位挪了号，
     屏幕上和册子里也永远对得上。 */
  function numberBooks(list) {
    var asc = list.slice().sort(function (a, b) { return a.addedAt - b.addedAt; });
    var n = 0;
    asc.forEach(function (b) { b.no = Shelf.needsNumber(b.title) ? (++n) : 0; });
    return list;
  }

  /* ---------------- 设置 ----------------
     ⚠️ 主题只打在 #page-reader 上，不打 documentElement。
     书架、列表还没做主题适配，跟着一起变会变成半吊子（尤其黑色主题，
     架子那套灰绿配色全被 --bg/--fg 顶掉，看着很怪）。
     等专门做主题模块那天再放开到全局。 */
  function applySettings() {
    var s = state.settings;
    document.documentElement.style.setProperty('--fs', s.fontSize + 'px');
    document.documentElement.style.setProperty('--lh', String(s.lineHeight));
    document.documentElement.style.setProperty('--ff', FONTS[s.fontFamily] || FONTS.sans);
    document.documentElement.style.setProperty('--ls', LETTER[s.fontFamily] || '0');
    syncTheme();
    applyDim(s.screenLight);
    // 底栏「夜间」键：开着就亮起来，一眼能看出现在是夜间模式
    $('btn-night').classList.toggle('on', s.theme === 'dark');
    $('fs-val').textContent = s.fontSize;
    $('lh-val').textContent = s.lineHeight.toFixed(1);
    $('brightness').value = s.screenLight;
    syncLight();          // 亮度面板那两行跟着设置走（设置里那个滑块改了也要跟上）
    syncReadSet();        // 阅读设置面板那四行同理
    applyPaged();          // 字号/行距/字体变了页边界就跟着变，重切一次
    Array.prototype.forEach.call(document.querySelectorAll('#theme-pick .dot'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-theme') === s.theme);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#font-pick .pill'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-font') === s.fontFamily);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#auto-pick .pill'), function (b) {
      b.classList.toggle('on', (b.getAttribute('data-auto') === '1') === !!s.autoNext);
    });
  }

  /* 主题挂在哪儿：只在阅读页时挂到 <html> 上。
     ⚠️ 以前只挂在 #page-reader 上，于是**只有正文变黑**：
        loading 遮罩、确认弹窗、以及系统状态栏那一条（html/body 的底色）
        全是纸白色 —— 黑底上顶一条白边，就是这么来的。
        现在进阅读页挂到 <html>，出阅读页立刻摘掉
        （书架和列表还没做主题适配，挂着会变成半吊子）。 */
  function syncTheme() {
    var inReader = state.page === 'reader';
    var t = state.settings.theme;
    if (inReader) {
      document.documentElement.setAttribute('data-theme', t);
      $('page-reader').setAttribute('data-theme', t);
    } else {
      document.documentElement.removeAttribute('data-theme');
      $('page-reader').removeAttribute('data-theme');
    }
    syncStatusBar();
  }

  /* 系统状态栏：**只做一件事 —— 图标深浅**。
     ⚠️ 上一版还调了 setOverlaysWebView({overlay:true}) + setBackgroundColor('#00000000')，
        想把状态栏做成透明的。结果在真机上（Android 15 的 edge-to-edge 本来就强制）
        这两句会让 WebView 跟着透出去，露出 Activity 的白底 ——
        表现就是「一片白、状态栏那条也是白的，书也打不开」。
        透明这件事交给原生主题（android/app/src/main/res/values/styles.xml）去做，
        JS 这边不再碰它。
     ⚠️ 每一步都要 typeof 判一下再调，还要接 .catch() ——
        插件没注册、或者版本对不上时，这里出任何岔子都不许影响读书。 */
  /* ---------------- 全屏沉浸（系统状态栏 + 导航栏一起藏） ----------------
     用的是自己写的原生插件 Immersive（见 android/.../ImmersivePlugin.java）：
     @capacitor/status-bar 只能管状态栏，底部那条系统导航栏它碰不到。 */
  function immersive() {
    var P = window.Capacitor && window.Capacitor.Plugins;
    return (P && P.Immersive) || null;
  }
  function callImmersive(method) {
    var I = immersive();
    if (!I || typeof I[method] !== 'function') return null;
    var r;
    try { r = I[method](); } catch (e) { return null; }
    if (r && typeof r.catch === 'function') r.catch(function () { /* 藏不了就藏不了 */ });
    return r;
  }

  /* 系统栏的真实高度：拿到就写进 --safeT / --safeB，
     顶栏底栏就能贴着物理边界排，不用再写死 46px / 26px 那种猜的数。
     ⚠️ 取不到（浏览器 / 老机）就退回原来那两个经验值，别把布局搞塌。 */
  function syncInsets() {
    var I = immersive();
    if (!I || typeof I.insets !== 'function') return;
    try {
      var r = I.insets();
      if (!r || typeof r.then !== 'function') return;
      r.then(function (v) {
        var top = (v && v.top) || 0, bot = (v && v.bottom) || 0;
        setSafe(top, bot);
      }).catch(function () { /* 量不到就用 CSS 里的默认值 */ });
    } catch (e) { /* 同上 */ }
  }
  function setSafe(top, bottom) {
    var st = document.documentElement.style;
    st.setProperty('--safeT', top + 'px');
    st.setProperty('--safeB', bottom + 'px');
  }

  /* 进出阅读页就自动切全屏 —— 她为这个提了好几轮"上面那条系统栏没藏掉"：
     之前只有手动点「沉浸模式」才藏，进阅读页默认是显示的，难怪一直没生效。 */
  function enterImmersive() {
    state.sysFull = true;
    callImmersive('hide');
    /* ⚠️ 只在插件真的存在时才把留白归零：没有插件（浏览器里跑）却归零，
       正文会顶到本该给系统栏让位的地方去。 */
    if (immersive()) setSafe(0, 0);
    $('btn-fullscreen').classList.toggle('on', true);
  }
  function leaveImmersive() {
    state.sysFull = false;
    callImmersive('show');
    clearSafe();
    syncInsets();                    // 系统栏回来了，把真实高度量回来
    $('btn-fullscreen').classList.toggle('on', false);
  }
  function clearSafe() {
    document.documentElement.style.removeProperty('--safeT');
    document.documentElement.style.removeProperty('--safeB');
  }

  /* 「沉浸模式」按钮：阅读页默认已经是全屏了，这个键用来**退出**全屏（把系统栏叫回来）。
     藏了以后从屏幕边缘滑一下也能临时唤出系统栏（BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE），
     滑完自己收回 —— 不会把人锁死在里头。 */
  function toggleFullscreen() {
    if (state.sysFull) leaveImmersive(); else enterImmersive();
  }

  function syncStatusBar() {
    try {
      var P = window.Capacitor && window.Capacitor.Plugins;
      var SB = P && P.StatusBar;
      if (!SB || typeof SB.setStyle !== 'function') return;
      var dark = state.page === 'reader' && state.settings.theme === 'dark';
      /* Style 的命名反直觉：LIGHT = 图标是浅色的（配深色背景），DARK = 图标深色（配浅背景） */
      var r = SB.setStyle({ style: dark ? 'LIGHT' : 'DARK' });
      if (r && typeof r.catch === 'function') r.catch(function () { /* 改不了就改不了，不影响读 */ });
    } catch (e) { /* 同上 */ }
  }

  /**
   * 亮度：值越大越亮（符合直觉）。
   * 屏幕真实亮度改不了，只能盖一层黑色遮罩压暗 —— 亮度 100 时遮罩全透明，
   * 亮度 20 时压到最暗。之前写反了：滑块往右拖反而越暗。
   *
   * 「亮度跟随系统」开着时**不压暗**，那层遮罩撤掉，亮度完全由系统的
   * 亮度设置决定（WebView 里既读不到也改不了系统真实亮度，
   * 所以这个开关的语义是"这层压暗归谁管"，不是"把系统亮度设成多少"）。
   *
   * 和主题一样，只在阅读页生效：它是"看书时调的"，回书架还压着一层黑就说不通。
   */
  function applyDim(light) {
    var follow = !!state.settings.lightFollowSys;
    var dim = follow ? 0 : (100 - light) / 100 * 0.85;
    $('dim').style.opacity = (state.page === 'reader' && !follow) ? dim.toFixed(3) : '0';
  }

  /* ---------------- 跳章的过渡（「翻页」那四个） ---------------- */
  var smoothRaf = 0, smoothTo = null, fxTimer = null;

  function stopSmooth() {
    if (smoothRaf) { cancelAnimationFrame(smoothRaf); smoothRaf = 0; }
    smoothTo = null;
  }
  /* 平滑：用 rAF 把 scrollTop 一点点推过去（ease-out）。
     老 WebView 没有 scrollTo({behavior})，自己推才靠得住。
     ⚠️ smoothTo 是个**活的目标**：跳章常常顺手触发"补一章"，
        那一插会把内容往上顶（preserve 补偿 scrollTop），
        目标位置也得跟着加同样的量 —— 不然动画推的是旧目标，看着就是没动。
        （第一版在 preserve 里直接把动画掐掉，结果就是"点了没反应"。） */
  function smoothScrollTo(y) {
    var el = readerEl();
    var start = el.scrollTop;
    stopSmooth();
    if (Math.abs(y - start) < 40) { el.scrollTop = y; markProgScroll(); return; }
    smoothTo = y;
    var dur = Math.min(430, 170 + Math.abs(y - start) * 0.22);
    var t0 = 0;
    (function step(ts) {
      if (smoothTo === null) return;              // 被人接管了
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.scrollTop = start + (smoothTo - start) * e;
      markProgScroll();                            // 动画每帧都在写 scrollTop，每帧都要登记（写完登记）
      if (p < 1) { smoothRaf = requestAnimationFrame(step); }
      else { smoothRaf = 0; smoothTo = null; }
    })(performance.now ? performance.now() : Date.now());
  }
  /* ---------------- 翻页方式（四种） ----------------
     ⚠️ 这条注释是用一次"真机彻底卡死"换来的，别改回去。

     上一版我给**整个章节块**（.chapter-block）挂 animation + perspective：
     那一块在真机上可能是几千个 <p>、十几万像素高。浏览器为了做 CSS 3D 动画
     必须把整个块提成合成层 —— 也就是往显存里塞一张几百 MB 的纹理。
     后果：① 跳章那一下先卡住；② 之后**再打开这本书**要重新排那一大块，
            直接卡死在「正在排版正文」（连看门狗的定时器都排不上队）。

     行业标准做法（page-flip / StPageFlip、各种 web 阅读器都一样）：
        · 先把"此刻屏幕上看得见的内容"**克隆**成一张跟一屏一样大的浮层；
        · 动画只发生在这张浮层上 —— 永远只有几十个节点，跟章节多长**无关**；
        · 「覆盖」= 绝对定位层叠 + transform + z-index
          「仿真」= perspective + rotateY + transform-origin: left center
          （参考 https://juejin.cn/post/7508747540306640896 里的层叠/透视做法）

     四种方式现在的语义（在连续卷轴里，"翻页"= 跳到另一章时怎么过渡）：
        上下 = 一步到位（无动画，最省）
        平滑 = 位置自己滚过去
        覆盖 = 新的一屏从下方滑上来盖住旧的一屏
        仿真 = 绕着左边像翻书一样立起来、落下 */
  var fxStage = null, fxEnd = 0;

  function fxClear() {
    if (fxStage && fxStage.parentNode) fxStage.parentNode.removeChild(fxStage);
    fxStage = null;
    clearTimeout(fxEnd);
    fxEnd = 0;
  }

  /* 把"此刻看得见的那些段"克隆成一张浮层。
     ⚠️ 只遍历跟视口有交集的章（通常 1~2 个），别整 wash 一遍所有 <p> ——
        刚打开一本大书时 DOM 里可能有一千多个段，一个个读 rect 也会拖一下。
     ⚠️ 内层要套一层 .chapter-content：段的字号/行高/缩进是 .chapter-content p
        这套规则给的，克隆出来的节点离开了原来的祖先就丢了这些样式。 */
  function fxSnapshot(extraCls) {
    var el = readerEl();
    var box = el.getBoundingClientRect();
    var top = box.top, bottom = box.top + el.clientHeight;
    var cs = getComputedStyle(el);

    var layer = document.createElement('div');
    layer.className = 'fx-layer' + (extraCls ? ' ' + extraCls : '');
    layer.style.top = top + 'px';
    layer.style.left = box.left + 'px';
    layer.style.width = box.width + 'px';
    layer.style.height = el.clientHeight + 'px';
    layer.style.paddingLeft = cs.paddingLeft;
    layer.style.paddingRight = cs.paddingRight;
    var inner = document.createElement('div');
    inner.className = 'chapter-content';
    layer.appendChild(inner);

    var any = false, first = true;
    for (var k = 0; k < state.blocks.length; k++) {
      var blk = state.blocks[k];
      var rb = blk.node.getBoundingClientRect();
      if (rb.bottom <= top + 1 || rb.top >= bottom - 1) continue;   // 整块都不在屏上
      var kids = blk.box.children;
      for (var i = 0; i < kids.length; i++) {
        var node = kids[i];
        if (node.tagName !== 'P') continue;
        var r = node.getBoundingClientRect();
        if (r.bottom <= top + 1 || r.top >= bottom - 1) continue;
        var c = node.cloneNode(true);
        /* 第一段可能被卷上去了一半：把它往下挪回来那半截，画面才接得上 */
        if (first) { c.style.marginTop = (r.top - top) + 'px'; first = false; }
        inner.appendChild(c);
        any = true;
      }
    }
    return any ? layer : null;
  }

  /* 跳到卷轴的第 y 个像素。翻页方式在这儿生效。 */
  function moveTo(y) {
    var el = readerEl();
    var mode = state.settings.pageTurn || 'vscroll';
    if (mode === 'smooth') { smoothScrollTo(y); return; }
    if (mode === 'vscroll' || Math.abs(y - el.scrollTop) < 40) { el.scrollTop = y; markProgScroll(); return; }

    /* 覆盖 / 仿真：先拍下"旧的一屏"，让位置瞬间到位，再让"新的一屏"滑上来 */
    fxClear();
    var old = fxSnapshot('fx-old');
    el.scrollTop = y;
    markProgScroll();
    var fresh = fxSnapshot('fx-new ' + (mode === 'sim' ? 'fx-sim' : 'fx-cover'));
    if (!old && !fresh) return;               // 屏上没东西（极端情况），别动画了

    var stage = document.createElement('div');
    stage.className = 'fx-stage';
    if (old) stage.appendChild(old);
    if (fresh) stage.appendChild(fresh);
    document.body.appendChild(stage);
    fxStage = stage;
    /* 兜底：animationend 可能因为被打断而不来（跳得太快），到点一律强拆 */
    fxEnd = setTimeout(fxClear, 560);
  }

  /* ---------------- 自动翻页（匀速往下滚 + 深色速度面板） ----------------
     "翻页速度 19" 指的是每秒滚多少像素：19 × 4 ≈ 76px/s，一屏大约 10 秒。
     范围 5–60（20–240 px/s）：低于 20 几乎看不出在动，高于 240 眼睛跟不上。 */
  var autoRaf = 0, autoLast = 0, autoPageAt = 0;

  function autoTick(ts) {
    autoRaf = 0;
    var s = state.settings;
    if (!s.autoPage || state.page !== 'reader') return;
    var el = readerEl();
    if (!autoLast) autoLast = ts;
    /* 手动滑过之后先停一会儿：不然人一边滑、自动翻页一边往下拽，两边打架 */
    if (Date.now() < state.autoPauseUntil) { autoLast = ts; autoRaf = rafAuto(); return; }

    /* 有面板开着（目录/设置/亮度…速度面板自己不算）时先别滚：
       人正在调东西，底下一直往下走会让人抓不住想点的按钮。 */
    if (document.querySelector('.drawer.open, .sheet.open:not(#sheet-speed)')) {
      autoLast = ts; autoRaf = rafAuto(); return;
    }

    /* 分页模式：不是匀速滚，是**每 N 秒翻一页** ——
       停下来的时候什么都不做，比每帧写 scrollTop 省电得多；
       而且这才是"自动翻页"这四个字字面上的意思。
       速度 19 → 每页约 3.2 秒（范围 5~60 → 12 秒 ~ 1 秒）。 */
    if (paged()) {
      var per = Math.max(1, 60 / (s.autoSpeed || 19)) * 1000;
      if (ts - (autoPageAt || 0) >= per) { autoPageAt = ts; nextPage(); }
      autoRaf = rafAuto();
      return;
    }

    var dt = ts - autoLast;
    autoLast = ts;
    if (dt > 0 && dt < 400) {
      var px = (s.autoSpeed * 4) * dt / 1000;
      var max = el.scrollHeight - el.clientHeight;
      if (el.scrollTop >= max - 1) {
        /* 到底了：还能接着下一章就接，接不上就是真读完了 —— 停下并说一声 */
        if (!nextChapter()) { stopAutoPage(true); return; }
      } else {
        el.scrollTop += px;
        markProgScroll();                  // 这一下是自动翻页推的，不是人滑的（写完再登记）
      }
    }
    autoRaf = rafAuto();
  }
  function rafAuto() { return requestAnimationFrame(autoTick); }

  /* 自动翻页的开关口：只有这两处负责状态与那枚胶囊，别在别处偷偷改 class */
  function openSpeed() {
    if (!state.settings.autoPage) return;
    syncSpeedPanel();
    $('sheet-speed').classList.add('open');
    setAutoHidden(false);
  }
  function closeSpeed() { $('sheet-speed').classList.remove('open'); }

  function startAutoPage() {
    if (!state.settings.autoPage) return;
    autoLast = 0;
    if (!autoRaf) autoRaf = rafAuto();
    /* ⚠️ 开了就夸 own 把速度面板弹出来是错的 —— 她明确要"点了之后两个面板都消失，
       要调的时候再点才出来"。面板改由右下角那枚小胶囊（或设置里那一行）叫回来。 */
    syncSpeedPanel();
    updateAutoPill(true);
  }
  /* finished = 真读完了（到底且没有下一章）才提示；中途退出不啰嗦 */
  function stopAutoPage(finished) {
    if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = 0; }
    closeSpeed();
    updateAutoPill(false);
    if (finished) toast('已经读完了');
  }

  /* 右下角那枚小胶囊：自动翻页正在跑的唯一提示 ——
     两个面板都收了之后，点它就是"我要调速"。栏收起来时它也跟着藏。 */
  function updateAutoPill(on) {
    var p = $('ap-pill');
    if (!p) return;
    p.classList.toggle('on', !!on);
    if (on) $('ap-speed').textContent = state.settings.autoSpeed;
  }

  function syncSpeedPanel() {
    $('sp-val').textContent = state.settings.autoSpeed;
    if ($('ap-speed')) $('ap-speed').textContent = state.settings.autoSpeed;
  }

  /* ---------------- 阅读设置面板 ---------------- */
  function openReadSet() { syncReadSet(); $('sheet-readset').classList.add('open'); }
  function closeReadSet() { $('sheet-readset').classList.remove('open'); }
  function openFont() { syncFont(); $('sheet-font').classList.add('open'); }

  function syncFont() {
    Array.prototype.forEach.call(document.querySelectorAll('#sheet-font .fp-row'), function (r) {
      r.classList.toggle('on', r.getAttribute('data-font') === state.settings.fontFamily);
    });
  }

  /* 把面板上四行刷成当前设置。别处改了设置（比如设置面板里的行距/主题），
     这边打开时也得是同一个值。 */
  function syncReadSet() {
    $('rs-fs-val').textContent = state.settings.fontSize;
    $('rs-font-name').textContent = FONT_NAME[state.settings.fontFamily] || FONT_NAME.sans;
    Array.prototype.forEach.call(document.querySelectorAll('#rs-theme .rs-dot'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-theme') === state.settings.theme);
    });
    /* 「翻页方式」那一行已经从设置面板里撤掉了，这里不用再刷它的选中态。 */
    /* ⚠️ 「自动翻页」是**匀速往下滚**（速度可调，见那个深色面板），
       跟「章节连续阅读」（读完一章自动把下一章接上，在老设置面板里）是两回事，
       别再共用 autoNext 了 —— 之前共用的时候开关按下去根本看不出干了什么。 */
    var on = !!state.settings.autoPage;
    $('rs-auto').textContent = '自动翻页 · ' + (on ? '开' : '关');
    $('rs-auto').classList.toggle('on', on);
    syncSpeedPanel();
  }

  /* ---------------- 亮度面板 ---------------- */
  function openLight() { syncLight(); $('sheet-light').classList.add('open'); }
  function closeLight() { $('sheet-light').classList.remove('open'); }

  /* 把面板上的两行刷成当前设置。设置面板里那个滑块改了亮度，
     或者「跟随系统」被别处改了，这边都得跟着动。 */
  function syncLight() {
    var v = state.settings.screenLight;
    var follow = !!state.settings.lightFollowSys;
    $('lp-fill').style.width = v + '%';
    $('lp-knob').style.left = v + '%';
    $('lp-track').setAttribute('aria-valuenow', String(v));
    $('lp-switch').classList.toggle('on', follow);
    $('lp-switch').setAttribute('aria-checked', follow ? 'true' : 'false');
    $('lp-slider').classList.toggle('off', follow);   // 跟随系统时滑条压暗并不给拖
  }

  /* 拖滑条调亮度。
     ⚠️ 拖动过程只改内存里的值 + 刷遮罩，**松手才落库** ——
        每动一像素写一次 IndexedDB，长滑一次就是几十次事务。
     ⚠️ 手一动就等于"我要自己管"，自动把「跟随系统」关掉。 */
  function bindLightSlider() {
    var track = $('lp-track'), knob = $('lp-knob');
    var dragging = false;

    function ratio(x) {
      var r = track.getBoundingClientRect();
      if (!r.width) return 1;
      return Math.max(0, Math.min(1, (x - r.left) / r.width));
    }
    function move(x) {
      var v = Math.round(20 + ratio(x) * 80);          // 20–100，跟设置里那个滑块一个范围
      state.settings.screenLight = v;
      state.settings.lightFollowSys = false;
      applyDim(v);
      syncLight();
    }
    function start(x) { dragging = true; knob.classList.add('drag'); move(x); }
    function end() {
      if (!dragging) return;
      dragging = false;
      knob.classList.remove('drag');
      saveSetting('screenLight', state.settings.screenLight);
    }

    if (window.PointerEvent) {
      track.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        start(e.clientX);
      }, { passive: false });
      document.addEventListener('pointermove', function (e) { if (dragging) move(e.clientX); }, { passive: true });
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    } else {
      track.addEventListener('touchstart', function (e) { start(e.touches[0].clientX); }, { passive: true });
      document.addEventListener('touchmove', function (e) { if (dragging) move(e.touches[0].clientX); }, { passive: true });
      document.addEventListener('touchend', end);
    }
  }

  function saveSetting(k, v) {
    state.settings[k] = v;
    applySettings();
    DB.setSetting(k, v);
  }

  /* ---------------- 书架 ---------------- */
  /* ---------------- 老引擎兜底 ----------------
     .shelf-canvas 靠 aspect-ratio:1/1 撑成正方形。这是 Chrome 88+ 的属性，
     老一点的 WebView 不认，高度会算成 0 —— 整个架子直接消失。
     这里量一下，发现塌了就按宽度手动补一个正方形高度（不超舞台可用高）。 */
  function ensureSquareCanvas() {
    var c = document.querySelector('.shelf-canvas');
    if (!c) return;
    var r = c.getBoundingClientRect();
    if (r.width < 10) return;
    var stage = document.querySelector('.shelf-stage');
    var maxH = stage ? stage.clientHeight - 34 : r.width;
    if (r.height < r.width * 0.6) {
      // 没撑起来：手动补一个正方形，但别超过舞台高度
      c.style.height = Math.round(Math.min(r.width, Math.max(160, maxH))) + 'px';
    } else if (c.style.height) {
      c.style.height = '';   // 引擎认 aspect-ratio 了，别留着手动值
    }
  }

  /* ---------------- 隐藏的诊断面板 ----------------
     长按左上角「砚读」两个字 ~800ms 开关。真机上有些毛病（浮层跑出屏幕、
     视口尺寸不对）在电脑上复现不出来，让对方截一张这个面板，
     比来回猜十轮都快。 */
  function rectOf(sel) {
    var e = document.querySelector(sel);
    if (!e) return '不存在';
    var b = e.getBoundingClientRect();
    return [b.left, b.top, b.width, b.height].map(function (v) { return Math.round(v); }).join(', ');
  }
  function supports(prop, val) {
    try { return CSS.supports(prop, val); } catch (e) { return '?'; }
  }
  function collectDebug() {
    var cs = getComputedStyle($('page-shelf'));
    return [
      'viewport  ' + window.innerWidth + ' x ' + window.innerHeight + '   dpr ' + window.devicePixelRatio,
      'screen    ' + screen.width + ' x ' + screen.height,
      'native    ' + (document.documentElement.classList.contains('native') ? 'yes' : 'no') +
        '   Capacitor ' + (window.Capacitor ? 'yes' : 'no'),
      'page rect ' + rectOf('#page-shelf'),
      'page top/left ' + cs.top + ' / ' + cs.left + '   inset=' + (cs.inset || '(空)'),
      'tabbar    ' + rectOf('#tabbar'),
      'canvas    ' + rectOf('.shelf-canvas'),
      'svg       ' + rectOf('.shelf-canvas svg'),
      'sheet     ' + rectOf('#sheet-pick') +
        ($('sheet-pick').classList.contains('open') ? '  [open]' : ''),
      '支持 inset=' + supports('inset', '0') +
        '  aspect-ratio=' + supports('aspect-ratio', '1/1') +
        '  min()=' + supports('width', 'min(1px,2px)'),
      'UA ' + navigator.userAgent
    ].join('\n');
  }
  function toggleDebug() {
    var el = $('dbg');
    if (el && el.style.display === 'block') { el.style.display = 'none'; return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'dbg';
      document.body.appendChild(el);
    }
    el.textContent = collectDebug();
    el.style.display = 'block';
  }

  /**
   * 书架 = 多宝格。渲染交给 js/shelf.js，那里是数据驱动的：
   * 骨架（H / V / SLOTS）、每格放什么、书的颜色，全是配置。
   * 这里只负责把书库的书和摆位读出来交给它。
   */
  /* 书架上次渲染出来的样子缓存起来：内容没变就别再把整个 SVG 拆了重建。
     一本书换个位置、读了几页这种变化都进签名，不会漏渲；
     转屏（舞台宽度变了）也进签名，宽度一变自然重渲。 */
  var shelfCache = { key: '', res: null };

  function shelfKeyOf(items, layout) {
    var stage = $('shelf-stage');
    var w = stage ? Math.round(stage.clientWidth) : 0;
    /* ⚠️ 键里要带上"继续阅读"便签的全部输入：最近读的那本是哪本、读到哪章、停了多久。
       少带任何一项，都会出现"书读过了、便签还写着上次那本"的鬼影
       （因为缓存命中时直接 return，连便签都不重画）。 */
    var cont = '';
    items.forEach(function (it) {
      if (it.read && (it.read.scrollY > 0 || it.read.index > 0)) {
        cont += it.id + '@' + it.read.index + '@' + it.read.at + ';';
      }
    });
    var ids = items.map(function (i) {
      return i.id + ':' + (i.no || 0) + ':' + (i.pct ? i.pct.toFixed(1) : '0');
    }).join(',');
    var lays = Object.keys(layout).sort().map(function (k) {
      return k + ':' + (layout[k] || []).join('+');
    }).join('|');
    return state.edit + '/' + w + '/' + items.length + '/' + ids + '/' + lays + '/C' + cont;
  }

  /* 架子下面的提示 / 副标题 / 花名册按钮：这些跟渲染结果有关，
     缓存命中时也要更新，不然会出现"架子变了、字没变" */
  function paintShelfMeta(res, items) {
    // 提示只在架子下面说一句，别再单独开一块空状态跟书架抢半屏高度
    var tip = '';
    if (!items.length) {
      tip = '书库还是空的 · 点下面的 ⊕ 导入 .txt';
    } else if (!res.placed) {
      tip = '书架还空着 · 点右上角「编辑」自己摆，或「一键摆满」';
    } else if (res.unplaced) {
      tip = '还有 ' + res.unplaced + ' 本在书库里没上架';
    }
    $('shelf-tip').textContent = tip;

    $('shelf-sub').textContent = res.placed
      ? '架上 ' + res.placed + ' 本 · 共 ' + items.length + ' 本'
      : '离线小说阅读器';

    // 有书脊写不下书名的（>4 字）才需要花名册
    var needRoster = items.some(function (it) { return Shelf.needsNumber(it.title); });
    $('btn-roster').style.display = needRoster ? '' : 'none';

    paintContinue(items);

    ensureSquareCanvas();
  }

  /* 继续阅读：挑最近一次真正读过的书，做成书架顶上那张便签。
     ⚠️ "读过"的判据是 scrollY>0 或 index>0 —— 只点开过一下就退出的不算，
        否则随便翻翻就会把这张便签抢过去，反而找不到你真正在看的那本。 */
  function paintContinue(items) {
    var el = $('btn-continue');
    if (state.edit) { el.style.display = 'none'; return; }   // 编辑架子时让位

    var best = null;
    items.forEach(function (it) {
      if (!it.read) return;
      if (!(it.read.scrollY > 0 || it.read.index > 0)) return;
      if (!best || it.read.at > best.read.at) best = it;
    });

    if (!best) { el.style.display = 'none'; return; }

    var r = best.read;
    var head = r.chapter ? '「' + r.chapter + '」' : '第 ' + (r.index + 1) + ' 章';
    var sub;
    if (best.pct >= 99.5) sub = '已读完 · 点开重读';
    else if (best.pct >= 1) sub = '读到 ' + head + ' · ' + best.pct.toFixed(0) + '%';
    else sub = '读到 ' + head;

    $('cc-name').textContent = best.title;
    $('cc-sub').textContent = sub;
    $('cc-spine').style.background = Shelf.colorOf(best.title);   // 跟架子上的书脊同色
    $('cc-bar').style.width = Math.max(2, Math.min(100, best.pct)) + '%';
    el.style.display = '';
    el.onclick = function () { openBook(best.id); };
  }

  function renderShelf() {
    return Promise.all([DB.listBooks(), DB.getSlots()]).then(function (r) {
      var books = r[0], layout = r[1];
      return withProgress(books)
        .then(function (items) {
          numberBooks(items);   // 书脊编号：>4 字的书名才有，从 ① 开始连续
        // 摆位里可能有已经被删掉的书，先清一遍再交给渲染器
        var alive = {};
        items.forEach(function (i) { alive[i.id] = 1; });
        Object.keys(layout).forEach(function (k) {
          layout[k] = (layout[k] || []).filter(function (id) { return alive[id]; });
        });

        var key = shelfKeyOf(items, layout);
        if (key === shelfCache.key && shelfCache.res) {
          paintShelfMeta(shelfCache.res, items);
          return shelfCache.res;
        }

        var res = Shelf.render($('shelf-stage'), {
          items: items,
          layout: layout,
          edit: state.edit,
          onItem: function (it) { openBook(it.id); },
          onSlot: function (info) { openPick(info); },
          onRemove: function (it, info) { askUnshelf(it, info); },
          // 非编辑态长按书脊也能直接拿下来
          onLongPress: function (it) { askUnshelf(it, null); }
        });

        shelfCache.key = key;
        shelfCache.res = res;
        paintShelfMeta(res, items);
      });
    });
  }

  function setEdit(on) {
    state.edit = !!on;
    $('btn-edit').textContent = state.edit ? '完成' : '编辑';
    $('btn-edit').classList.toggle('on', state.edit);
    $('edit-bar').classList.toggle('on', state.edit);
    if (!state.edit) closePick();
    return renderShelf();
  }

  /* 编辑态：点格子 → 弹出选书面板 */
  function openPick(info) {
    state.pickSlot = info;
    $('pick-title').textContent = '「' + info.name + '」';
    $('sheet-pick').classList.add('open');
    return syncPickSlot().then(refreshPick);
  }
  function closePick() { $('sheet-pick').classList.remove('open'); }

  /* 面板上的计数是渲染那一刻算的，改过摆位后要重新拉一次，
     不然「2/6」会停在旧值上 */
  function syncPickSlot() {
    var info = state.pickSlot;
    if (!info) return Promise.resolve();
    return DB.getSlots().then(function (layout) {
      var s = Shelf.slotInfo()[info.index];
      if (!s) return;
      var n = (layout[s.id] || []).length;
      state.pickSlot = {
        index: info.index, id: s.id, name: s.name,
        cap: s.cap, count: n, full: n >= s.cap
      };
    });
  }

  /* 面板里的一行书：act = 'add' 放上 / 'del' 拿下 */
  function pickRow(book, act, label) {
    var row = document.createElement('div');
    row.className = 'pick-row' + (act === 'del' ? ' here' : '');

    var sp = document.createElement('i');
    sp.className = 'pick-spine';
    sp.style.background = Shelf.colorOf(book.title);

    var t = titleEl('pick-name', book.title);

    var m = document.createElement('span');
    m.className = 'pick-meta';
    m.textContent = fmtSize(book.totalChars || 0);

    var btn = document.createElement('button');
    btn.className = 'pick-act ' + (act === 'del' ? 'del' : 'add');
    btn.textContent = label;

    row.appendChild(sp);
    row.appendChild(t);
    row.appendChild(m);
    row.appendChild(btn);

    function fire(e) {
      if (e) e.stopPropagation();
      if (act === 'del') pickRemove(book.id);
      else pickAdd(book.id);
    }
    btn.onclick = fire;
    row.onclick = fire;      // 点整行也一样，不用非得戳到按钮
    return row;
  }

  function refreshPick() {
    var info = state.pickSlot;
    if (!info) return Promise.resolve();
    $('pick-title').textContent = '「' + info.name + '」';
    $('pick-cap').textContent = info.count + '/' + info.cap;
    $('pick-cap').classList.toggle('full', info.full);

    var box = $('pick-list');
    box.innerHTML = '<p class="pick-none">…</p>';

    return Promise.all([DB.listBooks(), DB.getSlots()]).then(function (r) {
      var books = r[0], layout = r[1];
      var byId = {};
      books.forEach(function (b) { byId[b.id] = b; });

      var here = (layout[info.id] || []).map(function (id) { return byId[id]; })
        .filter(Boolean);
      var onShelf = {};
      Object.keys(layout).forEach(function (k) {
        (layout[k] || []).forEach(function (id) { onShelf[id] = 1; });
      });
      var pool = books.filter(function (b) { return !onShelf[b.id]; });

      box.innerHTML = '';
      var frag = document.createDocumentFragment();

      /* 第一段：这一格已经摆了的（能拿下） */
      var h1 = document.createElement('div');
      h1.className = 'pick-sec first';
      h1.innerHTML = '<span>这一格的书</span><span>' + here.length + '/' + info.cap + '</span>';
      frag.appendChild(h1);
      if (!here.length) {
        var e1 = document.createElement('p');
        e1.className = 'pick-none';
        e1.textContent = '还是空的，从下面挑一本放上来';
        frag.appendChild(e1);
      } else {
        here.forEach(function (b) { frag.appendChild(pickRow(b, 'del', '拿下')); });
      }

      /* 第二段：书库里还没上架的（能放上） */
      var h2 = document.createElement('div');
      h2.className = 'pick-sec';
      h2.innerHTML = '<span>书库里还没上架</span><span>' + pool.length + ' 本</span>';
      frag.appendChild(h2);
      if (!pool.length) {
        var e2 = document.createElement('p');
        e2.className = 'pick-none';
        e2.textContent = '书库里的书都上架了';
        frag.appendChild(e2);
      } else if (info.full) {
        var e3 = document.createElement('p');
        e3.className = 'pick-none';
        e3.textContent = '这一格放满了（' + info.count + '/' + info.cap + '）\n先拿下一本，或者换个格子';
        frag.appendChild(e3);
      } else {
        pool.forEach(function (b) { frag.appendChild(pickRow(b, 'add', '放上')); });
      }
      box.appendChild(frag);
      fitRolls(box);
    });
  }

  /* 往当前格子加一本：加之前再判一次容量，满了就拒绝 */
  function pickAdd(bookId) {
    var info = state.pickSlot;
    if (!info) return;
    return DB.getSlots().then(function (layout) {
      var arr = (layout[info.id] || []).slice();
      if (arr.indexOf(bookId) >= 0) { toast('这一格已经有了'); return refreshPick(); }
      if (arr.length >= info.cap) {
        toast('这一格最多放 ' + info.cap + ' 本');
        return refreshPick();
      }
      arr.push(bookId);
      var wasFull = arr.length >= info.cap;
      return DB.setSlot(info.id, arr)
        .then(syncPickSlot)
        .then(function () { return renderShelf(); })
        .then(function () {
          return refreshPick();
        })
        .then(function () { if (wasFull) toast('这一格满了（' + info.cap + ' 本）'); });
    });
  }

  /* 从当前格子拿下一本：书回书库，不删 */
  function pickRemove(bookId) {
    var info = state.pickSlot;
    if (!info) return;
    return DB.unshelf(bookId)
      .then(syncPickSlot)
      .then(function () { return renderShelf(); })
      .then(refreshPick);
  }

  /* 一键摆满：把书库里还没上架的书按格子顺序铺进去，每格不超容量。
     升级上来的老用户书架是空的，一本本摆太累，给条近路。 */
  function fillAll() {
    return Promise.all([DB.listBooks(), DB.getSlots()]).then(function (r) {
      var books = r[0], layout = r[1];
      var onShelf = {};
      Object.keys(layout).forEach(function (k) {
        (layout[k] || []).forEach(function (id) { onShelf[id] = 1; });
      });
      var pool = books.filter(function (b) { return !onShelf[b.id]; });
      if (!pool.length) { toast('书库里的书都在架上了'); return; }

      var infos = Shelf.slotInfo();
      var plan = {};
      infos.forEach(function (s) { plan[s.id] = (layout[s.id] || []).slice(0, s.cap); });

      var i = 0;
      // 先每个格子放一本，铺得均匀点；再一轮轮补满
      infos.forEach(function (s) {
        if (i < pool.length && plan[s.id].length < s.cap) plan[s.id].push(pool[i++].id);
      });
      var moved = true;
      while (i < pool.length && moved) {
        moved = false;
        infos.forEach(function (s) {
          if (i < pool.length && plan[s.id].length < s.cap) {
            plan[s.id].push(pool[i++].id);
            moved = true;
          }
        });
      }
      var placed = i;

      return Promise.all(infos.map(function (s) { return DB.setSlot(s.id, plan[s.id]); }))
        .then(function () { return renderShelf(); })
        .then(function () {
          var left = pool.length - placed;
          toast(left ? ('摆下 ' + placed + ' 本，还有 ' + left + ' 本放不下')
                     : ('全部上架，共 ' + placed + ' 本'));
        });
    });
  }

  function clearAll() {
    confirmSheet({
      title: '清空书架？',
      desc: '只是把书都放回书库，一本书都不会删。',
      okText: '清空',
      danger: true,
      onOk: function () {
        DB.clearSlots().then(function () { return renderShelf(); })
          .then(function () { toast('书架已清空，书都还在书库里'); });
      }
    });
  }

  /* 从书架拿下一本：只解除摆位，书还在书库 */
  function askUnshelf(it, info) {
    var name = it.title || '这本书';
    confirmSheet({
      title: '从书架拿下来？',
      desc: '《' + name + '》会回到书库，不会被删除。',
      okText: '拿下',
      danger: false,
      onOk: function () {
        DB.unshelf(it.id)
          .then(syncPickSlot)
          .then(function () { return renderShelf(); })
          .then(function () {
            if ($('sheet-pick').classList.contains('open')) return refreshPick();
          })
          .then(function () { toast('已拿下《' + name + '》'); });
      }
    });
  }

  /* ---------------- 花名册 ----------------
     书脊上超过 4 个字的书名不写，只标序号（①）—— 15px 宽的书脊竖排长书名没法看。
     序号和书名的对照就记在这本册子里。
     **只记有标号的那些**：书名短、书脊上写得下全名的书，册子里再列一遍是废话。 */
  function openRoster() {
    $('sheet-roster').classList.add('open');
    return renderRoster();
  }
  function closeRoster() { $('sheet-roster').classList.remove('open'); }

  function renderRoster() {
    var box = $('roster-list');
    box.innerHTML = '<p class="pick-none">…</p>';
      return DB.listBooks().then(function (books) {
        numberBooks(books);
        return withProgress(books);
      }).then(function (list) {
      // 只要编号书的，按序号排
      var rows = list.filter(function (b) {
        return b.no && Shelf.needsNumber(b.title);
      }).sort(function (a, b) { return a.no - b.no; });

      $('roster-count').textContent = rows.length + ' 本';
      box.innerHTML = '';
      if (!rows.length) {
        box.innerHTML = '<p class="pick-none">书脊上都写得下全名，暂时不用对号</p>';
        return;
      }
      var frag = document.createDocumentFragment();
      rows.forEach(function (b) {
        var row = document.createElement('div');
        row.className = 'pick-row';

        var no = document.createElement('span');
        no.className = 'roster-no';
        no.textContent = Shelf.circled(b.no);

        var t = titleEl('pick-name', Shelf.cleanTitle(b.title));

        var pct = document.createElement('span');
        pct.className = 'pick-meta';
        pct.textContent = b.pct > 0 ? b.pct.toFixed(0) + '%' : '未读';

        row.appendChild(no);
        row.appendChild(t);
        row.appendChild(pct);
        row.onclick = function () { closeRoster(); openBook(b.id); };
        frag.appendChild(row);
      });
      box.appendChild(frag);
      fitRolls(box);
    });
  }

  /* ---------------- 书库列表 ---------------- */
  function renderList() {
    var q = state.query.trim().toLowerCase();
    return Promise.all([DB.listBooks(), DB.getSlots()]).then(function (r) {
      var books = r[0], layout = r[1];

      // 每本书在不在架上、在哪一格
      var names = {};
      Shelf.slotInfo().forEach(function (s) { names[s.id] = s.name; });
      var where = {};
      Object.keys(layout).forEach(function (k) {
        (layout[k] || []).forEach(function (id) { where[id] = names[k] || '书架'; });
      });

      var rows = books.filter(function (b) {
        return !q || String(b.title).toLowerCase().indexOf(q) >= 0;
      });

      numberBooks(books);   // 书脊编号（列表页也标出来，跟架子上对得上）
      return withProgress(rows)
        .then(function (data) {
        var box = $('list-body');
        box.innerHTML = '';
        /* 一行一行往页面上 append，每插一次浏览器都可能排一次版。
           先攒在 DocumentFragment 里，最后一次挂上去。 */
        var frag = document.createDocumentFragment();

        var empty = $('list-empty');
        if (!data.length) {
          empty.style.display = 'flex';
          /* ⚠️ 搜索词是用户敲进去的原话，一律走 textContent，别拼进 innerHTML ——
             以前是字符串拼 HTML，输 «<b id=zzz>x</b>» 这种关键词，
             标签当场被解析成真元素（实测：#zzz 真的出现在页面上了）。 */
          empty.textContent = '';
          if (books.length) {
            var none = document.createElement('p');
            none.textContent = '没有匹配「' + state.query + '」的书';
            empty.appendChild(none);
          } else {
            var ico = document.createElement('div');
            ico.className = 'empty-icon';
            var p1 = document.createElement('p');
            p1.textContent = '书库还是空的';
            var p2 = document.createElement('p');
            p2.className = 'sub';
            p2.textContent = '点右上角「+ 导入」，选择手机里的 .txt';
            empty.appendChild(ico);
            empty.appendChild(p1);
            empty.appendChild(p2);
          }
          return;
        }
        empty.style.display = 'none';

        data.forEach(function (b) {
          var row = document.createElement('div');
          row.className = 'bk-row';

          var sp = document.createElement('i');
          sp.className = 'bk-spine';
          sp.style.background = Shelf.colorOf(b.title);

          var main = document.createElement('div');
          main.className = 'bk-main';

          var nm = titleEl('bk-name', (b.no ? Shelf.circled(b.no) + ' ' : '') + b.title);

          var sub = document.createElement('div');
          sub.className = 'bk-sub';
          sub.textContent = fmtSize(b.totalChars || 0) + ' · ' + b.chapters + ' 章' +
            (b.pct > 0 ? ' · 读到 ' + b.pct.toFixed(1) + '%' : '');

          var bar = document.createElement('div');
          bar.className = 'bar';
          var inn = document.createElement('i');
          inn.className = 'bar-in';
          inn.style.width = b.pct.toFixed(1) + '%';
          bar.appendChild(inn);

          main.appendChild(nm);
          main.appendChild(sub);
          main.appendChild(bar);

          var right = document.createElement('div');
          right.className = 'bk-right';

          var flag = document.createElement('span');
          flag.className = 'bk-flag' + (where[b.id] ? ' on' : '');
          flag.textContent = where[b.id] ? ('架上 · ' + where[b.id]) : '未上架';

          var del = document.createElement('button');
          del.className = 'bk-del';
          del.textContent = '删除';
          del.onclick = function (e) {
            e.stopPropagation();
            askDelete(b);
          };

          right.appendChild(flag);
          right.appendChild(del);

          row.appendChild(sp);
          row.appendChild(main);
          row.appendChild(right);
          row.onclick = function () { openBook(b.id); };
          frag.appendChild(row);
        });
        box.appendChild(frag);
        fitRolls(box);
      });
    });
  }

  /* 真删一本书：正文、进度、摆位一起清掉 */
  function askDelete(b) {
    confirmSheet({
      title: '删除《' + b.title + '》？',
      desc: '书和它的阅读进度会一起删掉，不可恢复。\n（只是从书架拿下来的话，请在书架页编辑）',
      okText: '删除',
      danger: true,
      onOk: function () {
        DB.delBook(b.id).then(function () {
          toast('已删除《' + b.title + '》');
          return renderList();
        }).then(function () { return renderShelf(); });
      }
    });
  }

  /* ---------------- 导入 ---------------- */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }

  /* 导入是"一本一本"往前推的。
     ⚠️ 两条必须成立的规矩，都是实测踩出来的（tools/selftest-cases.js 的 C2 / C3）：
       ① 任何一本出问题只算这一本失败，**必须接着导下一本** ——
          上一版的 catch 里没有再往下排，多选五本、第三本坏了就停在第三本：
          后面两本悄悄没进库，连"导入完成"那句都不出现。
       ② 一章都分不出来的（空文件 / 整篇只有空白 / 传错了的二进制）**不写库** ——
          上一版照样 addBook，库里就多出一本 toc 为 0 的"幽灵书"：
          列表里看着正常，点开就是一张空白页，页眉写着书名、正文一个段都没有。 */
  function importFiles(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) {
      return /\.txt$/i.test(f.name) || f.type === 'text/plain';
    });
    if (!list.length) { toast('请选择 .txt 文件'); return; }

    var done = 0, skipped = [], failed = [];

    (function next(i) {
      if (i >= list.length) {
        hideLoading();
        // 导入完落在列表页，刚导入的书一眼就能看到
        showPage('list');
        renderList();
        renderShelf();
        var msg;
        if (done) {
          msg = '导入完成，共 ' + done + ' 本';
          if (skipped.length) msg += '；' + skipped.length + ' 本是空的，跳过了';
          if (failed.length) msg += '；' + failed.length + ' 本没读出来';
        } else if (skipped.length) {
          msg = '这几本里没有正文：' + skipped[0];
        } else {
          msg = '一本都没读出来，换个 .txt 再试';
        }
        toast(msg);
        return;
      }
      var f = list[i];
      showLoading('正在解析 ' + f.name);
      // 让出一帧，保证 loading 先画出来
      setTimeout(function () {
        readFile(f).then(function (buf) {
          var r = Parser.decodeBuffer(buf);
          var chapters = Parser.splitChapters(r.text);
          if (!chapters.length) {
            skipped.push(f.name);
            return 'skip';
          }
          var toc = chapters.map(function (c) {
            return { t: c.title, len: Parser.countChars(c.text) };
          });
          var total = toc.reduce(function (a, c) { return a + c.len; }, 0);
          var id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          return DB.addBook({
            id: id,
            title: f.name.replace(/\.(txt|text)$/i, ''),
            totalChars: total,
            encoding: r.encoding,
            addedAt: Date.now(),
            toc: toc
          }).then(function () { return DB.putChapters(id, chapters); })
            .then(function () { return 'ok'; });
        }).then(function (res) {
          if (res === 'ok') done++;
          else if (res === 'skip') toast('这本里没有正文，跳过了：' + f.name);
          next(i + 1);
        }).catch(function () {
          failed.push(f.name);
          toast('这一本没读出来：' + f.name);
          next(i + 1);            // ← 关键：接着走下一本，别整批停在这儿
        });
      }, 30);
    })(0);
  }

  function pickFile() { $('file-input').click(); }

  /* ---------------- 阅读 ---------------- */
  function openBook(id) {
    state.from = state.page === 'reader' ? state.from : state.page;
    /* ⚠️ 看门狗给到 11 秒，比下面那道 9 秒的 Promise.race **慢**：
       抢在前面的话会出现"提示说已经中止 → 一秒后它自己又好了"这种自打脸。
       （上一版是 8000 / 9000，正好反了。） */
    showLoading('打开中', 11000);
    DB.getBook(id).then(function (b) {
      if (!b) { hideLoading(); toast('这本书不存在'); return null; }
      /* 老库里可能已经存着一本"0 章"的书（新版导入不会再产生，但装了老包的人手机里可能有）。
         让它进阅读页就是一张空白页：页眉写着书名、正文一个段都没有，进度也没处存 ——
         不如当场说清楚，让人去列表里删了重导。 */
      if (!b.toc || !b.toc.length) {
        hideLoading();
        toast('《' + b.title + '》里没有正文，去列表里删掉再导一次');
        return null;
      }
      state.book = b;
      resetPctCache();          // 换了书，进度缓存必须重算（不然会拿上一本的基数）
      return DB.getProgress(id).then(function (p) {
        state.index = p && typeof p.index === 'number' ? p.index : 0;
        state.mark = p && p.mark ? p.mark : null;
        $('reader-title').textContent = b.title;
        $('btn-bookmark').classList.toggle('on', !!state.mark);
        showPage('reader');
        /* 遮罩上的字一步一步换：真机上要是卡住，一眼就能看出卡在哪一步
           （"打开中 / 读目录 / 排版正文"），比干等一个"打开中"有用得多。 */
        $('loading-text').textContent = '正在读目录…';
        /* ⚠️ 目录是"旁边的东西"，它出岔子不许连累打开书 ——
           包起来：目录画不出来最多是点开目录空的，正文必须照常出来。 */
        try { renderToc(); } catch (e) { /* 目录坏了不影响读 */ }
        $('loading-text').textContent = '正在排版正文…';
        /* ⚠️ 给整条留个兜底 —— 排不完也得让 openBook 走下去：
           万一 renderStream 那一串因为某种原因没兑现（异步查库没回调…），
           至少遮罩会收掉、人能看见已经排出来的部分。
           这一层是最后的保险，正常情况下 renderStream 自己几十毫秒就完成了。 */
        return Promise.race([
          renderStream(p ? p.scrollY : 0),
          new Promise(function (r) { setTimeout(r, 9000); })
        ]);
      });
    }).then(function () {
      hideLoading();
      /* 自动翻页是记在设置里的：上回开着，这次打开接着滚。
         没真进到阅读页（书不存在 / 没有正文）就别启动，不然小胶囊会挂在书架页上。 */
      if (state.page === 'reader' && state.settings.autoPage) startAutoPage();
    }).catch(function () {
      hideLoading();
      toast('打开失败');
    });
  }

  function backFromReader() {
    saveProgress();
    showPage(state.from || 'shelf');
    if (state.page === 'list') return renderList();
    return renderShelf();
  }

  /* ================== 阅读 · 一条连续的长书页 ==================

     以前是「一章一个滚动容器」：读到章尾 → 清屏 → 拉 loading → 把下一章重画一遍。
     现在是**整本书读成一条很长的书页**：DOM 里同时挂着当前章前后若干章，
     往上划就把上一章接到上面去，往下读就在下面续上，离得远的卸掉。

     于是"翻章"这件事本身消失了 —— 上一章最后一段和下一章的标题之间没有断层，
     而且往上还能一路滑回上一章（它的内容在接上的那一刻就已经在那儿了）。

     三条必须同时成立，缺一条画面就会出问题：
       · 往流式内容里插删东西，视线不许跳        → preserve()
       · DOM 里的东西必须有上限                  → MAX_BLOCKS + trimBlocks()
       · 参考线正下方永远有一段现成的正文         → fillDown() + maybeConnect()
  */

  function readerEl() { return $('reader-body'); }
  function contentEl() { return $('chapter-content'); }

  /* 一帧只读一次的几何快照。
     getBoundingClientRect / scrollHeight 会强制浏览器排版 ——
     每帧集中读一次没问题，散在各函数里各读一遍就贵了。
     items[i].top 用的**内容坐标系**（0 = 卷轴最顶端），跟 scrollTop 是同一套，
     这样后面判断"这一块在参考线上方还是下方"就不用换算两次。 */
  function snapshot() {
    var el = readerEl();
    var top = el.scrollTop, ch = el.clientHeight, sh = el.scrollHeight;
    var elTop = el.getBoundingClientRect().top;
    var items = [];
    for (var i = 0; i < state.blocks.length; i++) {
      var r = state.blocks[i].node.getBoundingClientRect();
      items.push({ blk: state.blocks[i], top: r.top - elTop + top, h: r.height });
    }
    return { el: el, top: top, ch: ch, sh: sh, items: items, ry: top + ch * READ_FRAC, anchor: null };
  }

  /* DOM 动过之后把快照重新量一遍（旧的高度已经不算数了）。 */
  function resync(snap) {
    var el = snap.el;
    snap.top = el.scrollTop; snap.ch = el.clientHeight; snap.sh = el.scrollHeight;
    var elTop = el.getBoundingClientRect().top;
    for (var i = 0; i < snap.items.length; i++) {
      var r = snap.items[i].blk.node.getBoundingClientRect();
      snap.items[i].top = r.top - elTop + snap.top;
      snap.items[i].h = r.height;
    }
    snap.ry = snap.top + snap.ch * READ_FRAC;
    snap.anchor = null;
  }

  /* 锚点 = 参考线落在哪一章里。两个偏移要分清，混用会差出一百多像素：
       off  = 参考线离本章顶端多远 —— 算"这一章读了百分之几"用它
       voff = 视口顶边离本章顶端多远 —— **存进度、存书签、恢复位置全用它**
     为什么存的是 voff 而不是 off：卷轴里挂哪几章是变的，恢复时目标章会从
     "中间某一块"变成"第一块"，章顶端的绝对位置跟着变；而"视口顶边在章内第几个像素"
     是个纯粹的相对量，跟留白、跟前面挂了几章、跟上下栏收没收起都没关系。
     用 off 存的话，恢复出来会往下多走 (一屏的 1/4 - 顶部留白) ≈ 149px。 */
  function anchorOf(snap) {
    if (snap.anchor) return snap.anchor;
    if (!snap.items.length) return null;
    var a = null;
    for (var i = 0; i < snap.items.length; i++) {
      var t = snap.items[i];
      a = { blk: t.blk, i: i, top: t.top, off: snap.ry - t.top, voff: snap.top - t.top };
      if (t.top + t.h > snap.ry) break;       // 第一块尾巴还在参考线下面的，就是它
    }
    snap.anchor = a;
    return a;
  }

  /* ⭐ 往卷轴里插 / 删东西时保持视线不跳。
     记下锚点块的位置变化 d：
        · 插在它上面（接上一章）    → 它被顶下去 d px → scrollTop 也 +d，画面纹丝不动
        · 删掉它上面的东西（卸载）  → d 是负的        → scrollTop 减回来
        · 往它自己内部补段落        → 它的顶边没动    → d = 0，什么都不做（最常见的情况）
     不包这一层的话，"往上滑加载上一章"会当着人的面把整段字弹走好几屏。 */
  function preserve(fn) {
    var el = readerEl();
    var s0 = snapshot();
    var a = anchorOf(s0);
    var node = a ? a.blk.node : null;
    var b0 = a ? a.top : 0;
    fn();
    if (!node) return;
    if (!node.parentNode) return;             // 这一块已经被卸载了，没什么好锚的
    var r = node.getBoundingClientRect();
    var b1 = r.top - el.getBoundingClientRect().top + el.scrollTop;
    var d = b1 - b0;
    if (!d) return;
    el.scrollTop += d;
    markProgScroll();
    /* 平滑滚动正在跑的话，目标也得跟着挪这么多 ——
       不然补偿完的位置跟动画要去的旧目标对不上，看着就是"点了没反应"。 */
    if (smoothTo !== null) smoothTo += d;
  }

  /* 造一块「章节」：自带章节标题 + 装段落的盒子。
     ⚠️ 标题必须跟着这一块走。以前它是挂在滚动容器上的一个孤零零的 h2，
        一条卷轴里就只能有一个 —— 走到第二章头上就没名字了。 */
  function makeBlock(idx, text) {
    var b = state.book;
    var node = document.createElement('div');
    node.className = 'chapter-block';
    node.setAttribute('data-idx', idx);

    var h = document.createElement('h2');
    h.className = 'chapter-title';
    h.textContent = b.toc[idx].t;
    node.appendChild(h);

    var box = document.createElement('div');
    box.className = 'chapter-paras';
    node.appendChild(box);

    var blk = { idx: idx, node: node, box: box, paras: [], shown: 0, done: false, end: null };
    var lines = String(text || '').split(/\n/);
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim();
      if (s) blk.paras.push(s);
    }
    appendWithin(blk);
    return blk;
  }

  /* 往某一块里追加 n 段。返回有没有真的加上。
     ⚠️ n 必须小：这一函数是**同步**的，一次性建几百个 <p> 再让浏览器排版，
        在真机老 WebView 上能把主线程独占好几秒 —— 那期间 setTimeout 都排不上队，
        连"卡住了"的兜底提示都出不来。所以续排一律用小 n（见 SLICE_N）。 */
  function appendN(blk, n) {
    var end = Math.min(blk.paras.length, blk.shown + n);
    if (end <= blk.shown) return false;
    var frag = document.createDocumentFragment();
    for (var i = blk.shown; i < end; i++) {
      var p = document.createElement('p');
      p.textContent = blk.paras[i];
      frag.appendChild(p);
    }
    blk.box.appendChild(frag);
    blk.shown = end;
    if (end >= blk.paras.length) blk.done = true;
    return true;
  }
  function appendWithin(blk) { return appendN(blk, CHUNK); }

  /* 这一章全部画完大概多高。还没画完就按段数比例外推：
     段有长有短，估不准，但用来判断"读到 3/4 了吗"足够。
     宁可估短一点（提前接上），也别估长了漏掉 —— 漏了就露出断口。 */
  function estFullHeight(blk) {
    var h = blk.node.offsetHeight;
    if (blk.done || !blk.shown) return h;
    return h * (blk.paras.length / blk.shown);
  }

  /* 异步取一章的正文，接到卷轴的下端（append）或上端（prepend）。
     ⚠️ prepend 一定要走 preserve()：插上去的高度会把下面所有东西顶下去。
     ⚠️ 请求回来时要确认卷轴还是原来那条（seq 没变、书没换），
        否则从目录里跳远章时，在飞的那个旧请求会把两章错序地拼在一起。 */
  function loadChapter(idx, where) {
    var b = state.book;
    if (!b || idx < 0 || idx > b.toc.length - 1) return Promise.resolve(null);
    if (state.loading[idx]) return Promise.resolve(null);
    for (var k = 0; k < state.blocks.length; k++) {
      if (state.blocks[k].idx === idx) return Promise.resolve(state.blocks[k]);
    }
    state.loading[idx] = 1;
    var seq = state.streamSeq;
    return DB.getChapter(b.id, idx).then(function (text) {
      delete state.loading[idx];
      if (seq !== state.streamSeq || !state.book || state.book.id !== b.id) return null;
      var blk = makeBlock(idx, text);
      preserve(function () {
        if (where === 'prepend') {
          contentEl().insertBefore(blk.node, contentEl().firstChild);
          state.blocks.unshift(blk);
        } else {
          contentEl().appendChild(blk.node);
          state.blocks.push(blk);
          /* 上一章那张「本章完 · 下一章」是它挂出来时下一章还不在卷轴里才挂的，
             现在下一章就在底下，这张卡就成了假话（底下明明有字）—— 收掉。
             「全书完」那张不算，它说的还是真话。 */
          dropStaleEnd(findBlock(idx - 1));
        }
      });
      finishBlock(blk);
      applyPendingTop();          // 卷轴变长了，之前没落到位的目标位置再试一次
      return blk;
    }).catch(function () {
      delete state.loading[idx];
      return null;
    });
  }

  /* 参考线正下方必须一直有现成的正文，不然滑着滑着会出现一段"什么都没有"，
     再往下突然跳到下一章。
     ⚠️ 补的可能是**已经滑过去那一章**没画完的部分（往上接的章节只画了头几段）：
        那段插进去的位置在人的上方偏下一点，会把底下的东西整体顶下去 —— 所以整段包 preserve()。 */
  function fillDown(snap) {
    var guard = 0, changed = false;
    var t0 = Date.now();
    var reserve = Math.max(1000, snap.ch * 1.2);     // 参考线下面至少留这么多 px
    /* ⚠️ 除了次数上限还加了**时间上限**：一帧里补 8 批（老值是 8×160 段）
       在真机上能把这一帧拖到几百毫秒 —— 滑起来就是一顿一顿的。
       超过 10ms 就这一帧先到这儿，剩下的下一帧再说。 */
    while (guard++ < 8 && Date.now() - t0 < 10) {
      /* ⚠️ 还有**总量上限**：视口停在底部时（比如打开书还没落到位），
         参考线一直贴着最后一块，每补一段那一块就往下挪一点、preserve 又把
         视口带下去 —— 于是"补段 → 视口下移 → 又不够长 → 再补"停不下来，
         一本没切开的大书会被整章几万段全塞进 DOM（实测排到 20128 段才停）。
         到顶就罢手：剩下的等人往下滑时再补，反正 trimBlocks 会卸掉远处的。 */
      if (domParas() >= FILL_MAX) return changed;
      var t = null;
      for (var i = 0; i < snap.items.length; i++) {
        if (snap.items[i].blk.shown < snap.items[i].blk.paras.length) { t = snap.items[i]; break; }
      }
      if (!t) return changed;                        // 全画完了，长度只能靠接下一章来补
      if (t.top + t.h >= snap.ry + snap.ch + reserve) return changed;   // 下方够长，不用补
      var blk = t.blk;
      preserve(function () { appendWithin(blk); });
      finishBlock(blk);
      resync(snap);
      changed = true;
    }
    return changed;
  }

  /* 前后该接哪一章了。
       往下 —— 本章「看掉」PRELOAD_AT（默认 3/4）就把下一章接上。这是连贯的关键：
                不是滑到底再去拉，而是提前一截就补好，人抵达时它已经在那儿。
       往上 —— 离顶端不足 UP_AT 屏就把上一章接到上面去。
                这样往上划能滑回上一章，而且内容是现成的，不会白屏等一下。
     ⭐ ⚠️ 两个分支都必须先确认"这一章还没挂着"（findBlock 那道判重）。
        少了它就会**死循环**：loadChapter 对已经挂着的章返回的是
        一个已兑现的 Promise（微任务），而它的回调 afterConnect 又会
        调 maintain → 再进 maybeConnect → 条件还成立 → 再来一次 ……
        微任务队列永远排不空，事件循环一步都走不出去：
        计时器、rAF、绘制全部饿死，表现就是**整个阅读页僵住**，
        实测每秒 20 万次 getBoundingClientRect（全是 snapshot 在读几何）。
        触发条件：整本书很短（一章一屏都装得下好几章，短诗/短章合集那种），
        所有块都在参考线以上 → anchorOf 落到最后一块 → 往下那一支每次都成立。
        （ensureNeighbors 一直有这道判重，只有这里漏了。） */
  function maybeConnect(snap) {
    var b = state.book;
    if (!b || !snap.items.length) return false;
    var first = state.blocks[0], last = state.blocks[state.blocks.length - 1];
    var a = anchorOf(snap);
    if (!a) return false;
    var did = false;

    /* 自动连读**关着**的时候不往下接：那时候章末会挂一个「下一章」按钮，
       点一下才接上来（见 finishBlock）。往上接不受这个开关影响 ——
       往上能滑回上一章是阅读器的本分，不该是个开关。 */
    if (state.settings.autoNext && last.idx < b.toc.length - 1 && a.blk === last &&
        !findBlock(last.idx + 1)) {
      var full = estFullHeight(last);
      var seen = snap.ry - a.top;
      /* 短章可能量不出来（一屏放得下），那就看离尾巴还有多远 */
      var near = last.done && (snap.sh - snap.ry < snap.ch * 1.2);
      if (full > 0 && (seen / full >= PRELOAD_AT || near)) {
        loadChapter(last.idx + 1, 'append').then(afterAppend);
        did = true;
      }
    }

    /* 快到顶了且在最前面那一章头上 → 把上一章接上来。
       给两屏富余是因为这一下要等一次异步查库，贴着顶端触发会在快速上滑时顿一下。 */
    if (first.idx > 0 && snap.top < snap.ch * UP_AT && !findBlock(first.idx - 1)) {
      loadChapter(first.idx - 1, 'prepend').then(afterAppend);
      did = true;
    }
    /* 平滑滚动正在跑的时候**先别卸载**：卸载会改卷轴的长度，
       锚点补偿把 scrollTop 拨回来，动画的插值就跟不上，末尾能看见一下抖动
       （实测：9106 → 4547 → 4700）。卸载不急这一时半刻，落定了再干。 */
    if (smoothTo === null && trimBlocks(snap)) did = true;
    return did;
  }

  /* 章节接进来之后：几何变了，趁着一帧之内补齐窗口、更新进度。
     ⚠️ 一帧只许做一次（afterQueued 合并）。
        上一版这里是"每次 loadChapter 的承诺回来就同步再跑一遍 maintain"，
        而 loadChapter 对**已经在飞的同一章**返回的是 `Promise.resolve(null)` ——
        一个已兑现的微任务。于是：maintain → maybeConnect 条件没变（几何没变）
        → 又调 loadChapter → 又拿到已兑现的 null → 又 afterConnect → ……
        微任务队列永远排不空，IndexedDB 那个真回调挤不进来，
        计时器 / rAF / 绘制全饿死 = **整个阅读页僵住**。
        实测每秒 20 万次 getBoundingClientRect，全部来自 snapshot()，
        而且一次 DOM 增删都没有 —— 就是这个空转的形状。
        短诗合集、微章节那种"一屏装得下好几章"的书最容易撞上。 */
  var afterQueued = 0;
  function afterConnect() {
    if (!state.book || state.page !== 'reader') return;
    if (afterQueued) return;                       // 这一帧已经排过了
    afterQueued = requestAnimationFrame(function () {
      afterQueued = 0;
      if (!state.book || state.page !== 'reader') return;
      var snap = snapshot();
      if (maintain(snap)) updatePct(snapshot());
    });
  }
  /* 只有**真的接上了一章**才值得再维护一轮；去重返回的 null 不续链（见上面那段）。 */
  function afterAppend(blk) { if (blk) afterConnect(); }

  /* DOM 里的东西要有上限：离视线太远的章节卸掉（顺带把它那一百多个 <p> 一起带走）。
     窗口 = 锚点前 1 章（这就是"往上能滑回上一章"的本钱）+ 锚点后 3 章。
     超过 MAX_BLOCKS 就从离锚点更远的那一头砍。注意「前面至少留 1 章」是硬规矩，那条是"往上能滑回去"的本钱。 */
  function trimBlocks(snap) {
    var a = anchorOf(snap);
    if (!a) return false;
    var keep = [], i;
    for (i = 0; i < state.blocks.length; i++) {
      var b = state.blocks[i];
      if (b.idx >= a.blk.idx - 1 && b.idx <= a.blk.idx + 3) keep.push(b);
    }
    if (keep.length > MAX_BLOCKS) {
      var ai = -1;
      for (i = 0; i < keep.length; i++) if (keep[i] === a.blk) ai = i;
      var surplus = keep.length - MAX_BLOCKS;
      var headRoom = ai > 0 ? ai - 1 : 0;      // 锚点前面（保留 1 章）还能砍几个
      var cut = Math.min(surplus, headRoom);
      if (cut) keep = keep.slice(cut);
      surplus = keep.length - MAX_BLOCKS;
      if (surplus > 0) keep = keep.slice(0, keep.length - surplus);
    }
    var dead = [];
    for (i = 0; i < state.blocks.length; i++) {
      if (keep.indexOf(state.blocks[i]) < 0) dead.push(state.blocks[i]);
    }
    if (!dead.length) return false;
    preserve(function () {
      for (var j = 0; j < dead.length; j++) {
        if (dead[j].node.parentNode) dead[j].node.parentNode.removeChild(dead[j].node);
        var k = state.blocks.indexOf(dead[j]);
        if (k >= 0) state.blocks.splice(k, 1);
      }
    });
    return true;
  }

  /* 一帧的总维护：补段落 → 前后接章节 → 卸掉远的。返回有没有动过 DOM。 */
  function maintain(snap) {
    /* ⚠️ 分页模式**不跑这套**：补段 / 接章 / 卸载都会改卷轴长度，而页边界是
       按当前几何量出来的 —— 动一下就得重切。而且"提前把下一章接上"在分页模式下
       没有意义（位置由第几页决定，不由滚动量决定）。翻到末页要下一章时，
       gotoPage 会自己走 nextPageCross()。 */
    if (paged()) return false;
    var changed = fillDown(snap);
    if (maybeConnect(snap)) changed = true;
    return changed;
  }

  /* 一章画完之后在它尾巴上收个尾：
       还有下文 + 自动连读开着 → 什么都不挂（下一章已经在下面等着，中间插东西反而打断）
       还有下文 + 自动连读关着 → 挂一块「下一章 · xxx」，点一下才接上来
       全书最后一章           → 「全书完」
     这些都是 div，不吃 .chapter-content p 的 text-indent。 */
  function finishBlock(blk) {
    if (!blk.done || blk.end) return;
    var b = state.book;
    if (!b) return;
    var last = blk.idx >= b.toc.length - 1;
    /* 下一章已经在卷轴里了（比如刚才还开着自动连读）就不该再挂按钮 ——
       底下明明有字，中间插个「下一章」只会让人以为后面没了。 */
    if (!last && (state.settings.autoNext || findBlock(blk.idx + 1))) return;

    var d = document.createElement('div');
    d.className = 'chapter-end' + (last ? ' last' : '');
    var lab = document.createElement('div');
    lab.className = 'ce-label';
    lab.textContent = last ? '全书完' : '本章完';
    d.appendChild(lab);

    if (!last) {
      var btn = document.createElement('button');
      btn.className = 'ce-next ce-next-btn';
      btn.textContent = '下一章 · ' + b.toc[blk.idx + 1].t;
      btn.onclick = function () {
        if (d.parentNode) d.parentNode.removeChild(d);
        blk.end = null;
        loadChapter(blk.idx + 1, 'append').then(afterAppend);
      };
      d.appendChild(btn);
    }
    blk.node.appendChild(d);
    blk.end = d;
  }

  /* 把某一章尾巴上那张「本章完 · 下一章」收掉。
     「全书完」不动它 —— 那句话是真的，只有"点一下才接上来"的卡片会因为
     下一章其实已经挂着而变成假话（底下明明有字，中间插个按钮）。 */
  function dropStaleEnd(blk) {
    if (!blk || !blk.end || blk.end.classList.contains('last')) return;
    if (blk.end.parentNode) blk.end.parentNode.removeChild(blk.end);
    blk.end = null;
  }

  /* 开关切了之后，已经画在屏幕上的那些尾巴也得跟着变：
       开 → 清掉「下一章」按钮（有按钮说明是关着的时候画的）
       关 → 给已经画完的几章补上按钮 */
  function refreshBlockEnds() {
    if (!state.book) return;
    for (var i = 0; i < state.blocks.length; i++) {
      var blk = state.blocks[i];
      dropStaleEnd(blk);
      if (!state.settings.autoNext) finishBlock(blk);
      else if (blk.idx >= state.book.toc.length - 1) finishBlock(blk);
    }
  }

  /* 恢复上次读到的位置。
     ⚠️ 这是个**要等**的事，不能设一次就完：刚打开时卷轴里只有目标那一章，
        如果上次读到本章靠后的地方，可滚动长度根本不够 ——
        浏览器会把 scrollTop 夹在"当前最大可滚量"上（实测夹掉了 376px，
        等于往上弹了三段），而下一章是异步才接上来的，接上之后也不会自己回去。
     所以记一个"还欠着的目标"，每次卷轴变长就再试一次，直到真的落到位。
     手指一碰屏幕就作废（人要自己滑了，不能再把他拽回去）。

     ⚠️ 记的是**「哪一章 + 章内偏移」**，不是绝对 scrollTop。
        存绝对值的版本有两个坑（都是实测踩的）：
          · 后来插进来一章，同一个 scrollTop 就指到别处去了（差一章的高度）；
          · 长度不够时目标被夹住，而"夹过之后的值"会被当成目标反复落位，
            于是重开永远差那么几段（roll 那条断言就是这么红的）。
        现在每次都按**当前几何**重算，插入/卸载多少内容都不影响。 */
  function applyPendingTop() {
    var w = state.pendingWant;
    if (w == null) return;
    var el = readerEl();
    if (!w.blk || !w.blk.node || !w.blk.node.parentNode) { state.pendingWant = null; return; }
    if (el.scrollHeight - el.clientHeight <= 2) return;
    /* 这一块现在在卷轴里的绝对位置 —— 现量现算，不用任何缓存 */
    var d = w.blk.node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    var want = Math.max(0, Math.round(d + w.voff));
    /* ⚠️ 上一次是我们把它落在 lastTop 的。现在位置已经不一样了，说明是**别的东西**
       动了它（人滑了、自动翻页推了、跳章了）—— 那就别再把人拽回旧目标。
       注意"被夹住"的情形不算走掉：那时候 scrollTop 还是 lastTop（都在最大可滚量上），
       差值 0，继续等着卷轴接长再落。 */
    /* ⚠️ 只认"人往上退"这一种走掉。往下多出来不算 ——
       那往往是补段把下面撑长、preserve 把视口跟着往下带的结果，
       把这种当成"人动了"就会把欠着的目标误伤掉，位置再也回不去。
       真的人为滚动在 touchstart 里就已经把 pendingWant 清了（见 bindEvents）。 */
    if (w.lastTop != null && el.scrollTop < w.lastTop - 40) {
      state.pendingWant = null;
      return;
    }
    el.scrollTop = want;
    markProgScroll();
    w.lastTop = el.scrollTop;
    /* ⚠️ 只有**真的落在目标上**才算完成，用绝对值判 ——
       写成 `scrollTop >= want - 2` 的话，被夹到比 want 更大时也成立，
       会把"还没到位"误判成"到了"（这个坑实测踩到过）。
       到不了就留着，等下一章接进来 / 续排补长之后再试；
       实在到不了（比如目标在书末之外）由那个兜底计时器收掉。 */
    if (Math.abs(el.scrollTop - want) <= 2) state.pendingWant = null;
  }

  /* 整条卷轴重画：换书、目录跳远章、书签跳转都走这里。
     scrollY = 目标位置**在本章内**的滚动量 —— 跟存进库里的是同一个东西，
     所以老版本留下的数据原样可用，不用迁移。 */
  function renderStream(scrollY) {
    var b = state.book;
    if (!b) return Promise.resolve();
    if (state.index < 0) state.index = 0;
    if (state.index > b.toc.length - 1) state.index = b.toc.length - 1;

    var seq = ++state.streamSeq;
    stopFill();                     // 上一次打开/跳章的续排作废，别再往旧卷轴里塞段
    resetPctCache();
    fxClear();                     // 重画整条卷轴之前，先把还浮在屏幕上的翻页动画收掉
    state.blocks = [];
    state.loading = {};
    state.pendingWant = null;
    clearTimeout(pendingTimer);
    contentEl().innerHTML = '';
    readerEl().scrollTop = 0;
    readerEl().classList.toggle('paged', paged());   // 分页模式下不让手指自由滚

    return loadChapter(state.index, 'append').then(function (blk) {
      if (!blk || seq !== state.streamSeq) return;

      /* ⚠️ 打开**不等排版**。
         以前这儿是"先把这一章排到上次读到的位置那么长，再去定位"——
         于是打开耗时正比于上次读得多深，真机上就是几秒到几十秒的假死，
         连 showLoading 的看门狗都排不上队（"一直停在正在排版正文"就是这么来的）。

         现在：makeBlock 已经把头一批段建好了，够撑起一屏多，
         就**立刻定位、立刻收遮罩**；剩下的交给后台续排（startFill），
         每补一片位置就往目标推一次，参考线上那一行保持不动。 */
      finishBlock(blk);                // 小章（首批就排完）在这儿挂「本章完」
      setAutoHidden(false);            // 换章一律把栏放出来
      markTocCurrent();

      requestAnimationFrame(function () {
        if (seq !== state.streamSeq) return;
        /* 定位：scrollY 是"视口顶边在章内的第几个像素"（见 anchorOf）。
           把它换算成此刻的 scrollTop —— 只认当前几何，不认常量：
           顶部留白在上下栏收起时会变，写死一个数就会差几十像素。 */
        state.pendingWant = { blk: blk, voff: Math.max(0, scrollY || 0) };
        applyPendingTop();
        var snap = snapshot();
        if (maintain(snap)) snap = snapshot();
        applyPendingTop();             // 接上下一章之后长度够了，再落一次
        updatePct(snapshot());
        ensureNeighbors();             // 前后邻居补上，接着点上一章/下一章不用重画
        clearTimeout(pendingTimer);
        /* 兜底作废时间给足：邻居章节是异步来的，2.5 秒足够它接上来再落一次 */
        pendingTimer = setTimeout(function () { state.pendingWant = null; }, 2500);

        /* 后台把这一章补到"上次读到的位置那么长"。补不够也不会卡 ——
           位置先落在能到的地方，人往下滑时 fillDown 接着补。 */
        startFill(blk, (scrollY || 0) + readerEl().clientHeight, seq);

        if (paged()) {
          /* 分页模式：位置还是按像素落（跟卷轴同一套），落完再反算"这是第几页"，
             并把这一章切出来。排不够长就先切到能切的地方，翻页时再接着排。 */
          computePages(blk);
          state.pageNo = currentPage(blk);
          updatePageLabel();
        }
      });
    });
  }

  /* ==================================================================
     打开书时的「续排」—— 这是"一直卡在正在排版正文"的根治点。

     老做法是：**先把这一章排到"上次读到的位置那么长"，才收遮罩**。
     于是打开一本书的耗时正比于"上次读得多深" —— 读到第 3000 段，
     就要先建出 3000 个 <p> 再说。真机上这就是好几秒到几十秒的假死，
     期间主线程被独占，连 showLoading 那个 8 秒看门狗的 setTimeout 都排不上队，
     所以表现就是"永远停在正在排版正文"。加总量上限（1600 段）只是把
     假死从"几十秒"压到"几秒"，没解决根子上的问题。

     现在改成两段式：
       · 打开时只做**一件小事**（首批段落已经在 makeBlock 里建好了），
         立刻定位、立刻收遮罩 —— 耗时跟"上次读到哪"完全无关。
       · 剩下的在**后台按时间片**慢慢补，每补一片就把位置往目标推一次
         （applyPendingTop 保证参考线上那一行不动，所以看着是内容在下面长出来）。
       · 手指一碰就停 —— 人要读了，不跟他抢主线程。

     三条保命的规矩（缺一条就会回到假死）：
       ① 一个时间片只补 SLICE_N 段、最多占 SLICE_MS 毫秒 —— 单个同步块小到不可能卡住。
       ② 片与片之间必须把主线程还回去（nextFrame）。
       ③ 总量仍有上限 INIT_CAP —— 真遇到没切开的天书，到此为止，剩下的交给滚动时补。 */
  var INIT_CAP = 2400;               // 续排的总量上限（段）
  var SLICE_MS = 8;                  // 一个时间片最多占用多少毫秒
  var SLICE_N = 24;                  // 一个时间片最多补多少段
  var INIT_BUDGET = 1200;            // 分页引擎那边用的时间预算（ensurePages）

  /* 让出一帧。**不能只靠 requestAnimationFrame**：它在页面不可见时不触发
     （WebView 被别的 Activity 盖住、切后台、部分机型的首次布局都可能），
     那一串 Promise 就永远挂在半路 —— 遮罩收不掉，看着就是"一直停在排版正文"。
     所以 rAF 和 setTimeout 一起赛跑：谁先来走谁。 */
  function nextFrame() {
    return new Promise(function (r) {
      var done = false;
      function go() { if (!done) { done = true; r(); } }
      try { requestAnimationFrame(go); } catch (e) { /* 老引擎没 rAF */ }
      setTimeout(go, 50);
    });
  }

  var fillJob = null;                // 正在后台续排的任务（同时只跑一个）

  function stopFill() {
    if (!fillJob) return;
    if (fillJob.raf) { try { cancelAnimationFrame(fillJob.raf); } catch (e) { } }
    if (fillJob.timer) clearTimeout(fillJob.timer);
    if (fillJob.raf2) { try { cancelAnimationFrame(fillJob.raf2); } catch (e) { } }
    fillJob = null;
  }

  /* need = 目标长度（上次读到的位置 + 一屏）。补到它，位置就能落回去。 */
  function startFill(blk, need, seq) {
    stopFill();
    if (!blk || blk.done) return;
    fillJob = { blk: blk, need: need, seq: seq, raf: 0, timer: 0, raf2: 0 };
    tickFill();
  }

  function tickFill() {
    var j = fillJob;
    if (!j) return;
    /* 卷轴被重画 / 换了书 / 卸载了 —— 这个任务已经没有意义 */
    if (j.seq !== state.streamSeq || !j.blk.node.parentNode) { stopFill(); return; }

    var t0 = Date.now();
    var blk = j.blk;
    while (!blk.done && blk.shown < INIT_CAP) {
      if (blk.box.offsetHeight >= j.need) break;
      if (!appendN(blk, SLICE_N)) break;
      if (Date.now() - t0 >= SLICE_MS) break;      // 这一片的时间用完了，让位
    }

    /* 每补一片就把位置往目标推一次。内容变长之后 applyPendingTop 会把
       视口顶边挪到"上次读到的那一行的章内偏移"上，参考线上的字保持不动。 */
    applyPendingTop();
    /* pendingWant 的作废时间跟着续排往后推 —— 否则大章节还没补够就被作废了 */
    if (state.pendingWant) {
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () { state.pendingWant = null; }, 2000);
    }

    if (blk.done || blk.shown >= INIT_CAP || blk.box.offsetHeight >= j.need) {
      finishBlock(blk);              // 排完了才挂「本章完」/ 下一章按钮
      updatePct(snapshot());
      stopFill();
      return;
    }

    /* 让出一帧再继续。rAF 优先（跟绘制对齐、不浪费帧），
       setTimeout 兜底（页面不可见时 rAF 不来，靠它推进）。 */
    var job = fillJob;
    if (!job) return;
    job.raf = requestAnimationFrame(function () { job.raf = 0; tickFill(); });
    job.timer = setTimeout(tickFill, 60);
  }
  /* ================== 分页引擎：真·一屏一屏翻 ==================

     上下   = 卷轴（现在这套：一条长书页，随便滑）
     覆盖 / 平滑 / 仿真 = 分页（一屏一屏，位置由"第几页"决定）

     ⭐ 分页**不是另一套 DOM**。页边界是"段落粒度"的，所以做法只是在现有卷轴上
       量出"每页的第一段是谁"，再把视口顶边对准它。渲染、增量补段、窗口化、
       打开防卡、进度/书签那几套基础设施全部白用 —— 这也是选它而不是 CSS columns
       的原因（columns 得一次排完整章，正是我们刚修好的那个卡死风险）。

     ⚠️ 分页模式下**不让手指自由滚**（`.reader-body.paged { overflow: hidden }`）：
        一屏一屏的意思是位置由"第几页"说了算，不是由滚动量说了算。
        overflow:hidden 的容器仍然能用 JS 设 scrollTop（Chrome 一直支持），
        所以程序化翻页不受影响。

     ⚠️ 进度 / 书签**不用改数据结构**：分页和卷轴一样都是"视口顶边在章内第几个像素"，
        所以老进度照旧能用，重开时落回同一个像素，再反算出是第几页。 */

  /* ⚠️ 真分页**已经停用**（2026-09-21 她定的：只保留上下滑动的卷轴）。

     下面这一整套（computePages / gotoPage / 页尾遮罩 / 定时自动翻页…）
     暂时留在代码里没删，但**开关在这儿关死** —— 哪怕库里还存着旧的
     `pageTurn = cover`，也绝不会再进分页模式。

     将来哪天要真分页：① 把这里改回 `state.settings.pageTurn !== 'vscroll'`；
     ② 把设置面板那一行加回 index.html；③ init 里那段"强制拉回上下"要删掉。 */
  function paged() { return false; }

  /* 一页多高 = 正文可视高度 − 上下留白（留白是给眼睛喘气的，不算进一页） */
  function pageH() {
    var el = readerEl();
    var cs = getComputedStyle(el);
    var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    return Math.max(160, el.clientHeight - pad);
  }

  /* 段落位置缓存：每段相对章顶多少个 px。
     字号 / 行距 / 字体 / 页高 / 宽度一变就作废（key 变了整段重扫）。 */
  function topsKey() {
    var s = state.settings;
    return [s.fontSize, s.lineHeight, s.fontFamily,
      Math.round(pageH()), readerEl().clientWidth].join('|');
  }
  function scanTops(blk) {
    var key = topsKey();
    if (blk.topsKey !== key) { blk.tops = []; blk.topsKey = key; blk.pages = null; }
    var kids = blk.box.children;
    /* 先读一次基准线，然后连续读 rect —— 中间不写 DOM，浏览器只排一次版。
       一个个读是 O(段数) 的强制布局，但每批只做新增的那几个，摊下来很便宜。 */
    var base = blk.node.getBoundingClientRect().top;
    while (blk.tops.length < kids.length) {
      var k = blk.tops.length;
      blk.tops.push(kids[k].getBoundingClientRect().top - base);
    }
    if (blk.tops.length > kids.length) blk.tops.length = kids.length;
  }

  /* 切页：pages = [{ s: 段索引, y: 相对章顶的 px }]
     ⚠️ 判据必须是"这一段的**下沿**放不放得进本页"，不是"段首越没越过页底"。
        只判段首的话，一段从页尾前一点点开始、往下伸出去大半段，页尾就溢出了 ——
        实测就是底栏把最后一行吃掉一半（截图里看到的）。放不下就整段推到下一页，
        页底于是留一截空白，跟纸质书一样，不是 bug。

     近似：第 i 段的下沿用第 i+1 段的顶（段间距就是那个 margin）。 */
  function computePages(blk) {
    scanTops(blk);
    var ph = pageH();
    var total = blk.node.offsetHeight;        // 章总高（含标题）；没排完就是当前高度
    var tops = blk.tops;
    var pages = [{ s: 0, y: 0 }];             // 第一页带章节标题
    var pageTop = 0;                          // 本页在章内的起点
    for (var i = 1; i < tops.length; i++) {
      var bottom = (i + 1 < tops.length) ? tops[i + 1] : total;
      if (bottom - pageTop > ph) {
        pages.push({ s: i, y: tops[i] });
        pageTop = tops[i];
      }
    }
    blk.pages = pages;
    return pages;
  }

  /* 排到"至少 n+1 页"，分帧 + 时间预算（老规矩：不许把主线程占死）。 */
  function ensurePages(blk, n, budget) {
    budget = budget || INIT_BUDGET;
    var t0 = Date.now();
    function step() {
      computePages(blk);
      if (blk.done || (blk.pages && blk.pages.length > n)) return Promise.resolve(blk.pages);
      if (Date.now() - t0 > budget) return Promise.resolve(blk.pages);
      var i = 0;
      while (!blk.done && i++ < 4) appendWithin(blk);
      return nextFrame().then(step);
    }
    return step();
  }

  /* 正文顶部那截留白（给状态栏/顶栏让位的）。
     ⚠️ 它必须参与换算：`scrollTop = S` 时，内容坐标 c 的东西出现在
        距容器顶 `c - S` 的地方；要让页首段落落在**内容区顶部**（留白下面），
        得 `S = c - padTop`。不减这个数，每一页都会往上顶 56px ——
        第一页的标题会缩到状态栏底下（测试量出来页首偏移 -56px 才发现的）。 */
  function padTop() {
    return parseFloat(getComputedStyle(readerEl()).paddingTop) || 0;
  }

  /* 第 n 页在卷轴里的绝对位置。现量现算 —— 接章 / 补段都会让它变，不能缓存。 */
  function pageAbsTop(blk, n) {
    var pages = blk.pages || [];
    if (!pages.length) return 0;
    if (n < 0) n = 0;
    if (n > pages.length - 1) n = pages.length - 1;
    var el = readerEl();
    var d = blk.node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    return Math.max(0, Math.round(d + pages[n].y - padTop()));
  }

  /* 现在在第几页：看视口顶边落在哪两页之间（跟 pageAbsTop 用同一套坐标） */
  function currentPage(blk) {
    var pages = blk.pages || [];
    if (!pages.length) return 0;
    var el = readerEl();
    var d = blk.node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    var y = el.scrollTop - d + padTop();      // 视口顶边在章内的位置
    var n = 0;
    for (var i = 1; i < pages.length; i++) {
      if (pages[i].y <= y + 2) n = i; else break;
    }
    return n;
  }

  /* 切进 / 切出分页模式：换掉"能不能自由滚"，并把当前章的页切出来。
     ⚠️ 从卷轴切过来时视口可能正停在某一页的中间 —— 吸附到那一页的顶部，
        不然"第一页看半截"会让人以为分页算错了。 */
  function applyPaged() {
    var el = readerEl();
    if (!el) return;
    var p = paged();
    el.classList.toggle('paged', p);
    setAutoHidden(false);      // 分页模式下栏不许自动收（页码得一直看得见）
    /* ⚠️ 分页模式下"一页"必须是**完整看得见**的一屏：正文的上下留白得让开
       顶栏和底栏 —— 它们是浮层、不占布局高。不让开的话页首那行会被顶栏压掉
       一半（截图里"第 11 段"那行被切就是这么来的），页尾同理被底栏吃掉。
       量的是真实高度（各家安全区不一样），所以别写死像素。
       head/foot 拿不到高度（阅读页还没显示）时先不设 —— 进阅读页会再调一次。 */
    if (p) {
      var head = $('reader-head').offsetHeight, foot = $('reader-foot').offsetHeight;
      if (head && foot) {
        el.style.paddingTop = Math.round(head + 10) + 'px';
        el.style.paddingBottom = Math.round(foot + 10) + 'px';
      }
    } else {
      el.style.paddingTop = '';
      el.style.paddingBottom = '';
    }
    /* 底栏那两个按钮的字也要跟着换：一屏一屏的时候叫"上一页/下一页" */
    $('btn-prev').textContent = p ? '上一页' : '上一章';
    $('btn-next').textContent = p ? '下一页' : '下一章';
    var blk = findBlock(state.index);
    if (paged()) {
      if (blk) {
        computePages(blk);
        state.pageNo = currentPage(blk);
        moveTo(pageAbsTop(blk, state.pageNo));
      }
      updatePageLabel();
    } else {
      lastChapText = '';                  // 让 updatePct 把纯章节名写回去
      updatePct(snapshot());
    }
  }

  /* 页尾遮罩：把"下一页开头那一小截"盖掉。
     ⚠️ 为什么需要它：内容是一条连续的长书页，页边界只决定"翻页跳到哪"，
        拦不住浏览器把下一页的第一段在页底排出来一小截 ——
        看着就是"最后一行被切了一半"（截图里抓到过：最后一行底 807，
        而内容区底只有 641）。
     顶边 = 本页最后一段的下沿（也就是下一页首段的前一段），底边 = 屏幕底。 */
  function updatePageTail() {
    var t = $('page-tail');
    if (!t) return;
    var blk = findBlock(state.index);
    if (!paged() || !blk || !blk.pages) { t.style.display = 'none'; return; }
    var next = blk.pages[state.pageNo + 1];
    if (!next) { t.style.display = 'none'; return; }   // 本章最后一页：底下没东西可露
    var kid = blk.box.children[next.s - 1];
    if (!kid) { t.style.display = 'none'; return; }
    var box = $('page-reader').getBoundingClientRect();
    t.style.top = Math.round(kid.getBoundingClientRect().bottom - box.top) + 'px';
    t.style.display = 'block';
  }

  function updatePageLabel() {
    var b = state.book;
    if (!b) return;
    var blk = findBlock(state.index);
    var t = b.toc[state.index] ? b.toc[state.index].t : '　';
    var txt = paged() && blk && blk.pages
      ? t + ' · 第 ' + (state.pageNo + 1) + ' / ' + blk.pages.length + ' 页'
      : t;
    if (txt !== lastChapText) { lastChapText = txt; $('fc-title').textContent = txt; }
    updatePageTail();
  }

  function gotoPage(n) {
    var blk = findBlock(state.index);
    if (!blk) return;
    if (!blk.pages) computePages(blk);
    var total = blk.pages ? blk.pages.length : 1;
    if (n < 0) { prevPageCross(); return; }
    if (n > total - 1) {
      /* 本章最后一页再往后：先把这一章排完确认真的到底了，再进下一章 */
      ensurePages(blk, total + 1).then(function () {
        if (blk.pages && n > blk.pages.length - 1) nextPageCross();
        else { state.pageNo = n; moveTo(pageAbsTop(blk, n)); updatePageLabel(); }
      });
      return;
    }
    state.pageNo = n;
    /* 翻页动画在这里生效：覆盖 / 仿真是那对一屏大小的浮层，平滑是自己滚过去 */
    moveTo(pageAbsTop(blk, n));
    updatePageLabel();
    saveProgressSoon();
  }

  function nextPage() { gotoPage(currentPage(findBlock(state.index) || { pages: [] }) + 1); }
  function prevPage() { gotoPage(currentPage(findBlock(state.index) || { pages: [] }) - 1); }

  /* 翻过本章的边界：末页 → 下一章第 1 页；首页 → 上一章（排完才知道它有几页） */
  /* 分页模式下进入某一章：切页 → 落在它的第 1 页 → 更新页码。
     ⚠️ 那一章可能还在异步加载（邻居预取在飞），**必须等它挂上来再切** ——
        不等的话会撞上"章号已经变了、页码还停在上一章"这种自相矛盾的显示
        （测试里就量到过：章 2，页 26/0，底栏却写着"第1章 · 第 26 / 26 页"）。 */
  function pagedEnter(i) {
    var tries = 0;
    (function wait() {
      var blk = findBlock(i);
      if (!blk) { if (++tries < 50) setTimeout(wait, 80); return; }
      if (state.index !== i) return;          // 期间人又跳走了，别抢他的位置
      computePages(blk);
      state.pageNo = 0;
      moveTo(pageAbsTop(blk, 0));
      updatePageLabel();
    })();
  }

  function nextPageCross() {
    var b = state.book;
    if (!b) return;
    /* 末页再往后就是全书读完了 —— 停下并说一声。别只 toast，
       否则自动翻页会一直在这儿空转着弹提示。 */
    if (state.index >= b.toc.length - 1) { stopAutoPage(true); return; }
    gotoChapter(state.index + 1);
  }
  function prevPageCross() {
    var b = state.book;
    if (!b) return;
    if (state.index <= 0) { toast('已经是第一页'); return; }
    var i = state.index - 1;
    gotoChapter(i, true);      // 定位到那一章的最后一页，由下面自己来
    var blk = findBlock(i);
    if (!blk) return;
    /* 上一章的最后一页 —— 得先把它排完才知道一共几页（分帧排，不卡） */
    ensurePages(blk, 1e9).then(function () {
      if (!blk.pages) return;
      state.pageNo = blk.pages.length - 1;
      moveTo(pageAbsTop(blk, state.pageNo));
      updatePageLabel();
    });
  }

  /* ---------------- 锚点跟随 / 进度 ---------------- */

  /* 参考线跨进新的一章时更新 state.index ——
     标题栏那个「第几章/共几章」、目录里高亮的那一条、以及存进库的进度都看它。 */
  function syncAnchor(snap) {
    var a = anchorOf(snap);
    if (!a || a.blk.idx === state.index) return;
    state.index = a.blk.idx;
    markTocCurrent();
  }

  /* 已读字数只跟"当前是第几章"有关，滚动时不变 —— 缓存起来，
     否则每滚一帧都要把前面所有章的长度加一遍（3000 章的书 = 每帧 3000 次加法）。 */
  var pctBase = 0, pctBaseIdx = -1;
  var lastPctText = '', lastHeadText = '', lastChapText = '';

  function updatePct(snap) {
    var b = state.book;
    if (!b) return;
    if (!snap) snap = snapshot();
    var a = anchorOf(snap);
    if (!a) return;

    if (a.blk.idx !== pctBaseIdx) {
      pctBase = 0;
      for (var k = 0; k < a.blk.idx && k < b.toc.length; k++) pctBase += b.toc[k].len;
      pctBaseIdx = a.blk.idx;
    }
    var curLen = b.toc[a.blk.idx] ? b.toc[a.blk.idx].len : 0;
    var full = estFullHeight(a.blk);
    var ratio = full > 0 ? Math.max(0, Math.min(1, a.off / full)) : 1;
    var pct = b.totalChars ? (pctBase + curLen * ratio) / b.totalChars * 100 : 0;

    /* ⚠️ 读到全书最后一个字就得给 100%。
       各章 len 是按**字符数**算的，跟实际渲染高度不成正比（章节标题占的几行、
       段间距都不计），所以哪怕每章都算满，加总也到不了 100% ——
       用户看到的是"我明明读完了，它偏说 94%"，比不显示还难受。
       判据用位置：最后一章且真的滑到了底才给 100，其余情况封顶 99.9。 */
    var maxTop = snap.sh - snap.ch;
    if (a.blk.idx >= b.toc.length - 1 && maxTop > 2 && snap.top >= maxTop - 2) pct = 100;
    else pct = Math.min(pct, 99.9);

    /* 只在真的变了才写 DOM —— 滚动一帧写一次 textContent 会让浏览器反复重排这行字 */
    var s = pct.toFixed(1) + '%';
    if (s !== lastPctText) {
      lastPctText = s;
      $('fc-dot').style.left = pct.toFixed(2) + '%';        // 底栏那根进度条上的圆点
    }
    var head = b.title + ' · ' + (a.blk.idx + 1) + '/' + b.toc.length + ' · ' + s;
    if (head !== lastHeadText) { lastHeadText = head; $('reader-title').textContent = head; }
    var ct = b.toc[a.blk.idx] ? b.toc[a.blk.idx].t : '　';
    /* ⚠️ 分页模式下这行交给 updatePageLabel（它还要带"第几页/共几页"），
       两边都写会互相覆盖 —— 而且它们共用 lastChapText 做去重缓存，
       一个写章节名、一个写带页码的文案，缓存会被来回顶掉。 */
    if (!paged() && ct !== lastChapText) { lastChapText = ct; $('fc-title').textContent = ct; }
  }

  function resetPctCache() {
    pctBase = 0; pctBaseIdx = -1; lastPctText = ''; lastHeadText = ''; lastChapText = '';
  }

  function saveProgress() {
    if (!state.book) return;
    var a = anchorOf(snapshot());
    if (!a) return;
    DB.setProgress({
      bookId: state.book.id,
      index: a.blk.idx,
      scrollY: Math.max(0, Math.round(a.voff)),
      mark: state.mark,
      updatedAt: Date.now()
    });
  }
  function saveProgressSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 400);
  }

  function findBlock(idx) {
    for (var i = 0; i < state.blocks.length; i++) {
      if (state.blocks[i].idx === idx) return state.blocks[i];
    }
    return null;
  }

  /* 跳到某一章。**能滚过去就滚过去**，别把整条卷轴拆了重画 ——
     下一章在自动连读模式下本来就已经挂在下面了，这时候还去重画等于把"连贯"白做了。
     目标章没挂着（目录里跳很远那种）才退回重画。 */
  function jumpChapter(i) {
    var tgt = findBlock(i);
    if (!tgt) return false;
    var el = readerEl();
    var elTop = el.getBoundingClientRect().top;
    var boxTop = contentEl().getBoundingClientRect().top - elTop + el.scrollTop;
    var tgtTop = tgt.node.getBoundingClientRect().top - elTop + el.scrollTop;
    /* 让这一章的标题落回"开头"那个位置 —— 走 moveTo，翻页方式在这儿生效。
       ⚠️ 别再传目标块进去了：现在的动画作用在一屏大小的浮层上，不需要那一块。 */
    moveTo(Math.max(0, tgtTop - boxTop));
    return true;
  }

  /* 跳完章顺手把前后邻居补上。
     ⚠️ 不补的话，连点两次「下一章」第二次就会因为目标章没挂着而走 renderStream
        —— 整条卷轴拆了重画，屏幕闪一下，"连贯"就漏了（测试里抓到过：
        seq 变了，scrollTop 从 0 一步跳到目标）。
     ⚠️ 上一章（往前补）任何时候都补：往上能滑回上一章是阅读器的本分，不该是个开关。
     ⭐ 下一章只在**开着「章节连续阅读」**的时候才预取。
        关了就是手动模式：章末要挂「本章完 · 下一章」，点一下才接上来（README 4.7）。
        上一版这里无条件预取，于是手动模式下章末按钮挂出来了、
        下一章的内容又紧贴在按钮底下 —— 人看到的还是"连着读"，那个开关按了跟没按一样
        （实测：关掉之后刚打开就挂着 [0,1] 两章 + 一个"下一章"按钮）。 */
  function ensureNeighbors() {
    var b = state.book;
    if (!b) return;
    var i = state.index;
    if (state.settings.autoNext && i + 1 <= b.toc.length - 1 && !findBlock(i + 1)) {
      loadChapter(i + 1, 'append').then(afterAppend);
    }
    if (i - 1 >= 0 && !findBlock(i - 1)) {
      loadChapter(i - 1, 'prepend').then(afterAppend);
    }
  }

  /* noPaged = true：调用方自己负责分页定位（比如"翻回上一章"要落在它最后一页） */
  function gotoChapter(i, noPaged) {
    var b = state.book;
    if (!b) return;
    if (i < 0 || i > b.toc.length - 1) return;
    state.index = i;
    if (jumpChapter(i)) {
      saveProgressSoon();
      maintain(snapshot());
      ensureNeighbors();
      if (paged() && !noPaged) pagedEnter(i);
      return;
    }
    renderStream(0);
    if (paged() && !noPaged) pagedEnter(i);
  }
  /* ⚠️ 这两个必须有返回值。
     autoTick 里那句 `if (!nextChapter()) { stopAutoPage(true); return; }`
     靠的就是"有没有真的走到下一章"，而它们以前**什么都不 return** ——
     undefined 恒为假，于是自动翻页每滚到一次卷轴底部：章是跳过去了，
     同时也被判成"读完了"：停下、小胶囊收掉、还提示「已经读完了」（实测复现）。
     「已经是最后一章」这句吭声也从函数里挪到调用方 ——
     按钮和手势该有反馈，自动翻页不该每过一章就弹一条。 */
  function nextChapter() {
    if (!state.book) return false;
    if (state.index >= state.book.toc.length - 1) return false;
    gotoChapter(state.index + 1);
    return true;
  }
  function prevChapter() {
    if (!state.book) return false;
    if (state.index <= 0) return false;
    gotoChapter(state.index - 1);
    return true;
  }

  /* ---------------- 目录 ---------------- */
  /* 列表统一写成「第X章：章节名」。
     目录里存的标题常常自带"第X章"，直接拼会变成"第1章：第1章 风起" —— 先把前缀剥掉。 */
  function tocLabel(i) {
    var b = state.book;
    var t = (b.toc[i] && b.toc[i].t) || '';
    var name = t.replace(/^\s*第\s*[0-9一二三四五六七八九十百千零〇]+\s*章\s*[：:．.\-—–]?\s*/, '');
    return '第' + (i + 1) + '章' + (name ? '：' + name : '');
  }

  /* 副信息栏左边那行。
     ⚠️ 「连载状态」离线书没有这个信息（没有更新源、也没有连载平台），
        不编 —— 放的是能算出来的：字数 + 最新那一章。 */
  function tocMeta() {
    var b = state.book;
    var c = b.totalChars || 0;
    var size = c >= 1000 ? (c / 10000).toFixed(1) + ' 万字' : c + ' 字';
    return size + ' · 最新 第' + b.toc.length + '章';
  }

  /* 一次画多少章：超过 600 章只画当前章前后各 200 章，配上一批/下一批 */
  function tocWinFor(idx) {
    var n = state.book ? state.book.toc.length : 0;
    var f = 0, t = n;
    if (n > 600) {
      f = Math.max(0, Math.min(idx - 200, n - 400));
      t = Math.min(n, f + 400);
    }
    return [f, t];
  }

  function openToc() {
    state.tocAnchor = null;                 // 打开时以"正在读的那一章"为中心
    renderToc();
    $('drawer-toc').classList.add('open');
    requestAnimationFrame(function () {
      syncTocBar();
      var cur = $('toc-list').querySelector('.toc-item.cur');
      /* 一打开就滚到当前章：几千章的书，不这么做翻到目录只能看见开头 */
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
      syncTocBar();
    });
  }
  function closeToc() { $('drawer-toc').classList.remove('open'); }

  function renderToc() {
    var b = state.book;
    if (!b) return;
    var box = $('toc-list');
    box.innerHTML = '';
    var n = b.toc.length;
    $('toc-title').textContent = b.title;
    $('toc-meta').textContent = tocMeta();
    $('toc-order').classList.toggle('on', !!state.tocDesc);

    if (state.mark && b.toc[state.mark.index]) {
      var m = document.createElement('div');
      m.className = 'toc-item mark';

      var label = document.createElement('span');
      label.className = 'toc-mark-label';
      label.textContent = '书签 · ' + b.toc[state.mark.index].t;
      label.onclick = function () {
        closeToc();
        state.index = state.mark.index;
        renderStream(state.mark.scrollY || 0);
      };

      var del = document.createElement('button');
      del.className = 'toc-mark-del';
      del.textContent = '×';
      del.onclick = function (e) {
        e.stopPropagation();
        state.mark = null;
        $('btn-bookmark').classList.remove('on');
        saveProgress();
        renderToc();
        toast('已清除书签');
      };

      m.appendChild(label);
      m.appendChild(del);
      box.appendChild(m);
    }

    /* 目录一次别画太多：几千个节点会把抽屉拖住，真找起来也翻不过来。 */
    var anchor = state.tocAnchor == null ? state.index : state.tocAnchor;
    var w = tocWinFor(anchor), from = w[0], to = w[1];

    /* 倒序：把这一批章号反过来排 */
    var order = [], k;
    if (state.tocDesc) { for (k = to - 1; k >= from; k--) order.push(k); }
    else { for (k = from; k < to; k++) order.push(k); }

    /* 翻批次的按钮：正序时"更早的一批"在列表头、"更晚的一批"在列表尾；
       倒序时正好反过来。标签写的是目标批次的章号，跟顺序无关，不会误导。 */
    function mkJump(target, headArrow, tailArrow) {
      var w2 = tocWinFor(target);
      var txt = '第 ' + (w2[0] + 1) + '–' + w2[1] + ' 章';
      return tocJump((headArrow ? '‹ ' : '') + txt + (tailArrow ? ' ›' : ''), target);
    }
    var loT = Math.max(0, from - 400), hiT = Math.min(n - 1, to);
    var headTarget = state.tocDesc ? (to < n ? hiT : null) : (from > 0 ? loT : null);
    var tailTarget = state.tocDesc ? (from > 0 ? loT : null) : (to < n ? hiT : null);

    if (headTarget !== null) box.appendChild(mkJump(headTarget, true, false));
    for (var j = 0; j < order.length; j++) {
      var i = order[j];
      var d = document.createElement('div');
      d.className = 'toc-item';
      d.textContent = tocLabel(i);
      d.setAttribute('data-i', i);
      d.onclick = (function (idx) {
        return function () { closeToc(); gotoChapter(idx); };
      })(i);
      box.appendChild(d);
    }
    if (tailTarget !== null) box.appendChild(mkJump(tailTarget, false, true));
    if (from > 0 || to < n) {
      var info = document.createElement('div');
      info.className = 'toc-more';
      info.textContent = '共 ' + n + ' 章，这一屏是 ' + (from + 1) + '–' + to;
      box.appendChild(info);
    }
    markTocCurrent();
    syncTocBar();
  }

  /* 目录里翻批次的按钮 */
  function tocJump(text, targetIndex) {
    var d = document.createElement('div');
    d.className = 'toc-item toc-jump';
    d.textContent = text;
    d.onclick = function () {
      /* ⚠️ 这只是**换一批目录**，不是跳章 —— 别动 state.index，更别存进度。
         以前这里写的是 state.index = target 然后 saveProgress()，
         等于翻一次目录就把进度改成了那一批的第一章，退出去再进就跑错了。
         现在改用一个专门的窗口锚点。 */
      state.tocAnchor = targetIndex;
      renderToc();
      $('toc-list').scrollTop = 0;
    };
    return d;
  }

  /* ---------- 右侧悬浮的胶囊滚动条 ---------- */
  function syncTocBar() {
    var list = $('toc-list');
    var sbar = $('toc-sbar');
    var max = list.scrollHeight - list.clientHeight;
    if (max <= 4) { sbar.classList.add('hide'); return; }   // 短到不用滚就不出现
    sbar.classList.remove('hide');
    var track = $('sb-track'), th = $('sb-thumb');
    var usable = track.clientHeight - th.offsetHeight;
    if (usable <= 0) return;
    var p = Math.max(0, Math.min(1, list.scrollTop / max));
    th.style.top = (usable * p).toFixed(1) + 'px';
  }

  /* ================== 拖动器（两条滑动条共用） ==================

     ⭐ 卡顿的根因：以前两条都是"每次 pointermove 就读一次几何、再写一次 DOM"。
        读（`getBoundingClientRect` / `scrollHeight` / `clientHeight` / `offsetHeight`）
        会**逼浏览器立刻排版**；而正文里几千个 `<p>`、目录里上千条 `.toc-item`，
        排一次好几毫秒。写完下一帧又读，等于每个 pointermove 触发两三次全文档排版 ——
        手指一划就是每秒几十次完整排版，掉帧就是这么来的。
        现在：① **只在手指按下时量一次几何**，之后整段拖动都用缓存；
              ② 用 rAF 合并，一帧最多写一次 DOM。

     ⭐ "卡死"的根因：`pointerup` 在 WebView 里**可能根本不来** ——
        切后台、被系统手势接管、长按后系统把指针收走，都算常见。
        那时闭包里的 `dragging` 永远是 true，之后手指在屏幕上随便动一下都在"拖"，
        看着就是卡死 / 乱跳。现在给它三道保险：
          · pointercancel / pointerup（正常路径）
          · 页面被隐藏（visibilitychange / pagehide）
          · **3 秒没有任何事件就当松手**（最后一道，专治"up 丢了"） */
  var dragBusy = 0;

  function dragify(handle, ops) {
    var dragging = false, raf = 0, idle = 0, geo = null, lastPos = 0;
    var vertical = ops.axis === 'y';

    function posOf(e) { return vertical ? e.clientY : e.clientX; }

    function flush() {
      raf = 0;
      if (!dragging) return;
      ops.move(lastPos, geo);
    }
    function schedule(pos) {
      lastPos = pos;
      clearTimeout(idle);
      idle = setTimeout(stop, 3000);          // 三秒没动静 = 手指早没了，收尾
      if (!raf) raf = requestAnimationFrame(flush);
    }
    function begin(e) {
      if (dragging) return;
      dragging = true;
      dragBusy++;
      var p0 = posOf(e);
      geo = ops.measure(p0);                  // ⭐ 只在这里量一次
      /* 指针捕获：手指滑出滑块范围时仍然收得到后续事件（老引擎没有就跳过） */
      if (handle.setPointerCapture && e.pointerId != null) {
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 不支持就算了 */ }
      }
      if (ops.start) ops.start(geo);
      schedule(p0);
    }
    function stop() {
      if (!dragging) return;
      dragging = false;
      dragBusy = Math.max(0, dragBusy - 1);
      clearTimeout(idle);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (ops.end) ops.end(lastPos, geo);
    }
    function onMove(e) { if (dragging) schedule(posOf(e)); }

    if (window.PointerEvent) {
      handle.addEventListener('pointerdown', function (e) {
        e.preventDefault();                   // 别让浏览器顺手选中目录/正文的字
        begin(e);
      }, { passive: false });
      document.addEventListener('pointermove', onMove, { passive: true });
      document.addEventListener('pointerup', stop);
      document.addEventListener('pointercancel', stop);
    } else {
      handle.addEventListener('touchstart', function (e) { begin(e.touches[0]); }, { passive: true });
      document.addEventListener('touchmove', function (e) { if (dragging) schedule(posOf(e.touches[0])); }, { passive: true });
      document.addEventListener('touchend', stop);
      document.addEventListener('touchcancel', stop);
    }
    /* 页面被盖住 / 退到后台：一定收尾，别把 dragging 留在 true 上 */
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); });
    window.addEventListener('pagehide', stop);
  }

  function draggingNow() { return dragBusy > 0; }

  function bindTocBar() {
    var list = $('toc-list'), track = $('sb-track'), th = $('sb-thumb');

    /* ⚠️ 目录滚动本身也会触发 scroll 事件，而 syncTocBar 要读 4 个几何量 ——
       不节流的话，拖一次滑块 = 每帧多好几次强制排版。攒到下一帧做一次。 */
    var raf = 0;
    list.addEventListener('scroll', function () {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; syncTocBar(); });
    }, { passive: true });

    $('sb-up').onclick = function () { list.scrollTop -= list.clientHeight * 0.9; };
    $('sb-down').onclick = function () { list.scrollTop += list.clientHeight * 0.9; };

    dragify(th, {
      axis: 'y',
      /* 只在手指按下时量这一次：滑块的起始位置、滑轨能走多远、目录总共能滚多少 */
      measure: function (y0) {
        return {
          y0: y0,
          top0: parseFloat(th.style.top || '0') || 0,
          usable: Math.max(1, track.clientHeight - th.offsetHeight),
          max: Math.max(0, list.scrollHeight - list.clientHeight)
        };
      },
      start: function () { th.classList.add('drag'); },
      move: function (y, g) {
        var p = Math.max(0, Math.min(1, (g.top0 + (y - g.y0)) / g.usable));
        list.scrollTop = p * g.max;
        /* 滑块自己也要跟手 —— 不等 scroll 回调那一帧，不然拖着会有滞后感 */
        th.style.top = (g.usable * p).toFixed(1) + 'px';
      },
      end: function () { th.classList.remove('drag'); }
    });
  }

  function markTocCurrent() {
    var items = $('toc-list').querySelectorAll('.toc-item[data-i]');
    Array.prototype.forEach.call(items, function (el) {
      el.classList.toggle('cur', +el.getAttribute('data-i') === state.index);
    });
  }

  /* ---------------- 上下栏 ----------------
     两条栏是 absolute 浮在正文上的（见 CSS），不占布局高度 —— 原来它们各吃掉
     近百像素，正文上下就空出两条大白边。这里只管"什么时候收起来"：
       · 滚动：向下滑收起，向上滑或回到顶部时显示
       · 轻点 / 「沉浸模式」按钮：手动常驻收起，之后不再随滚动自动恢复 */
  function applyBars() {
    $('page-reader').classList.toggle('bars-off', state.imersed || state.autoHidden);
  }
  function setAutoHidden(v) {
    if (state.autoHidden === v) return;
    state.autoHidden = v;
    applyBars();
  }
  function toggleBars() {
    state.imersed = !state.imersed;
    if (!state.imersed) state.autoHidden = false;
    $('btn-fullscreen').classList.toggle('on', state.imersed);
    applyBars();
  }

  function openSet() { $('sheet-set').classList.add('open'); }

  /* 底栏那根进度条：拖圆点跳章。
     跳的是**章节比例**（跟目录里点一章一个意思）—— 一条连续的长书页里，
     人心里想的是"跳到第几章"，不是"跳到第几个像素"。
     ⚠️ 拖动过程中只挪圆点，松手才真的跳：跳一次章要等一次异步查库，
        边拖边跳会把库拖垮，画面也会一直在追。 */
  /* 底栏那根章节进度条：拖圆点跳章。
     跳的是**章节比例**（跟目录里点一章一个意思）—— 一条连续的长书页里，
     人心里想的是"跳到第几章"，不是"跳到第几个像素"。
     ⚠️ 拖动过程中只挪圆点，**松手才真的跳**：跳一次章要等一次异步查库，
        边拖边跳会把库拖垮，画面也会一直在追。 */
  function bindSeekBar() {
    var bar = $('fc-bar'), dot = $('fc-dot');
    var geom = null;

    dragify(bar, {
      axis: 'x',
      /* 按下时量一次就够：底栏在拖动过程中不会挪位置 */
      measure: function () { return bar.getBoundingClientRect(); },
      start: function () { dot.classList.add('drag'); },
      move: function (x, r) {
        var p = r.width ? (x - r.left) / r.width : 0;
        dot.style.left = (Math.max(0, Math.min(1, p)) * 100).toFixed(2) + '%';
      },
      end: function (x, r) {
        dot.classList.remove('drag');
        var b = state.book;
        if (!b || !b.toc.length) return;
        var p = r.width ? (x - r.left) / r.width : 0;
        var i = Math.round(Math.max(0, Math.min(1, p)) * (b.toc.length - 1));
        gotoChapter(Math.max(0, Math.min(b.toc.length - 1, i)));
      }
    });
  }

  /* ---------------- 事件 ---------------- */
  function bindEvents() {
    /* 底部导航：左右是页面，中间是导入 */
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.onclick = function () {
        var p = b.getAttribute('data-page');
        if (p === 'import') { pickFile(); return; }
        showPage(p);
        /* ⚠️ 两个页面都要重渲染，别只刷列表。
           原来切回书架只 showPage 不重渲染 —— 于是「继续阅读」便签、
           书架副标题（读了几本）、架上书的进度百分比全都停在切走之前那一刻：
           从阅读器里退出来再点书架，便签还写着上一本书。
           渲染本身有 shelfKeyOf 缓存兜着，没变化时不会白干。 */
        if (p === 'list') renderList();
        else renderShelf();
      };
    });

    $('btn-edit').onclick = function () { setEdit(!state.edit); };
    $('btn-fill').onclick = fillAll;
    $('btn-clear').onclick = clearAll;
    $('btn-list-import').onclick = pickFile;
    $('file-input').onchange = function () {
      importFiles(this.files);
      this.value = '';
    };

    /* 列表页搜索：敲一个字就重建一遍整个列表太贵（每本都要读进度、建一行 DOM），
       输入中文时尤其明显。改成停手 180ms 再渲染。 */
    $('search-input').oninput = function () {
      state.query = this.value || '';
      $('search-clear').style.display = state.query ? 'block' : 'none';
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderList, 180);
    };
    $('search-clear').onclick = function () {
      $('search-input').value = '';
      state.query = '';
      this.style.display = 'none';
      renderList();
    };

    /* 选书面板 */
    $('pick-close').onclick = closePick;
    $('pick-mask').onclick = closePick;

    /* 花名册 */
    $('btn-roster').onclick = openRoster;
    $('roster-close').onclick = closeRoster;
    $('roster-mask').onclick = closeRoster;

    /* 确认面板 */
    $('confirm-yes').onclick = function () {
      closeConfirm();
      if (confirmCb) { var cb = confirmCb; confirmCb = null; cb(); }
    };
    $('confirm-no').onclick = function () { closeConfirm(); confirmCb = null; };
    $('confirm-mask').onclick = function () { closeConfirm(); confirmCb = null; };

    $('btn-back').onclick = backFromReader;
    $('btn-toc').onclick = openToc;
    $('toc-mask').onclick = closeToc;
    $('toc-order').onclick = function () {
      state.tocDesc = !state.tocDesc;
      renderToc();
      $('toc-list').scrollTop = 0;
      syncTocBar();
    };
    bindTocBar();

    /* 底栏那两个：卷轴模式下是上一章 / 下一章，分页模式下是上一页 / 下一页。
       「已经是第一/最后一章」这句提示放在调用方（见 nextChapter 上面那段）。 */
    $('btn-prev').onclick = function () {
      if (paged()) prevPage();
      else if (!prevChapter()) toast('已经是第一章');
    };
    $('btn-next').onclick = function () {
      if (paged()) nextPage();
      else if (!nextChapter()) toast('已经是最后一章');
    };
    /* 底栏「设置」→ 阅读设置面板（字号 / 背景 / 翻页 / 底部分隔行） */
    $('btn-set').onclick = openReadSet;
    $('rs-mask').onclick = closeReadSet;
    $('set-mask').onclick = function () { $('sheet-set').classList.remove('open'); };

    /* 第一行：字号 A- / 数值 / A+ / 思源… › */
    $('rs-fs-minus').onclick = function () { saveSetting('fontSize', Math.max(14, state.settings.fontSize - 2)); };
    $('rs-fs-plus').onclick = function () { saveSetting('fontSize', Math.min(32, state.settings.fontSize + 2)); };
    $('rs-font').onclick = openFont;
    $('font-mask').onclick = function () { $('sheet-font').classList.remove('open'); };
    Array.prototype.forEach.call(document.querySelectorAll('#sheet-font .fp-row'), function (r) {
      r.onclick = function () {
        saveSetting('fontFamily', r.getAttribute('data-font'));
        $('sheet-font').classList.remove('open');
      };
    });

    /* 第二行：背景色块（选中的外面套一圈描边） */
    Array.prototype.forEach.call(document.querySelectorAll('#rs-theme .rs-dot'), function (b) {
      b.onclick = function () { saveSetting('theme', b.getAttribute('data-theme')); };
    });

    /* 第三行原本是「翻页方式」（覆盖/上下/仿真/平滑）。2026-09-21 撤掉了：
       只保留上下滑动的卷轴。入口没了，paged() 也是关死的（见它的注释）。 */

    /* 底部分隔行：自动翻页（匀速往下滚，速度可调）/ 更多阅读设置（老面板） */
    /* ⚠️ 开着的时候再点这一行，是**把速度面板叫回来**，不是关掉 ——
       关掉是速度面板里那个「退出自动翻页」的活。两种手势分手，别再抢一块地方。 */
    $('rs-auto').onclick = function () {
      if (state.settings.autoPage) { openSpeed(); return; }
      saveSetting('autoPage', true);
      closeReadSet();            // 开了就把设置面板收掉：它已经挡着正文了
      startAutoPage();
    };
    $('rs-more').onclick = function () { closeReadSet(); openSet(); };
    /* 那枚小胶囊：开着自动翻页时才出现，点一下把速度面板叫回来 */
    $('ap-pill').onclick = function () {
      if ($('sheet-speed').classList.contains('open')) closeSpeed();
      else openSpeed();
    };

    /* 速度面板：减速 - / 加速 + / 退出自动翻页 */
    $('sp-slow').onclick = function () {
      saveSetting('autoSpeed', Math.max(5, state.settings.autoSpeed - 1));
      syncSpeedPanel();
    };
    $('sp-fast').onclick = function () {
      saveSetting('autoSpeed', Math.min(60, state.settings.autoSpeed + 1));
      syncSpeedPanel();
    };
    $('sp-exit').onclick = function () {
      saveSetting('autoPage', false);
      stopAutoPage(false);
      syncReadSet();
    };

    /* 底栏四个功能键：
       目录 / 设置 = 开面板；亮度 = 开面板并滚到亮度那一行；
       夜间 = 一键切黑（记住之前是哪套，切回来还是它）。
       「更多」按她说的先占位：位置留着，功能以后再长。 */
    /* 「亮度」：弹的是底部那个独立的亮度面板（两行式），不是设置面板 */
    $('btn-light').onclick = openLight;
    $('light-mask').onclick = closeLight;
    $('lp-switch').onclick = function () {
      state.settings.lightFollowSys = !state.settings.lightFollowSys;
      applySettings();
      DB.setSetting('lightFollowSys', state.settings.lightFollowSys);
    };
    bindLightSlider();
    $('btn-night').onclick = function () {
      if (state.settings.theme === 'dark') {
        saveSetting('theme', state.lastLightTheme || 'paper');
      } else {
        state.lastLightTheme = state.settings.theme;   // 记住，切回来还是原来那套
        saveSetting('theme', 'dark');
      }
    };
    $('btn-more').onclick = function () { toast('「更多」的位置先留着，功能后面再长'); };

    /* 底栏那根进度条：拖圆点跳章。
       不是"拖动正文"，是**按章节比例定位**（跟目录跳章一个意思）——
       一条连续的长书页里，人心里想的是"跳到第几章"，不是"跳到第几个像素"。 */
    bindSeekBar();

    $('fs-plus').onclick = function () {
      saveSetting('fontSize', Math.min(32, state.settings.fontSize + 2));
    };
    $('fs-minus').onclick = function () {
      saveSetting('fontSize', Math.max(14, state.settings.fontSize - 2));
    };
    $('lh-plus').onclick = function () {
      saveSetting('lineHeight', Math.min(2.6, +(state.settings.lineHeight + 0.2).toFixed(1)));
    };
    $('lh-minus').onclick = function () {
      saveSetting('lineHeight', Math.max(1.2, +(state.settings.lineHeight - 0.2).toFixed(1)));
    };

    Array.prototype.forEach.call(document.querySelectorAll('#theme-pick .dot'), function (b) {
      b.onclick = function () { saveSetting('theme', b.getAttribute('data-theme')); };
    });

    Array.prototype.forEach.call(document.querySelectorAll('#font-pick .pill'), function (b) {
      b.onclick = function () { saveSetting('fontFamily', b.getAttribute('data-font')); };
    });

    /* 章末自动翻页开关。改完顺手把当前章尾那行提示也换掉 ——
       不然开了关、关了开，卡片上还写着上一次的说法，看着像没生效。 */
    Array.prototype.forEach.call(document.querySelectorAll('#auto-pick .pill'), function (b) {
      b.onclick = function () {
        var on = b.getAttribute('data-auto') === '1';
        saveSetting('autoNext', on);
        /* 开了关、关了开，屏幕上那几章的尾巴要立刻跟着变：
           开 → 已经挂着的「下一章」按钮得收掉；关 → 已经画完的几章要把按钮补上。
           不然看着就是"开关按了没反应"。 */
        refreshBlockEnds();
        if (on) maintain(snapshot());
      };
    });

    $('brightness').oninput = function () {
      state.settings.screenLight = +this.value;
      applyDim(+this.value);
    };
    $('brightness').onchange = function () {
      /* 在设置里动亮度滑块，也算"我要自己管" —— 自动把「跟随系统」关掉，
         不然会出现"我拖了可是画面没变"的怪事（跟随系统开着时那层压暗是撤掉的）。 */
      state.settings.lightFollowSys = false;
      saveSetting('screenLight', +this.value);
    };

    $('btn-fullscreen').onclick = toggleFullscreen;   // 系统栏 + 自己的两条栏一起收

    /* 书签：点一次就把书签更新到当前位置，不是 toggle。
       原来做成 toggle，手里有书签时再点一下就清掉了，容易误删。
       清除改到目录里书签条右侧的 × 。 */
    $('btn-bookmark').onclick = function () {
      var existed = !!state.mark;
      /* ⚠️ 存的是「锚点章节 + 视口顶边在章内的第几个像素」，不是 scrollTop。
         连续卷轴里 scrollTop 是相对整条卷轴的，换一次窗口同样的 scrollTop 就指到别处了；
         而"第几章、章内读了多少"是绝对量，什么时候跳回去都对得上（见 anchorOf 的注释）。 */
      var a = anchorOf(snapshot());
      state.mark = a
        ? { index: a.blk.idx, scrollY: Math.max(0, Math.round(a.voff)) }
        : { index: state.index, scrollY: 0 };
      this.classList.add('on');
      saveProgress();
      renderToc();
      toast(existed ? '书签已更新到当前位置' : '已加书签');
    };

    /* 滚动回调：一帧最多处理一次。
       原来 scroll 事件每来一次就同步做四件事（追加段落、算进度、存进度、切栏的 class），
       其中读 scrollTop/scrollHeight 会强制排版、写 textContent 又会让它重排 ——
       老 WebView 上滑起来就是一顿一顿的。现在攒到下一帧统一做，几何只读一次。

       ⚠️ maintain() 可能会补段落 / 接章节 / 卸章节，每一样都会改 scrollHeight，
          所以顺序是：量 → 维护 → 维护过就重量 → 再算进度。拿着旧的高度算进度是错的。 */
    $('reader-body').addEventListener('scroll', function () {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(function () {
        scrollRaf = 0;
        if (!state.book) return;
        /* 自动翻页开着的时候，是人滑的还是我们自己动的必须分清楚：
           人一滑就先让自动翻页让位一会儿（1.2 秒），不然两边对着拽。
           判据见文件头 looksProgrammatic 那段：拿当前位置和"上一次我们自己写进去的值"比，
           差出去 2px 以上就是别人挪的。 */
        var byUser = !looksProgrammatic();
        if (byUser && state.settings.autoPage) state.autoPauseUntil = Date.now() + 1200;
        var snap = snapshot();
        if (maintain(snap)) snap = snapshot();
        syncAnchor(snap);
        updatePct(snap);
        saveProgressSoon();
        var top = snap.top;
        if (state.imersed) return;          // 手动沉浸模式：不自动恢复
        /* ⚠️ 分页模式也一样：那里根本没有"滚动动作"，栏一收起来页码就看不见了，
           而页码正是分页最该一直摆着的信息（测试截图里底栏整条消失才发现）。 */
        if (paged()) return;
        var dy = top - state.lastTop;
        state.lastTop = top;
        if (Math.abs(dy) < 6) return;       // 抖一下不算方向
        if (top < 24) setAutoHidden(false); // 回到开头一定显示
        else setAutoHidden(dy > 0);
      });
    }, { passive: true });

    /* 兜底：任何一处 JS 抛错，都别留下转圈的遮罩把人锁在界面里。
       ⚠️ 'error' 只管同步抛出的那种。这个项目里大部分会翻车的动作是 Promise
       （查库、导入、落进度），它们挂了走的是 unhandledrejection，
       'error' 一次都收不到 —— 上一版就是"书架空白但一声不吭"这种局面。 */
    window.addEventListener('error', function (e) {
      hideLoading();
      toast('出了点问题：' + ((e && e.message) || '未知错误'));
    });
    window.addEventListener('unhandledrejection', function (e) {
      hideLoading();
      var r = e && e.reason;
      toast('出了点问题：' + ((r && (r.message || r.name)) || String(r || '未知错误')));
    });

    // 转屏 / 键盘弹出后重新量一次，别让架子高度停在旧值
    window.addEventListener('resize', ensureSquareCanvas);

    // 长按左上角「砚读」开诊断面板（正常用不会碰到，出问题时要截图用）
    (function () {
      var h1 = document.querySelector('#page-shelf h1');
      if (!h1) return;
      var t = null;
      function start() { clearTimeout(t); t = setTimeout(toggleDebug, 800); }
      function stop() { clearTimeout(t); }
      h1.addEventListener('pointerdown', start, { passive: true });
      h1.addEventListener('pointerup', stop, { passive: true });
      h1.addEventListener('pointercancel', stop, { passive: true });
    })();

    // Android 返回键：优先关浮层，其次回上一页，最后才交给系统退出
    document.addEventListener('backbutton', function () {
      if ($('sheet-confirm').classList.contains('open')) { closeConfirm(); return; }
      if ($('sheet-light').classList.contains('open')) { closeLight(); return; }
      if ($('sheet-font').classList.contains('open')) { $('sheet-font').classList.remove('open'); return; }
      if ($('sheet-readset').classList.contains('open')) { closeReadSet(); return; }
      if ($('sheet-pick').classList.contains('open')) { closePick(); return; }
      if ($('sheet-roster').classList.contains('open')) { closeRoster(); return; }
      if ($('drawer-toc').classList.contains('open')) { closeToc(); return; }
      if ($('sheet-set').classList.contains('open')) { $('sheet-set').classList.remove('open'); return; }
      if ($('page-reader').classList.contains('active')) { backFromReader(); return; }
      if (state.edit) { setEdit(false); return; }
      if (state.page === 'list') { showPage('shelf'); renderShelf(); }
    });

    // 手势：左右滑动翻章，轻点切换工具栏
    var sx = 0, sy = 0, st = 0;
    var body = $('reader-body');
    body.addEventListener('touchstart', function (e) {
      var t = e.changedTouches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now();
      state.pendingWant = null;    // 手指来了："欠着的那个位置"作废，别把人拽回去
      stopFill();                  // 后台续排也停：人要读了，不跟他抢主线程
      stopSmooth();                // 平滑滚动也一样：人要自己滑了，别再推
      /* 手指按下是最确定不过的"人在动"，让位直接在这里给，
         别等 scroll 事件去归因 —— 自动翻页每帧都在写 scrollTop，归因会输给它。 */
      if (state.settings.autoPage) state.autoPauseUntil = Date.now() + 1200;
    }, { passive: true });
    body.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy, dt = Date.now() - st;
      if (dt < 700 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        /* 分页模式下左右滑翻的是**页**，卷轴模式下翻的是章 ——
           一屏一屏的时候人想的是"翻到下一屏"，不是"跳到下一章"。 */
        if (paged()) { if (dx < 0) nextPage(); else prevPage(); }
        else if (dx < 0) { if (!nextChapter()) toast('已经是最后一章'); }
        else { if (!prevChapter()) toast('已经是第一章'); }
      } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        /* 自动翻页开着的时候，轻点的意思是「我要调速」——
           开了之后设置面板和速度面板都收掉了（她要求的），
           总得留一个顺手的入口：轻点正文 → 速度面板出来；再轻点 → 收回去。
           关着的时候还是老规矩：轻点收/放上下两条栏。 */
        if (state.settings.autoPage) {
          if ($('sheet-speed').classList.contains('open')) closeSpeed();
          else openSpeed();
        } else if (paged()) {
          /* 分页模式（且没开自动翻页）：点左/右三分之一翻页，点中间收放两条栏。
             这是纸质阅读器的老规矩，比"只有滑动能翻页"好上手。 */
          var r = body.getBoundingClientRect();
          var rel = (t.clientX - r.left) / (r.width || 1);
          if (rel < 0.33) prevPage();
          else if (rel > 0.67) nextPage();
          else toggleBars();
        } else {
          toggleBars();
        }
      }
    }, { passive: true });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    /* Android 里 WebView 是 edge-to-edge 的，状态栏浮在内容之上；
       而 env(safe-area-inset-*) 在 Android WebView 恒为 0（iOS 才有）。
       所以识别出原生环境后打一个 class，由 CSS 补出状态栏高度。 */
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      document.documentElement.classList.add('native');
      /* 系统栏多高是机器说了算的（刘海/挖孔/手势条各家都不一样），
         量出来写进 --safeT / --safeB，顶栏底栏才贴得住物理边界。 */
      syncInsets();
    }

    DB.getSettings().then(function (s) {
      Object.keys(s || {}).forEach(function (k) {
        if (k in state.settings) state.settings[k] = s[k];
      });
      /* ⚠️ 真分页停用之后，老版本存下来的 pageTurn = cover / sim / smooth 必须拉回
         "上下"并写回库 —— 不然装了新包的人一打开还是分页模式，看着像没升级。
         （paged() 已经关死，这一下只是为了把库里那个值也修正掉。） */
      if (state.settings.pageTurn !== 'vscroll') {
        state.settings.pageTurn = 'vscroll';
        DB.setSetting('pageTurn', 'vscroll');
      }
    }).catch(function () { /* 首次运行没有设置，用默认值 */ })
      .then(function () {
        applySettings();
        bindEvents();
        showPage('shelf');
        return renderShelf();
      });
  }

  /* 调试入口：只读地看一眼卷轴现在挂着哪几章。
     自动化测试（tools/cdp-run.js + tools/selftest-cases.js）靠它断言
     "章节是不是连续的、有没有被整条重画过、自动翻页有没有被误判成人滑"，
     真机上也能用来查"卡在哪一章"。
     ⚠️ 这里只许加只读字段，别在这儿改任何状态。 */
  window.__reader = function () {
    var cur = findBlock(state.index);
    return {
      seq: state.streamSeq,
      index: state.index,
      /* 分页模式下这几个数是测试的判据（也方便真机上查"卡在第几页"） */
      paged: paged(),
      pageNo: state.pageNo,
      pageCount: cur && cur.pages ? cur.pages.length : 0,
      /* 排查"位置落不到位"用：还欠着的目标 + 续排有没有在跑 */
      pendingWant: state.pendingWant
        ? { idx: state.pendingWant.blk.idx, voff: Math.round(state.pendingWant.voff), lastTop: state.pendingWant.lastTop }
        : null,
      filling: !!fillJob,
      autoPage: !!state.settings.autoPage,
      autoNext: !!state.settings.autoNext,
      /* 自动翻页是不是正被"以为人滑了一下"的判定按住了（C6 那条判据就看它） */
      autoPaused: Date.now() < state.autoPauseUntil,
      blocks: state.blocks.map(function (b) {
        return {
          idx: b.idx, h: b.node.offsetHeight,
          p: b.box.children.length, shown: b.shown,
          total: b.paras.length, done: b.done
        };
      })
    };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
