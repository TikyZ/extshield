'use strict';

/**
 * 抹掉 wasm 的「函数导出名」—— 改成无意义的短名(f0 / f1 / ...)。
 *
 * 为什么需要:
 *   下沉后的 wasm 里仍然写着 `(export "normalizeUrl" ...)`。函数体虽然变成了
 *   字节码,但**名字没变** —— 等于给逆向的人留了一套路标:不用读代码就知道哪个
 *   函数最值钱,直接锁定目标。实测(binaryen 反汇编产物)确认真实存在:
 *   导出名、常量、循环分支全都一读即得,所以「名字」这一层要主动拿掉。
 *
 * 只做一件事:重写 export 段的函数导出名,其余逐字节不动。
 *   - 只改 kind=0x00(函数)。`memory` / `table` / `global` 必须原样保留,
 *     手动下沉的运行时靠 `X.memory.buffer` 取内存,改名就崩。
 *   - `__` 开头的导出也全部保留:手动下沉带 --exportRuntime,运行时(lo/li)要调
 *     `X.__new` / `X.__collect`,这些名字是接口,不能动。
 *   - 万一产物里带了 name 调试段(custom section "name"),直接丢掉 —— 那是
 *     纯调试信息,里面会带原始函数名,留着等于白改名。
 *
 * 注意:名字用 `f0/f1/...`,刻意**不用** `_0x...` 那种风格 —— 那看着像混淆,
 * 既可能踩 Chrome 审核的观感红线,也会被本工具自己的 verify 规则命中。
 *
 * (顺带说明:这一步只是拿掉"路标",不改变"wasm 可被反汇编"这个事实。
 *  对外不要说它是加密,它提高的是阅读成本,不是不可逆。)
 */

const fs = require('fs');

/** 这些导出名是运行时接口,一律保留 */
const KEEP = new Set(['memory', 'table', 'global']);

function isProtected(name) {
  return KEEP.has(name) || name.indexOf('__') === 0;
}

/** 读一个 unsigned LEB128,返回 [值, 下一个位置] */
function readU32(buf, i) {
  let r = 0;
  let shift = 0;
  let b;
  do {
    if (i >= buf.length) throw new Error('wasm 字节不足(LEB128 越界)');
    b = buf[i++];
    r |= (b & 0x7f) << shift;
    shift += 7;
    if (shift > 35) throw new Error('wasm LEB128 过长,疑似文件损坏');
  } while (b & 0x80);
  return [r >>> 0, i];
}

/** 写一个 unsigned LEB128 */
function writeU32(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** 解析 export 段 payload -> [{name:Buffer, kind, idxRaw:Buffer}] */
function parseExports(payload) {
  const [count, start] = readU32(payload, 0);
  let i = start;
  const list = [];
  for (let k = 0; k < count; k++) {
    const [len, a] = readU32(payload, i);
    const name = payload.slice(a, a + len);
    let j = a + len;
    const kind = payload[j++];
    // 后面的索引(函数下标 / 内存下标)原样保留字节,不重新编码 —— 避免改动编码方式
    const [, b] = readU32(payload, j);
    list.push({ name, kind, idxRaw: payload.slice(j, b) });
    i = b;
  }
  if (i !== payload.length) throw new Error('export 段解析后仍有剩余字节,拒绝改写');
  return list;
}

/**
 * 把 wasm 里所有「函数导出」改名成短名。
 * @param {string} wasmPath 就地改写
 * @param {{prefix?: string, quiet?: boolean}} [opts]
 * @returns {{map: Map<string,string>, renamed: number, droppedNameSection: boolean}}
 */
function renameFunctionExports(wasmPath, opts = {}) {
  const prefix = opts.prefix || 'f';
  const buf = fs.readFileSync(wasmPath);

  if (buf.length < 8 || buf.slice(0, 4).toString('hex') !== '0061736d') {
    throw new Error('不是合法的 wasm 文件(魔数不对):' + wasmPath);
  }

  const pieces = [buf.slice(0, 8)];
  const map = new Map();
  let renamed = 0;
  let droppedNameSection = false;
  let touched = false;
  let i = 8;

  while (i < buf.length) {
    const id = buf[i];
    const [size, payloadStart] = readU32(buf, i + 1);
    const payloadEnd = payloadStart + size;
    if (payloadEnd > buf.length) throw new Error('wasm 段长度越界,拒绝改写');
    const payload = buf.slice(payloadStart, payloadEnd);
    const headerLen = payloadStart - i; // id + 长度字段本身

    // name 调试段:丢掉(里面会带原始函数名)
    if (id === 0 && payload.length > 1) {
      const [nlen, k] = readU32(payload, 0);
      if (payload.slice(k, k + nlen).toString('utf8') === 'name') {
        droppedNameSection = true;
        touched = true;
        i = payloadEnd;
        continue;
      }
    }

    if (id !== 7) {
      pieces.push(buf.slice(i, payloadEnd));
      i = payloadEnd;
      continue;
    }

    // export 段:只改函数导出名
    const list = parseExports(payload);
    const taken = new Set();
    for (const e of list) {
      if (e.kind !== 0 || isProtected(e.name.toString('utf8'))) {
        taken.add(e.name.toString('utf8'));
      }
    }
    let counter = 0;
    const built = [];
    for (const e of list) {
      const orig = e.name.toString('utf8');
      if (e.kind !== 0 || isProtected(orig)) {
        built.push(Buffer.concat([writeU32(e.name.length), e.name, Buffer.from([e.kind]), e.idxRaw]));
        continue;
      }
      let short;
      do {
        short = prefix + counter++;
      } while (taken.has(short));
      taken.add(short);
      map.set(orig, short);
      renamed++;
      const nb = Buffer.from(short, 'utf8');
      built.push(Buffer.concat([writeU32(nb.length), nb, Buffer.from([e.kind]), e.idxRaw]));
    }

    const newPayload = Buffer.concat([writeU32(list.length)].concat(built));
    pieces.push(Buffer.from([id]), writeU32(newPayload.length), newPayload);
    touched = true;
    i = payloadEnd;
  }

  if (touched) fs.writeFileSync(wasmPath, Buffer.concat(pieces));
  if (renamed && !opts.quiet) {
    console.log(`[wasm] 已抹掉 ${renamed} 个导出名(函数名不再出现在 wasm 里)`);
  }
  return { map, renamed, droppedNameSection };
}

module.exports = { renameFunctionExports, isProtected };
