/**
 * 数据层：IndexedDB
 *  Capacitor 下页面跑在 http(s)://localhost 源，IndexedDB 完全可用，
 *  所以整本书的正文可以直接存本地，容量不受 5MB 限制。
 *
 *  五个 store：
 *    books     { id, title, totalChars, encoding, addedAt, toc:[{t,len}] }
 *    chapters  { key: "bookId:index", bookId, index, text }
 *    progress  { bookId, index, scrollY, updatedAt }
 *    settings  { k, v }
 *    slots     { id, items:[bookId] }   ← 书架摆位：哪个格子里摆了哪几本
 *
 *  「书库」和「书架」是分开的：所有导入的书都在列表（书库）里，
 *  摆位单独存。从书架拿掉一本书只是解除摆位，书还在；从列表删除才是真删。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'yandu';
  var DB_VER = 2;
  var S = {
    BOOKS: 'books', CHAPTERS: 'chapters', PROGRESS: 'progress',
    SETTINGS: 'settings', SLOTS: 'slots'
  };

  var _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(S.BOOKS)) {
          db.createObjectStore(S.BOOKS, { keyPath: 'id' }).createIndex('addedAt', 'addedAt');
        }
        if (!db.objectStoreNames.contains(S.CHAPTERS)) {
          db.createObjectStore(S.CHAPTERS, { keyPath: 'key' }).createIndex('bookId', 'bookId');
        }
        if (!db.objectStoreNames.contains(S.PROGRESS)) {
          db.createObjectStore(S.PROGRESS, { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains(S.SETTINGS)) {
          db.createObjectStore(S.SETTINGS, { keyPath: 'k' });
        }
        if (!db.objectStoreNames.contains(S.SLOTS)) {
          db.createObjectStore(S.SLOTS, { keyPath: 'id' });
        }
      };
      req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function store(name, mode) {
    return open().then(function (db) { return db.transaction(name, mode).objectStore(name); });
  }

  function done(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var DB = {
    /* ---------- 书 ---------- */
    addBook: function (book) {
      return store(S.BOOKS, 'readwrite').then(function (st) { return done(st.put(book)); });
    },
    getBook: function (id) {
      return store(S.BOOKS, 'readonly').then(function (st) { return done(st.get(id)); });
    },
    listBooks: function () {
      return store(S.BOOKS, 'readonly').then(function (st) { return done(st.getAll()); })
        .then(function (list) {
          return (list || []).sort(function (a, b) { return b.addedAt - a.addedAt; });
        });
    },
    /* 真删一本书：正文、进度、书架上的摆位一起清掉 */
    delBook: function (id) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction([S.BOOKS, S.CHAPTERS, S.PROGRESS, S.SLOTS], 'readwrite');
          t.objectStore(S.BOOKS).delete(id);
          t.objectStore(S.PROGRESS).delete(id);
          var idx = t.objectStore(S.CHAPTERS).index('bookId');
          var cur = idx.openCursor(IDBKeyRange.only(id));
          cur.onsuccess = function (e) {
            var c = e.target.result;
            if (c) { c.delete(); c.continue(); }
          };
          // 摆位里如果有这本书，一并摘掉（不然格子里会留下一个空位）
          var sc = t.objectStore(S.SLOTS).openCursor();
          sc.onsuccess = function (e) {
            var c = e.target.result;
            if (!c) return;
            var arr = (c.value.items || []).filter(function (x) { return x !== id; });
            if (arr.length !== (c.value.items || []).length) {
              c.value.items = arr;
              c.update(c.value);
            }
            c.continue();
          };
          t.oncomplete = resolve;
          t.onerror = function () { reject(t.error); };
        });
      });
    },

    /* ---------- 章节 ---------- */
    putChapters: function (bookId, chapters) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(S.CHAPTERS, 'readwrite');
          var st = t.objectStore(S.CHAPTERS);
          for (var i = 0; i < chapters.length; i++) {
            st.put({
              key: bookId + ':' + i,
              bookId: bookId,
              index: i,
              text: chapters[i].text
            });
          }
          t.oncomplete = resolve;
          t.onerror = function () { reject(t.error); };
        });
      });
    },
    getChapter: function (bookId, index) {
      return store(S.CHAPTERS, 'readonly').then(function (st) {
        return done(st.get(bookId + ':' + index));
      }).then(function (r) { return r ? r.text : ''; });
    },

    /* ---------- 进度 ---------- */
    setProgress: function (p) {
      return store(S.PROGRESS, 'readwrite').then(function (st) { return done(st.put(p)); });
    },
    getProgress: function (bookId) {
      return store(S.PROGRESS, 'readonly').then(function (st) { return done(st.get(bookId)); });
    },
    /* 一次把所有书的进度读出来，返回 { bookId: 进度 }。
       ⚠️ 别再用 getProgress 一本一本地查：每查一次就开一个事务，
       书架/列表每渲染一次要开 N 个事务（40 本书 = 40 次），
       老机器上光是事务开销就能感觉到"卡一下"。 */
    allProgress: function () {
      return store(S.PROGRESS, 'readonly').then(function (st) { return done(st.getAll()); })
        .then(function (rows) {
          var o = {};
          (rows || []).forEach(function (r) { o[r.bookId] = r; });
          return o;
        });
    },

    /* ---------- 书架摆位 ---------- */
    /* 返回 { slotId: [bookId, ...] }，没摆过书的格子不会出现在结果里 */
    getSlots: function () {
      return store(S.SLOTS, 'readonly').then(function (st) { return done(st.getAll()); })
        .then(function (rows) {
          var o = {};
          (rows || []).forEach(function (r) { o[r.id] = r.items || []; });
          return o;
        });
    },
    setSlot: function (id, items) {
      return store(S.SLOTS, 'readwrite').then(function (st) {
        return done(st.put({ id: id, items: items || [] }));
      });
    },
    /* 把一本书从它所在的格子里摘下来（书本身不删） */
    unshelf: function (bookId) {
      return store(S.SLOTS, 'readwrite').then(function (st) {
        return new Promise(function (resolve, reject) {
          var cur = st.openCursor();
          cur.onsuccess = function (e) {
            var c = e.target.result;
            if (!c) { resolve(true); return; }   // 走完所有格子
            var arr = c.value.items || [];
            if (arr.indexOf(bookId) >= 0) {
              c.value.items = arr.filter(function (x) { return x !== bookId; });
              c.update(c.value);
            }
            c.continue();
          };
          cur.onerror = function () { reject(cur.error); };
        });
      });
    },
    /* 清空所有摆位 */
    clearSlots: function () {
      return store(S.SLOTS, 'readwrite').then(function (st) { return done(st.clear()); });
    },

    /* ---------- 设置 ---------- */
    setSetting: function (k, v) {
      return store(S.SETTINGS, 'readwrite').then(function (st) { return done(st.put({ k: k, v: v })); });
    },
    getSettings: function () {
      return store(S.SETTINGS, 'readonly').then(function (st) { return done(st.getAll()); })
        .then(function (rows) {
          var o = {};
          (rows || []).forEach(function (r) { o[r.k] = r.v; });
          return o;
        });
    }
  };

  global.DB = DB;
})(window);
