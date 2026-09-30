/**
 * 零依赖 zip 解压（Node 内置 zlib）
 *
 * 为什么不用现成工具：
 *  - Windows 的 tar.exe 解压 60MB 的 SDK 包会卡死
 *  - PowerShell Expand-Archive 从工具调用会被打断
 *  - 新版 android.exe 的解压有 bug，只解出 data/res 就报成功
 *
 * 用法：node unzip.js <zip路径> <输出目录>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function findEOCD(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function unzip(zipPath, outDir) {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 zip 文件');

  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name: name, method: method, compSize: compSize, localOff: localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  console.log('zip 条目数: ' + entries.length);

  let files = 0, dirs = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const target = path.join(outDir, e.name);

    if (e.name.charAt(e.name.length - 1) === '/') {
      fs.mkdirSync(target, { recursive: true });
      dirs++;
      continue;
    }

    if (buf.readUInt32LE(e.localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(e.localOff + 26);
    const lExtraLen = buf.readUInt16LE(e.localOff + 28);
    const start = e.localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + e.compSize);

    let data;
    try {
      data = e.method === 8 ? zlib.inflateRawSync(raw) : raw;
    } catch (err) {
      console.log('  跳过(解压失败): ' + e.name);
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files++;
    if (files % 1000 === 0) console.log('  ...' + files + ' files');
  }

  console.log('完成：' + files + ' 个文件，' + dirs + ' 个目录');
  return files;
}

const zip = process.argv[2];
const out = process.argv[3];
if (!zip || !out) {
  console.log('用法：node unzip.js <zip路径> <输出目录>');
  process.exit(1);
}
const t = Date.now();
unzip(zip, out);
console.log('耗时 ' + ((Date.now() - t) / 1000).toFixed(1) + 's');
