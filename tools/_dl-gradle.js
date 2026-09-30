/**
 * 把 gradle 分发包抓到本地 wrapper 缓存里。
 * 起因：android/gradle/wrapper/gradle-wrapper.properties 里 networkTimeout=10000，
 * 从 services.gradle.org 下 250MB 十秒必断，gradlew 就永远起不来。
 * 这个脚本不带超时地把它下完，之后 ./gradlew 就能直接用了。
 * 只做下载 + 落盘，不解压（wrapper 自己会解）。
 *
 * 源用腾讯云镜像：直连 services.gradle.org 会在 20 秒左右被 ECONNRESET 断掉，
 * 实测 mirrors.cloud.tencent.com/gradle/ 能跑满。 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

var SRC = 'https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-all.zip';
/* ⚠️ 目标路径别写死 C:/Users/<某个人>/.gradle —— 这脚本别人也要能跑。
   wrapper 的缓存规矩是 ~/.gradle/wrapper/dists/<distributionName>-all/<由 distributionUrl 算出的哈希>/，
   那串哈希目录名各台机器一样（同一个 URL 就算出同一个），所以先探一下现有目录，
   探不到就用本机已知的这一个，并把目录建出来。 */
var BASE = path.join(os.homedir(), '.gradle', 'wrapper', 'dists', 'gradle-8.14.3-all');
var HASH = '10utluxaxniiv4wxiphsi49nj';
try {
  var found = fs.readdirSync(BASE).filter(function (d) { return d.length >= 20; });
  if (found.length) HASH = found[0];
} catch (e) { /* 还没建过缓存，用默认那个哈希名 */ }
fs.mkdirSync(path.join(BASE, HASH), { recursive: true });
var DEST = path.join(BASE, HASH, 'gradle-8.14.3-all.zip');

function get(u, depth) {
  if (depth > 5) return Promise.reject(new Error('重定向太多'));
  return new Promise(function (res, rej) {
    https.get(u, function (r) {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return get(new global.URL(r.headers.location, u).href, depth + 1).then(res, rej);
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      var tmp = DEST + '.part';
      var out = fs.createWriteStream(tmp);
      var n = 0, t0 = Date.now();
      r.on('data', function (c) {
        n += c.length;
        if (n % (25 * 1024 * 1024) < c.length) {
          console.log('  ' + (n / 1048576 | 0) + ' MB · ' + ((Date.now() - t0) / 1000 | 0) + 's');
        }
      });
      r.on('error', rej);
      out.on('finish', function () { out.end(); fs.renameSync(tmp, DEST); res(n); });
      r.pipe(out);
    }).on('error', rej);
  });
}

get(SRC, 0).then(function (n) {
  console.log('完成 ' + (n / 1048576 | 0) + ' MB → ' + DEST);
}).catch(function (e) {
  console.log('失败：' + e.message);
});
