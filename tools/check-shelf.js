/**
 * 书架自检：不依赖浏览器，直接跑 Shelf.render 的产物做静态检查。
 *   node tools/check-shelf.js
 *
 * 查四件事：
 *   1. SVG 里有没有 NaN / undefined（配置写错时最常见）
 *   2. 每格的书数有没有超过容量
 *   3. 书有没有越出格子的可用范围（越界 = 穿模）
 *   4. 书底是不是正好坐在底板面上（悬空 / 陷进板里也算穿模）
 */
'use strict';
const path = require('path');

global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
require(path.join(__dirname, '..', 'www', 'js', 'shelf.js'));
const Shelf = global.Shelf;

function fakeEl() {
  let html = '';
  return {
    set innerHTML(v) { html = v; },
    get innerHTML() { return html; }
  };
}

const TITLES = ['雪中悍刀行', '庆余年', '斗罗大陆', '斗破苍穹', '凡人修仙传', '诛仙', '盗墓笔记',
  '鬼吹灯', '遮天', '完美世界', '莽荒纪', '飞剑问道', '一念永恒', '大主宰', '武动乾坤',
  '择天记', '将夜', '琅琊榜', '天龙八部', '射雕英雄传', '笑傲江湖', '倚天屠龙记',
  '神雕侠侣', '碧血剑', '书剑恩仇录', '鹿鼎记', '雪山飞狐', '连城诀', '侠客行', '白马啸西风',
  '鸳鸯刀', '越女剑', '大唐双龙传', '覆雨翻云', '破碎虚空', '寻秦记', '边荒传说', '星际浪子'];

function makeItems(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: 'b' + i, title: TITLES[i % TITLES.length] + (i >= TITLES.length ? i : ''), pct: (i * 7) % 100 });
  }
  return out;
}

const cfg = Shelf.getConfig();
const T = cfg.T;

function fitSlot(s) {
  let x0 = s.x, x1 = s.x + s.w, top = s.y, bottom = s.y + s.h;
  const coverOK = (a1, a2, b1, b2) => {
    const span = b2 - b1;
    const ov = Math.min(a2, b2) - Math.max(a1, b1);
    return ov >= Math.min(0.6 * span, Math.max(0, span - 6));
  };
  const nearH = e => {
    let best = null;
    cfg.H.forEach(h => {
      const hy = h[1], hx1 = Math.min(h[0], h[2]), hx2 = Math.max(h[0], h[2]);
      if (Math.abs(hy - e) > 10) return;
      if (!coverOK(hx1, hx2, x0, x1)) return;
      if (best === null || Math.abs(hy - e) < Math.abs(best - e)) best = hy;
    });
    return best;
  };
  const nearV = e => {
    let best = null;
    cfg.V.forEach(v => {
      const vx = v[0], vy1 = Math.min(v[1], v[2]), vy2 = Math.max(v[1], v[2]);
      if (Math.abs(vx - e) > 10) return;
      if (!coverOK(vy1, vy2, top, bottom)) return;
      if (best === null || Math.abs(vx - e) < Math.abs(best - e)) best = vx;
    });
    return best;
  };
  const hb = nearH(bottom); if (hb !== null) bottom = hb - T / 2;
  const ht = nearH(top); if (ht !== null) top = ht + T / 2;
  const vl = nearV(x0); if (vl !== null) x0 = vl + T / 2;
  const vr = nearV(x1); if (vr !== null) x1 = vr - T / 2;
  if (x1 - x0 < 12) { x0 = s.x; x1 = s.x + s.w; }
  if (bottom - top < 22) { top = s.y; bottom = s.y + s.h; }
  return { x0, x1, top, bottom };
}

let fail = 0;
function bad(msg) { fail++; console.log('  ✗ ' + msg); }

function run(label, n, filler, edit) {
  const items = makeItems(n);
  const layout = {};
  if (filler === 'fill') {
    // 按顺序塞满每一格
    let k = 0;
    Shelf.slotInfo().forEach(s => {
      layout[s.id] = [];
      for (let j = 0; j < s.cap && k < n; j++) layout[s.id].push(items[k++].id);
    });
  } else if (filler === 'over') {
    // 故意塞超：每格塞 cap+3 本，验证会不会溢出
    let k = 0;
    Shelf.slotInfo().forEach(s => {
      layout[s.id] = [];
      for (let j = 0; j < s.cap + 3 && k < n; j++) layout[s.id].push(items[k++].id);
    });
  }

  const el = fakeEl();
  const res = Shelf.render(el, { items, layout, edit: !!edit });
  const svg = el.innerHTML;

  console.log('\n[' + label + '] 书 ' + n + ' 本，架上 ' + res.placed + '，未上架 ' + res.unplaced +
    '，总容量 ' + res.capacity);

  // 1. NaN / undefined
  if (/NaN|undefined/.test(svg)) bad('SVG 里出现 NaN 或 undefined');

  // 2 + 3 + 4：逐本书查
  const fits = cfg.SLOTS.map(fitSlot);
  const caps = cfg.SLOTS.map((s, i) => Math.max(1, Math.floor((fits[i].x1 - fits[i].x0 - 3) / cfg.book.idealW)));
  const per = cfg.SLOTS.map(() => 0);

  const re = /<g class="bk"[^>]*data-book-id="([^"]*)"[^>]*data-slot="(\d+)"[^>]*>\s*<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/g;
  let m, count = 0;
  while ((m = re.exec(svg))) {
    count++;
    const si = +m[2];
    const x = +m[3], y = +m[4], w = +m[5], h = +m[6];
    per[si]++;
    const f = fits[si];
    // 越界 = 穿模
    if (x < f.x0 - 0.01) bad(m[1] + ' 左边越出格子 ' + x.toFixed(1) + ' < ' + f.x0.toFixed(1));
    if (x + w > f.x1 + 0.01) bad(m[1] + ' 右边越出格子 ' + (x + w).toFixed(1) + ' > ' + f.x1.toFixed(1));
    if (y < f.top - 0.01) bad(m[1] + ' 顶部穿出格子 ' + y.toFixed(1) + ' < ' + f.top.toFixed(1));
    // 书底必须坐在底板面上（允许 0.05 的浮点误差）
    if (Math.abs((y + h) - f.bottom) > 0.05) {
      bad(m[1] + ' 书底没坐在板上 ' + (y + h).toFixed(1) + ' vs ' + f.bottom.toFixed(1));
    }
  }
  // 2. 容量
  cfg.SLOTS.forEach((s, i) => {
    if (per[i] > caps[i]) bad(s.id + ' 超出容量 ' + per[i] + ' > ' + caps[i]);
  });

  console.log('  每格：' + cfg.SLOTS.map((s, i) => s.id + ' ' + per[i] + '/' + caps[i]).join('  '));
  if (count !== res.placed) bad('渲染出的书数 ' + count + ' 与统计 ' + res.placed + ' 不一致');
  return res;
}

console.log('=== 砚读书架自检 ===');
run('空书架', 0, 'none');
run('随便摆几本', 5, 'none');
run('编辑态', 5, 'none', true);
run('摆满', 40, 'fill');
run('超量塞入', 120, 'over');
run('书特别多', 200, 'fill');

console.log('\n' + (fail ? '✗ 有 ' + fail + ' 处问题' : '✓ 全部通过：无 NaN、无越界、无悬空'));
process.exit(fail ? 1 : 0);
