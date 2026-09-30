/**
 * 解析器：编码探测 + 章节切分
 *
 * 中文 txt 两大坑：
 *  1. 编码：网上的小说绝大多数是 GBK，按 UTF-8 读会变成「锟斤拷」。
 *     策略：BOM → 严格 UTF-8 → GBK → 容错 UTF-8，并对乱码比例做校验。
 *  2. 分章：3MB 的整本一次性塞进 DOM 会让手机卡死，必须切成章节按需渲染。
 *     策略：正则识别章回标题，识别不出就按字数硬切。
 */
(function (global) {
  'use strict';

  /* 章回标题的几种常见写法。
     分章难的不是「认出某一行是标题」，而是「别把不相干的行当成标题」——
     所以这里**按族投票**：先统计每一族写法各命中多少行，只认命中最多
     并且序号基本递增的那一族。以前是把所有正则取并集，正文里随便一个
     "1. 他愣住了" 都会被当成章，目录自然很乱。 */
  var FAMILIES = [
    { id: 'cn',  min: 2, re: /^第[ \t　]*[0-9零一二三四五六七八九十百千万两]{1,12}[ \t　]*[章节回卷篇集部折幕]/ },
    { id: 'vol', min: 2, re: /^卷[ \t　]*[0-9零一二三四五六七八九十百千万]{1,8}/ },
    { id: 'num', min: 2, re: /^第?[ \t]*[0-9]{1,4}[ \t]*[章节回]/ },
    // "1. 标题" 这种最容易被正文里的编号误伤，门槛抬高、而且要靠序号递增才能赢
    { id: 'dot', min: 6, re: /^[0-9]{1,4}[ \t]*[.．、,，:：\-–—]/ },
    { id: 'en',  min: 2, re: /^(chapter|part|vol\.?)[ \t]*[0-9ivxIVX]{1,7}\b/i }
  ];

  /* 不带序号的特殊章节名，这几个人工看不会认错，任何族获胜时都额外接受 */
  var WORD_RE = /^(序章|序言|自序|楔子|引子|引言|开篇|尾声|终章|后记|番外|内容简介|简介)/;

  /* 标题最长认到这么多字。再长基本就是正文里的一句，不是标题 */
  var TITLE_MAX = 30;
  var WORD_MAX = 20;

  /* 单章上限。超过就再切小节 —— 见 splitChapters 里的说明。 */
  var MAX_CHAPTER = 8000;
  var PART = 3000;
  var MIN_CHAPTER = 60;      // 短于这个字的章节并回上一章（多半是被误认的孤行）

  /* 中文数字 → 阿拉伯数字。认不全就返回 NaN，参与不了递增校验而已，不影响分章。
     ⚠️ 按"节"累加，别把进位直接乘在上一段的结果上：
        「一千二百」上一版算成 1000 × 100 = 100000 —— 读到「百」的时候 cur 已经是 1000，
        `(cur || 1) * 100` 把整段又乘了一遍。它只影响族打分（序号递增校验），
        不影响切不切得开，所以一直没露馅，但 1000 章以上的书打分就是错的。 */
  var CN_DIGIT = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 };
  function cn2num(s) {
    if (!s) return NaN;
    var m = s.match(/[0-9]+/);
    if (m) return parseInt(m[0], 10);
    var seg = s.match(/[零一二三四五六七八九十百千万两]+/);
    if (!seg) return NaN;
    var t = seg[0], total = 0, section = 0, digit = 0, i, c;
    for (i = 0; i < t.length; i++) {
      c = t.charAt(i);
      if (c === '十' || c === '百' || c === '千') {
        section += (digit || 1) * (c === '十' ? 10 : (c === '百' ? 100 : 1000));
        digit = 0;
      } else if (c === '万') {
        total += (section + digit) * 10000;
        section = 0; digit = 0;
      } else {
        digit = CN_DIGIT[c];
        if (digit === undefined) return NaN;
      }
    }
    return total + section + digit;
  }

  /* 序号递增的比例。真目录的序号是递增的，误伤的行序号是乱的 —— 用它给候选族打分 */
  function monoRatio(nums) {
    var ok = 0, tot = 0;
    for (var i = 1; i < nums.length; i++) {
      if (isNaN(nums[i]) || isNaN(nums[i - 1])) continue;
      tot++;
      if (nums[i] >= nums[i - 1]) ok++;
    }
    return tot ? ok / tot : 0.6;
  }

  /* 挑出"这一本书用的是哪种章回写法"
     ⚠️ 别再加"首字符预筛"了：试过（/^[第卷0-9CcPpVv]/ 先挡一道），
     实测反而更慢 —— V8 对 ^ 锚定的正则失败得极快，多跑一道预筛纯属白跑一趟。 */
  function pickFamily(lines) {
    var hits = {};
    FAMILIES.forEach(function (f) { hits[f.id] = []; });

    for (var i = 0; i < lines.length; i++) {
      var t = String(lines[i]).trim();
      if (!t || t.length > TITLE_MAX) continue;
      for (var k = 0; k < FAMILIES.length; k++) {
        if (FAMILIES[k].re.test(t)) { hits[FAMILIES[k].id].push(cn2num(t)); break; }
      }
    }

    var best = null;
    FAMILIES.forEach(function (f) {
      var h = hits[f.id];
      if (h.length < f.min) return;
      var mr = monoRatio(h);
      /* ⚠️ 「1. 2. 3.」这一族上面注释就写了"要靠序号递增才能赢"，
         但实现里递增只是**打折**，从不淘汰 —— 一本「第X章」结构很清楚、
         正文里又爱用编号列点的书，实测 dot 命中 32 条、递增比例 0.77，
         打完分 27 分，反而把 cn 那 8 分挤掉了：
         目录最后被搅成「前言 / 1. 正文里的一条编号」两条。
         所以这一族要过一道硬闸：序号不是几乎一路往前的，就不认。
         （真按 1. 2. 3. 排章节的书递增比例是 1.0，不受影响。） */
      if (f.id === 'dot' && mr < 0.9) return;
      var score = h.length * (0.35 + 0.65 * mr);
      if (!best || score > best.score) best = { fam: f, score: score };
    });
    return best && best.score >= 2 ? best.fam : null;
  }

  function badRatio(s) {
    var n = 0;
    var total = Math.min(s.length, 20000);
    for (var i = 0; i < total; i++) {
      var c = s.charCodeAt(i);
      if (c === 0xFFFD || (c > 0x80 && c < 0xA0)) n++;
    }
    return total ? n / total : 1;
  }

  function decodeBuffer(buf) {
    var u8 = new Uint8Array(buf);

    if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
      return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'UTF-8(BOM)' };
    }
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
      return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'UTF-16LE' };
    }
    if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
      return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'UTF-16BE' };
    }

    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'UTF-8' };
    } catch (e) { /* 不是合法 UTF-8，继续 */ }

    try {
      var gbk = new TextDecoder('gbk').decode(u8);
      if (badRatio(gbk) < 0.02) return { text: gbk, encoding: 'GBK' };
    } catch (e) { /* 浏览器不支持 gbk，继续 */ }

    return { text: new TextDecoder('utf-8').decode(u8), encoding: 'UTF-8(容错)' };
  }

  function hardSplit(text, size) {
    var paras = text.split(/\r\n|\r|\n/);
    var pieces = [];
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i].trim();
      if (!p) continue;
      /* 一行本身就超过一节：有些 txt 整本几乎没有换行，
         只按段落切的话"一节"就是整本，一样会卡死。先按字数把它切断。 */
      if (p.length > size) {
        for (var o = 0; o < p.length; o += size) pieces.push(p.slice(o, o + size));
      } else {
        pieces.push(p);
      }
    }

    var out = [], buf = [], len = 0, n = 1;
    function flush() {
      if (!buf.length) return;
      out.push({ title: '第 ' + (n++) + ' 部分', text: buf.join('\n') });
      buf = []; len = 0;
    }
    for (var k = 0; k < pieces.length; k++) {
      buf.push(pieces[k]);
      len += pieces[k].length;
      if (len >= size) flush();
    }
    flush();
    return out;
  }

  function splitChapters(text) {
    var lines = text.split(/\r\n|\r|\n/);
    var fam = pickFamily(lines);

    // 认不出这一本书用的是哪种写法 → 按字数硬切，避免整本一次性渲染卡死
    if (!fam) return hardSplit(text, PART);

    var raw = [];
    /* len 是"这一章目前攒了多少字"。用它判断这一章是不是空的，
       别再 lines.join('') —— 那是每遇一个标题就把整章拼成一个大字符串，
       几十万字的书光临时字符串就够 GC 喝一壶。 */
    var cur = { title: '前言', lines: [], len: 0 };

    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      var isTitle = t && (
        (t.length <= TITLE_MAX && fam.re.test(t)) ||
        (t.length <= WORD_MAX && WORD_RE.test(t))
      );
      if (isTitle) {
        // 连续两行同名（有的书标题排了两遍）别切成两个章，接回上一个
        if (raw.length && raw[raw.length - 1].title === t) {
          cur = raw.pop();
          continue;
        }
        if (cur.len) raw.push(cur);
        cur = { title: t, lines: [], len: 0 };
      } else {
        cur.lines.push(lines[i]);
        cur.len += lines[i].length;
      }
    }
    if (cur.len) raw.push(cur);

    if (raw.length <= 1) return hardSplit(text, PART);

    var chapters = raw.map(function (c) {
      return {
        title: c.title,
        text: c.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
      };
    }).filter(function (c) { return c.text.length > 0; });

    /* 过短的章并回上一章。多半是正文里某一行碰巧长得像标题（比如"第三章"三个字
       出现在正文里），留着就成了一条只有一句的目录项，看着就是"分得很乱"。 */
    var merged = [];
    chapters.forEach(function (c) {
      if (merged.length && c.text.length < MIN_CHAPTER) {
        var p = merged[merged.length - 1];
        p.text = p.text + '\n' + c.text;
      } else {
        merged.push(c);
      }
    });
    chapters = merged;
    if (chapters.length <= 1) return hardSplit(text, PART);

    /* ⚠️ 关键一步：单章太大就再切成小节。
       网文合集常见只有「第一卷」这种一两个标题，中间夹着几十万字 ——
       那样"一章"就是整本，读的时候会一次往 DOM 里塞几万个 <p>，
       手机排版线程直接瘫掉，表现就是「点进去就卡死、什么都点不动」。
       切完之后单章上限 3000 字左右，渲染开销恒定。 */
    var out = [];
    chapters.forEach(function (c) {
      if (c.text.length <= MAX_CHAPTER) { out.push(c); return; }
      var parts = hardSplit(c.text, PART);
      if (parts.length <= 1) { out.push(c); return; }
      parts.forEach(function (p, i) {
        out.push({ title: c.title + ' · ' + (i + 1), text: p.text });
      });
    });
    return out;
  }

  /* 数"有效字数"（去掉空白）。
     ⚠️ 试过改成 charCodeAt 循环"省掉一份临时字符串"，实测比 replace 慢 ——
     replace 在引擎里是 C++ 实现的，手写 JS 循环追不上。别再改回去了。 */
  function countChars(s) {
    return s.replace(/\s/g, '').length;
  }

  global.Parser = {
    decodeBuffer: decodeBuffer,
    splitChapters: splitChapters,
    countChars: countChars
  };
})(window);
