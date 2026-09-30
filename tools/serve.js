/**
 * 起一个本地静态服务器，把项目根目录挂到 http://127.0.0.1:<port>/。
 *
 * ⚠️ 为什么必须有它：CDP 直连 file:// 的时候 **IndexedDB 是不可用的**
 * （file 源没有存储权限），所以平时那套模拟器只能跑假数据桩，
 * 真机那条 IndexedDB 路径一直测不到。Capacitor 真机是从 http://localhost 加载的，
 * 用 http 跑才跟真机一致。
 *
 * 跑：node tools/serve.js [端口]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = +(process.argv[2] || 8899);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

http.createServer(function (req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/design/phone-real.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); return res.end('404 ' + p); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('服务已起： http://127.0.0.1:' + PORT + '/  （根：' + ROOT + '）');
});
