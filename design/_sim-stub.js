/**
 * 手机模拟器：给假数据 + 模拟安卓环境的桩
 * 由 tools/build-phone-sim.js 注入到 design/phone-sim.html 里，
 * 位置在 db.js / shelf.js 之后、app.js 之前 —— 正好把 window.DB 换掉。
 *
 * 参数：?n=12 书库几本  ?on=5 上架几本  ?edit=1 进编辑态  ?page=list  ?dbg=1  ?act=edit
 */
(function () {
  var q = new URLSearchParams(location.search);
  var N = +(q.get('n') || 12);
  var ON = +(q.get('on') || 5);
  var CHAPS = +(q.get('chaps') || 0);      // 每本书几章，0 = 按原来那套随机
  var PARA = +(q.get('para') || 0);        // 每章几段，0 = 按原来那套随机

  var NAMES = ['三体', '活着', '百年孤独', '明朝那些事儿', '平凡的世界', '小王子',
               '围城', '白夜行', '解忧杂货店', '人类简史', '沉默的大多数', '许三观卖血记',
               '追风筝的人', '房思琪的初恋乐园', '红楼梦', '西游记', '茶馆', '边城',
               '老人与海', '月亮与六便士', '局外人', '鼠疫', '罪与罚', '卡拉马佐夫兄弟',
               '倾城之恋', '呼兰河传', '骆驼祥子', '四世同堂', '雷雨', '繁花'];
  var books = [];
  for (var i = 0; i < N; i++) {
    var chaps = CHAPS || 20 + (i * 7) % 60;
    var toc = [];
    /* ?tname=1：章名后面带上一个词（"第1章 风起"），用来验目录行
       统一成「第X章：章节名」时，标题里自带的"第X章"有没有被剥掉。 */
    var NAMED = q.get('tname') === '1';
    for (var c = 0; c < chaps; c++) {
      toc.push({
        t: '第' + (c + 1) + '章' + (NAMED ? ' ' + NAMES[(c + i) % NAMES.length] : ''),
        len: 2000 + (c * 131) % 1500
      });
    }
    books.push({
      id: 'b' + i,
      // ?long=1：给每本书加一长串后缀，用来试「书名放不下时会不会滚动」
      title: NAMES[i % NAMES.length] + (i >= NAMES.length ? ' ' + (1 + Math.floor(i / NAMES.length)) : '') +
             (q.get('long') === '1' ? '（精装典藏版 · 全本无删节 · 附番外与作者后记合集）' : ''),
      totalChars: toc.reduce(function (a, x) { return a + x.len; }, 0),
      encoding: 'utf-8',
      addedAt: Date.now() - i * 86400000,
      toc: toc
    });
  }

  // 上架：按格子顺序铺，跟「一键摆满」的规则一致
  var slots = {};
  var infos = Shelf.slotInfo();
  var k = 0, si = 0;
  while (k < Math.min(ON, N) && si < infos.length) {
    slots[infos[si].id] = [];
    var room = Math.min(infos[si].cap, Math.min(ON, N) - k);
    for (var j = 0; j < room; j++) slots[infos[si].id].push(books[k++].id);
    si++;
  }

  var progs = {};
  /* ?noread=1：一本都"没真读过"（index 和 scrollY 都是 0）—— 用来验
     「继续阅读」便签在没读过任何书时不显示、也不占位。 */
  var NO_READ = q.get('noread') === '1';
  books.forEach(function (b, i) {
    if (NO_READ) {
      progs[b.id] = { bookId: b.id, index: 0, scrollY: 0, updatedAt: Date.now() };
      return;
    }
    if (i % 3 === 0) {
      progs[b.id] = {
        bookId: b.id,
        index: Math.floor(b.toc.length * (0.2 + (i % 5) * 0.15)),
        scrollY: 0,
        updatedAt: Date.now()
      };
    }
  });

  function later(v) { return Promise.resolve(v); }

  window.DB = {
    // 真库里是 put（upsert），别写成 unshift 追加 —— 否则补序号那步会把书翻倍
    addBook: function (b) {
      var i = -1;
      for (var k = 0; k < books.length; k++) if (books[k].id === b.id) { i = k; break; }
      if (i >= 0) books[i] = Object.assign({}, books[i], b);
      else books.unshift(b);
      return later(true);
    },
    getBook: function (id) {
      return later(books.filter(function (x) { return x.id === id; })[0] || null);
    },
    listBooks: function () { return later(books.slice()); },
    delBook: function (id) {
      books = books.filter(function (x) { return x.id !== id; });
      Object.keys(slots).forEach(function (kk) {
        slots[kk] = slots[kk].filter(function (x) { return x !== id; });
      });
      return later(true);
    },
    putChapters: function () { return later(true); },
    getChapter: function (bookId, idx) {
      // ?para=N 造一章超长正文，用来试「一章几万段会不会卡死」
      var n = PARA || 60;
      var out = [];
      for (var i = 0; i < n; i++) {
        out.push('第 ' + (i + 1) + ' 段。这是一段占位正文，用来量渲染开销。'
          + '砚读把整本小说切成章节，读的时候只画当前这一章，'
          + '所以一章多大直接决定了打开这本书要多久。'.repeat(2));
      }
      return later(out.join('\n'));
    },
    setProgress: function (p) { progs[p.bookId] = p; return later(true); },
    getProgress: function (id) { return later(progs[id] || null); },
    /* 真库这个接口是批量读进度（一本一个事务太贵）。
       桩必须跟着有 —— 少了它 withProgress 会抛 TypeError，
       列表渲染静默失败，表现就是"列表一片空白"，很难查。 */
    allProgress: function () { return later(JSON.parse(JSON.stringify(progs))); },
    getSlots: function () { return later(JSON.parse(JSON.stringify(slots))); },
    setSlot: function (id, items) { slots[id] = items.slice(); return later(true); },
    unshelf: function (bid) {
      Object.keys(slots).forEach(function (kk) {
        slots[kk] = slots[kk].filter(function (x) { return x !== bid; });
      });
      return later(true);
    },
    clearSlots: function () { slots = {}; return later(true); },
    setSetting: function () { return later(true); },
    getSettings: function () { return later({}); }
  };

  /* ?legacy=1：把书脊还原成 2026-09-18 改版前的样子，用来出"改前"对照图。
     三件事是当时的实际状态：平涂（craft:false）、整架书同一个宽度（minW=maxW）、
     老的那套绿（含最深 #1F4A33 和最浅 #6A9E7C）。放在 stub 里是因为它在 app.js 之前跑，
     配置要在首次渲染前生效。 */
  if (q.get('legacy') === '1') {
    Shelf.configure({
      book: { craft: false, minW: 15.4, maxW: 15.4, lean: 0 },
      greens: ['#2E6B4A', '#3D7A57', '#245539', '#4E8A63', '#1F4A33', '#5C9470', '#376B52', '#6A9E7C']
    });
  }

  window.__SIM = { edit: q.get('edit') === '1', page: q.get('page') || 'shelf' };
})();
