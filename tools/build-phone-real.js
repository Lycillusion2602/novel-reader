/**
 * 组装 design/phone-real.html：**不注入假数据桩**，用真的 www/js/db.js（IndexedDB）
 * 跑一遍导入 + 打开。用来抓"模拟器全绿、真机打不开"这类只在真数据路径上出现的 bug。
 *
 * 跑：node tools/build-phone-real.js  然后  node tools/cdp-run.js "file:///.../phone-real.html?act=real"
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'www', 'index.html');
const OUT = path.join(ROOT, 'design', 'phone-real.html');

let html = fs.readFileSync(SRC, 'utf8');
html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" class="native">');
html = html.replace(/href="css\//g, 'href="../www/css/');
html = html.replace(/src="js\//g, 'src="../www/js/');
html = html.replace('<title>砚读 · 离线小说</title>', '<title>砚读 · 真库冒烟</title>');

const anchor = '<script src="../www/js/app.js"></script>';
if (html.indexOf(anchor) < 0) {
  console.error('找不到 app.js 的 script 标签');
  process.exit(1);
}
const driver = fs.readFileSync(path.join(ROOT, 'design', '_real-driver.js'), 'utf8')
  .replace(/<\/script>/gi, '<\\/script>');

html = html.replace(anchor, anchor + '\n<script>\n' + driver + '\n</script>');
fs.writeFileSync(OUT, html);
console.log('已生成 ' + path.relative(ROOT, OUT) + '（' + html.length + ' 字节，无假数据桩）');
