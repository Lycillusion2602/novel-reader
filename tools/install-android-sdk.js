/**
 * Android SDK 静默安装脚本（Windows）
 * 只装打 APK 必需的最小集：platform-tools / platforms;android-35 / build-tools;35.0.0
 * 不装模拟器、NDK、源码，控制体积。
 *
 * 用法：node install-android-sdk.js
 * 日志：D:\Android\install.log
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const cp = require('child_process');

const SDK_ROOT = 'D:\\Android\\Sdk';
const WORK = 'D:\\Android';
const ZIP = path.join(WORK, 'cmdline-tools.zip');
const LOG = path.join(WORK, 'install.log');

const lines = [];
function L(s) {
  const t = '[' + new Date().toTimeString().slice(0, 8) + '] ' + s;
  lines.push(t);
  console.log(t);
  try { fs.writeFileSync(LOG, lines.join('\n'), 'utf8'); } catch (e) {}
}

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function httpsGet(url, cb, depth) {
  depth = depth || 0;
  https.get(url, { timeout: 30000 }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
      res.resume();
      return httpsGet(res.headers.location, cb, depth + 1);
    }
    cb(res);
  }).on('error', e => L('  !! request error: ' + e.message));
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    L('downloading: ' + url);
    httpsGet(url, res => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const f = fs.createWriteStream(dest);
      res.on('data', c => {
        got += c.length;
        if (total && got % (5 * 1024 * 1024) < c.length) {
          L('  ' + (got / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB');
        }
      });
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve(dest)));
      f.on('error', reject);
    });
  });
}

function findCmdlineToolsUrl() {
  return new Promise((resolve, reject) => {
    const xml = 'https://dl.google.com/android/repository/repository2-3.xml';
    L('querying latest commandlinetools version...');
    httpsGet(xml, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        const m = body.match(/commandlinetools-win-\d+_latest\.zip/g) || [];
        if (!m.length) { reject(new Error('no commandlinetools found in xml')); return; }
        const uniq = Array.from(new Set(m));
        const pick = uniq.sort((a, b) => {
          const na = parseInt(a.match(/-win-(\d+)_/)[1], 10);
          const nb = parseInt(b.match(/-win-(\d+)_/)[1], 10);
          return nb - na;
        })[0];
        L('  picked: ' + pick);
        resolve('https://dl.google.com/android/repository/' + pick);
      });
    });
  });
}

/**
 * 新版 cmdline-tools (>=16111833) 已弃用 sdkmanager，改用 bin/android.exe：
 *   android sdk install <pkg> <pkg> --sdk=<路径>
 * android.exe 是原生 exe，直接走 argv，参数里的分号不会被 cmd.exe 吃掉。
 * 之前用 cmd /c sdkmanager.bat 时，"platforms;android-35" 里的分号被当成
 * 批处理参数分隔符，导致 Package not found，就是这个原因。
 */
function runAndroidCli(args, label) {
  return new Promise((resolve, reject) => {
    const exe = path.join(SDK_ROOT, 'cmdline-tools', 'latest', 'bin', 'android.exe');
    if (!fs.existsSync(exe)) { reject(new Error('android.exe not found: ' + exe)); return; }
    L('== ' + label + ' ==');
    L('  args: ' + args.join(' '));
    const env = Object.assign({}, process.env, {
      ANDROID_HOME: SDK_ROOT,
      ANDROID_SDK_ROOT: SDK_ROOT,
      JAVA_HOME: process.env.JAVA_HOME || 'C:\\Program Files\\Java\\jdk-21'
    });
    const p = cp.spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env, cwd: SDK_ROOT });
    const iv = setInterval(() => { try { p.stdin.write('y\r\n'); } catch (e) {} }, 400);
    const onData = d => {
      d.toString().split('\n').forEach(x => {
        const t = x.replace(/\r/g, '').trim();
        // 过滤下载/解压进度条，否则日志会炸
        if (!t || t.length > 200 || /https?:\/\/|Unzipping|^\d+%$/.test(t)) return;
        L('  ' + t);
      });
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', e => { clearInterval(iv); reject(e); });
    p.on('close', code => {
      clearInterval(iv);
      try { p.stdin.end(); } catch (e) {}
      L('  exit code: ' + code);
      resolve(code);
    });
  });
}

(async function main() {
  try {
    mkdirp(WORK);
    mkdirp(SDK_ROOT);

    const latestDir = path.join(SDK_ROOT, 'cmdline-tools', 'latest');
    if (!fs.existsSync(path.join(latestDir, 'bin', 'sdkmanager.bat'))) {
      const url = await findCmdlineToolsUrl();
      await download(url, ZIP);
      L('extracting...');
      const stage = path.join(WORK, '_stage');
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      mkdirp(stage);
      const tar = 'C:\\Windows\\System32\\tar.exe';
      cp.execSync('"' + tar + '" -xf "' + ZIP + '" -C "' + stage + '"', { stdio: 'pipe' });
      const inner = path.join(stage, 'cmdline-tools');
      if (!fs.existsSync(inner)) throw new Error('unexpected zip layout');
      mkdirp(path.join(SDK_ROOT, 'cmdline-tools'));
      if (fs.existsSync(latestDir)) fs.rmSync(latestDir, { recursive: true, force: true });
      fs.renameSync(inner, latestDir);
      fs.rmSync(stage, { recursive: true, force: true });
      try { fs.unlinkSync(ZIP); } catch (e) {}
      L('cmdline-tools ready: ' + latestDir);
    } else {
      L('cmdline-tools already present, skip download');
    }

    await runAndroidCli([
      'sdk', 'install',
      '--sdk=' + SDK_ROOT,
      'platform-tools',
      'platforms;android-35',
      'build-tools;35.0.0'
    ], 'install packages');

    L('');
    L('DONE. SDK_ROOT=' + SDK_ROOT);
    L('Remember to set: ANDROID_HOME=' + SDK_ROOT + '  ANDROID_SDK_ROOT=' + SDK_ROOT);
  } catch (e) {
    L('FAILED: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
})();
