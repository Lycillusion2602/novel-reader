/**
 * 把 www/index.html 组装成 design/phone-sim.html（电脑上截图/验交互用）
 *
 * 为什么不是手抄一份：手抄的副本一定会跟真页面走样。
 * 这里直接拿真的 index.html，只做三件事：
 *   1. 加 html.native（模拟安卓 edge-to-edge，状态栏浮在内容上）
 *   2. 资源路径改成 ../www/...
 *   3. app.js 前后各插一个脚本：前面换掉 DB（假数据），后面装驱动（?edit / ?dbg / ?act）
 *
 * 跑：node tools/build-phone-sim.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'www', 'index.html');
const OUT = path.join(ROOT, 'design', 'phone-sim.html');

let html = fs.readFileSync(SRC, 'utf8');

html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" class="native">');
html = html.replace(/href="css\//g, 'href="../www/css/');
html = html.replace(/src="js\//g, 'src="../www/js/');
html = html.replace('<title>砚读 · 离线小说</title>', '<title>砚读 · 手机模拟</title>');

const anchor = '<script src="../www/js/app.js"></script>';
if (html.indexOf(anchor) < 0) {
  console.error('找不到 app.js 的 script 标签，index.html 结构变了？');
  process.exit(1);
}
/* ⚠️ 驱动脚本别外链。模拟器的 html 常常是从旧副本改出来的，或者被
   --dump-dom 的结果覆盖过一版；外链的 _sim-driver.js 更新了，
   页面里那段脚本却还是旧的 —— 表现就是"新加的动作测不出来"，
   排查半天才发现页面里根本没有那段代码。直接内联，永远一致。 */
const stub = fs.readFileSync(path.join(ROOT, 'design', '_sim-stub.js'), 'utf8')
  .replace(/<\/script>/gi, '<\\/script>');
const driver = fs.readFileSync(path.join(ROOT, 'design', '_sim-driver.js'), 'utf8')
  .replace(/<\/script>/gi, '<\\/script>');

html = html.replace(anchor,
  '<script>\n' + stub + '\n</script>\n' +
  '<script src="../www/js/app.js"></script>\n' +
  '<script>\n' + driver + '\n</script>');

fs.writeFileSync(OUT, html);
console.log('已生成 ' + path.relative(ROOT, OUT) + '（' + html.length + ' 字节）');
