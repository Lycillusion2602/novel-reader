/**
 * 用 CDP 真跑一次模拟器页面，把 <pre id="ACTOUT">（或指定 id）里的内容打出来。
 *
 *   node tools/cdp-run.js "file:///D:/.../phone-sim.html?act=autonext&chaps=3" [等待ms] [preId]
 *
 * 为什么要这个：msedge --dump-dom 配 --virtual-time-budget 时，
 * 虚拟时间会把 setTimeout 全压缩掉，但 **requestAnimationFrame 几乎不推进**
 * （实测整个测试只跑了 2~3 帧）。滚动回调、renderChapter 里那些放 rAF 里的活
 * 就永远不会执行 —— 测出来"功能没生效"，其实是测量工具没让它生效。
 * 这里走 CDP + 真实等待，帧才会真的跑。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
/* 端口可以换：上一个调试用的 Edge 没退干净时会顶着 9333，
   那时候 waitPort 会连到那个旧实例上，然后一路卡住。 */
const PORT = +(process.env.CDP_PORT || 9333);

const target = process.argv[2];
const WAIT = +(process.argv[3] || 12000);
const PRE = process.argv[4] || 'ACTOUT';
// 第 5 个参数：一段 JS 文件的路径。页面加载后等 2s 注入执行，把返回值 JSON 打出来。
// 用来临时量一些驱动脚本里没写的量（元素几何、内部状态），不用改 _sim-driver.js。
const EVALF = process.argv[5] || '';
if (!target) { console.error('用法：node tools/cdp-run.js <url> [等待ms] [preId] [evalFile]'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ydcdp-'));
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--window-size=412,915',
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJSON(p) {
  return new Promise((res, rej) => {
    require('http').get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => res(JSON.parse(s)));
    }).on('error', rej);
  });
}

async function waitPort() {
  for (let i = 0; i < 100; i++) {
    try { return await getJSON('/json/version'); } catch (e) { await sleep(200); }
  }
  throw new Error('Edge 调试端口没起来');
}

class Conn {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map(); this.logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => { this.map.set(id, res); this.ws.send(JSON.stringify(msg)); });
  }
}

(async function main() {
  let out = '', extra = '';
  try {
    const ver = await waitPort();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    const c = new Conn(ws);

    const { result: { targetId } } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Page.enable', {}, sessionId);
    await c.send('Runtime.enable', {}, sessionId);
    const errs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sessionId) {
        const d = m.params && m.params.exceptionDetails;
        errs.push((d && (d.text + ' ' + (d.exception && d.exception.description || ''))) || 'unknown');
      }
    });

    await c.send('Page.navigate', { url: target }, sessionId);
    await sleep(WAIT);

    if (EVALF) {
      await sleep(2000);
      const code = fs.readFileSync(EVALF, 'utf8');
      const r2 = await c.send('Runtime.evaluate', {
        expression: '(function(){' + code + '\n})()',
        returnByValue: true, awaitPromise: true
      }, sessionId);
      if (r2.result && r2.result.exceptionDetails) {
        extra += '\n注入脚本报错：' + (r2.result.exceptionDetails.exception && r2.result.exceptionDetails.description || r2.result.exceptionDetails.text);
      } else {
        extra += '\nINJECT' + JSON.stringify(r2.result && r2.result.result && r2.result.result.value, null, 1) + 'INJECTEND';
      }
    }

    if (process.env.SHOT) {
      const sr = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      if (sr.result && sr.result.data) {
        fs.writeFileSync(process.env.SHOT, Buffer.from(sr.result.data, 'base64'));
        extra += '\n已截图 ' + process.env.SHOT;
      }
    }
    const r = await c.send('Runtime.evaluate', {
      expression: '(document.getElementById(' + JSON.stringify(PRE) + ')||{}).textContent||"__EMPTY__"',
      returnByValue: true
    }, sessionId);
    out = (r.result && r.result.result && r.result.result.value) || '__NO_RESULT__';
    if (errs.length) out += '\n页面异常：' + errs.join(' | ');
    ws.close();
  } catch (e) {
    out = 'ERROR: ' + (e && e.message || e);
  }
  console.log(out + extra);
  edge.kill();
  process.exit(0);
})();
