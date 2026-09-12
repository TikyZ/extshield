'use strict';

/**
 * 纯 Node 的 zip 打包(零依赖,只用内置 zlib)。
 *
 * 为什么不再用 `python -m zipfile -c out.zip .`:
 *   `python -m` 会把**当前工作目录**插到 sys.path 最前面,而这个函数的 cwd 正是
 *   待打包的产物目录 —— 里面装的是用户上传的扩展文件。只要上传的文件夹里放一个
 *   `zipfile.py` / `os.py` / `ctypes.py`,就会被当成标准库模块优先导入并执行,
 *   等于「打包一个恶意扩展 = 在本机执行任意代码」(RCE)。
 *   顺带这一改也去掉了打 zip 对 Python 的依赖。
 *
 * 产物路径一律用 `/` 分隔、不带 `./` 前缀(Chrome 商店要求 manifest.json 在包根)。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** ZIP 用的 DOS 时间格式(秒只有 2 秒精度,年份从 1980 起算) */
function dosStamp(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/** 收集目录下所有文件,相对路径用 / 分隔 */
function collect(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel ? rel + '/' + name : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile()) out.push({ name: r, full, mtime: st.mtime });
    }
  })(dir, '');
  return out;
}

/**
 * 把 dir 打包成 zipPath。
 * @returns {{ entries: number, bytes: number }}
 */
function zipDir(dir, zipPath) {
  const files = collect(dir);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const raw = fs.readFileSync(f.full);
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 压不小就直接存(小文件压缩后可能更大)
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(f.name, 'utf8');
    const { time, date } = dosStamp(f.mtime);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    lh.writeUInt16LE(20, 4); // 解压所需版本
    lh.writeUInt16LE(0x0800, 6); // flag: 文件名是 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra 长度
    parts.push(lh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    cd.writeUInt16LE(20, 4); // 创建版本
    cd.writeUInt16LE(20, 6); // 解压所需版本
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // 注释
    cd.writeUInt16LE(0, 34); // 起始磁盘号
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(0, 38); // 外部属性
    cd.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // 中央目录结束签名
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  const buf = Buffer.concat([Buffer.concat(parts), cdBuf, eocd]);
  fs.writeFileSync(zipPath, buf);
  return { entries: files.length, bytes: buf.length };
}

module.exports = { zipDir, crc32 };
