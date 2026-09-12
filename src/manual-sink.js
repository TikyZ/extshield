'use strict';

/**
 * 手动下沉(你写 core.ts)+ 自动改写调用点
 *
 * 为什么不用原来的"独立 core.wasm + 异步 loader"那条路:
 *   异步 loader 要求调用点改成 await。真实代码里核心函数往往在同步循环里被调
 *   (比如 isSimilarUrl 在去重的 for 里),一改 await 就要把整条调用链改成 async,
 *   牵连一大片还容易改错。所以这里跟自动下沉一样走**同步内联**:wasm 以 base64
 *   内联进 JS,new WebAssembly.Module() 同步实例化,函数签名保持不变,
 *   调用点一行都不用动。
 *
 * 怎么知道要替换哪些函数:
 *   规则很简单也很死板 —— core.ts 里 export 的函数,只要在源码里找到**同名**
 *   的函数声明,就把它的函数体换成 wasm 调用。找不到同名的就如实报,不瞎猜。
 *
 * 字符串怎么过 wasm 边界(难点):
 *   wasm 只认数字。字符串要:① 用 __new(len<<1, 1) 在 wasm 内存里分配一块,
 *   逐字符写 charCode,把指针传进去;② 返回值是指针,先读它前面 4 字节的
 *   UTF-16 字节长度,再按 uint16 拼回字符串。所以编译必须带 --exportRuntime,
 *   否则没有 __new,JS 侧根本没法把字符串塞进去(这是踩过的点)。
 */

const fs = require('fs');
const path = require('path');
const ASC = require('./asc');
const RT = require('./runtime-gen');

let acorn;
function lazyAcorn() {
  if (!acorn) acorn = require('acorn');
  return acorn;
}

/** 数字类型走原样传参,字符串要 lower/lift,bool 要转布尔 */
function kindOf(type) {
  const t = String(type || '').trim();
  if (/^string$/i.test(t)) return 'string';
  if (/^(bool|boolean)$/i.test(t)) return 'bool';
  return 'num';
}

/**
 * 从 core.ts 源码里解析出导出函数的签名。
 * 为什么要解析源码而不是读 wasm 导出:wasm 里字符串参数就是个 i32 指针,
 * 看不出该不该做转换。签名只能从 .ts 里拿。
 */
function parseSignatures(tsSource) {
  const re =
    /export\s+function\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\)\s*(?::\s*([A-Za-z_$][\w$<>[\]|.\s]*?))?\s*\{/g;
  const out = [];
  let m;
  while ((m = re.exec(tsSource))) {
    const name = m[1];
    const rawParams = m[2].trim();
    const params = rawParams
      ? rawParams.split(',').map((p) => {
          const mm = p.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([^=]+?))?\s*(?:=.*)?$/);
          return { name: mm ? mm[1] : p.trim(), type: kindOf(mm ? mm[2] : '') };
        })
      : [];
    out.push({ name, params, ret: kindOf(m[3]) });
  }
  return out;
}

/** 递归列出目录下所有 .js */
function listJs(dir) {
  const files = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      if (fs.statSync(f).isDirectory()) walk(f);
      else if (/\.js$/i.test(n)) files.push(f);
    }
  })(dir);
  return files;
}

/**
 * 编译 core.ts -> core.wasm。
 *
 * 必须带 --exportRuntime:字符串参数需要 __new 在 wasm 内存里分配空间,
 * 不带这个标志 wasm 不会导出 __new,JS 侧没法把字符串传进去。
 *
 * 运行时用 incremental 而不是 minimal —— 这是实测选的:
 *   minimal / stub 是 bump 分配器,没有 __realloc / __free,__collect() 也是空壳。
 *   字符串每次都过边界(输入 lo() 要 __new,返回的字符串也是 wasm 里新分配的),
 *   实测 2 万次调用(每次 100 字符)内存从 1 页涨到 256 页 = 16.3 MB,调 __collect()
 *   一点都回收不了 —— 放在 service worker 这种长生命周期里就是持续泄漏。
 *   换成 incremental(自带 GC)后同样 2 万次调用稳定在 1 页,而 wasm 只大 0.4KB
 *   (11.4KB -> 11.8KB),几乎零代价。
 */
function compileWithRuntime(tsPath, wasmPath) {
  return ASC.compile(tsPath, wasmPath, { exportRuntime: true, runtime: 'incremental' });
}

/**
 * 生成同步 wasm 运行时(base64 内联 + 字符串 lower/lift 胶水)。
 * 只在新旧代码里出现一次(__essW),重复注入会被跳过。
 */
function buildRuntime(wasmPath) {
  const b64 = fs.readFileSync(wasmPath).toString('base64');
  // 包一层 try/catch:扩展页 CSP 拦掉 wasm 编译时,不能把整个文件带崩
  // (实测就是这一行没兜住,整个 popup 直接白屏)。
  return RT.guarded(
    'var s=' +
      JSON.stringify(b64) +
      ',b=atob(s),u=new Uint8Array(b.length);' +
      'for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);' +
      'var M=new WebAssembly.Module(u);' +
      // minimal runtime 只依赖 env.abort 一个导入,给个会抛错的桩即可
      'var X=new WebAssembly.Instance(M,{env:{abort:function(msg,f,l,c){' +
      'throw new Error("[extshield] wasm 内部错误,行 "+l);}}}).exports;' +
      'function U16(){return new Uint16Array(X.memory.buffer);}' +
      'function U32(){return new Uint32Array(X.memory.buffer);}' +
      'function lo(v){if(v==null)return 0;' +
      'var p=X.__new(v.length<<1,1)>>>0,a=U16();' +
      'for(var i=0;i<v.length;i++)a[(p>>>1)+i]=v.charCodeAt(i);return p;}' +
      'function li(p){if(!p)return null;' +
      'var e=(p+U32()[(p-4)>>>2])>>>1,a=U16(),s="";' +
      'for(var i=p>>>1;i<e;i++)s+=String.fromCharCode(a[i]);return s;}',
    '{x:X,lo:lo,li:li}'
  );
}

/** 给一个签名生成替换用的函数源码 */
function renderFunction(sig) {
  const args = sig.params
    .map((p) => (p.type === 'string' ? '__essW.lo(' + p.name + ')' : p.name))
    .join(', ');
  const call = '__essW.x.' + sig.name + '(' + args + ')';
  const body =
    sig.ret === 'string'
      ? 'return __essW.li(' + call + ');'
      : sig.ret === 'bool'
      ? 'return !!' + call + ';'
      : 'return ' + call + ';';
  return (
    'function ' + sig.name + '(' + sig.params.map((p) => p.name).join(', ') + ') { ' + body + ' }'
  );
}

/**
 * 跳过文件开头的注释和 "use strict" 指令,返回可以安全插入代码的位置。
 * 直接插到最前面会 'use strict' 变成普通字符串表达式,严格模式就失效了。
 */
function insertionIndex(code) {
  const m = code.match(
    /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*(?:'[^'\n]*'|"[^"\n]*"\s*;?\s*)?/
  );
  return m ? m[0].length : 0;
}

/**
 * 在 srcDir 里找与 core.ts 导出同名的函数声明,替换成 wasm 调用。
 * 返回被替换的函数名;一个都没匹配上就返回空数组(调用方据此如实报告)。
 */
function rewriteMatches(srcDir, sigs, wasmPath, opts = {}) {
  const acornMod = lazyAcorn();
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set();
  const keyOf = (p) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const byName = new Map(sigs.map((s) => [s.name, s]));
  const runtime = buildRuntime(wasmPath);
  const done = [];
  const warnings = [];
  const seenInFiles = new Map(); // 函数名 -> 出现过的文件名,用来发现"同名不同语义"
  const arityMismatch = [];
  const skippedContentScripts = [];
  let injected = false;

  for (const file of listJs(srcDir)) {
    // 只跳过「注入主世界」的 content script(套用网页 CSP,wasm 可能被拦);
    // 默认隔离世界的 content script 自带放行 wasm 的 CSP,照常下沉
    if (exclude.has(keyOf(file))) {
      skippedContentScripts.push(path.relative(srcDir, file).replace(/\\/g, '/'));
      continue;
    }
    const code = fs.readFileSync(file, 'utf8');
    if (code.includes('__essW')) continue;
    let ast;
    try {
      ast = acornMod.parse(code, {
        ecmaVersion: 2022,
        sourceType: 'module',
        allowReturnOutsideFunction: true,
      });
    } catch {
      continue;
    }

    const hits = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        n.forEach(walk);
        return;
      }
      if (n.type === 'FunctionDeclaration' && n.id && byName.has(n.id.name)) {
        hits.push({ name: n.id.name, start: n.start, end: n.end, paramCount: n.params.length });
      }
      for (const k of Object.keys(n)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
        walk(n[k]);
      }
    })(ast);

    if (!hits.length) continue;

    // 记录:同名函数是不是散落在多个文件里,以及参数个数对不对得上
    for (const h of hits) {
      if (!seenInFiles.has(h.name)) seenInFiles.set(h.name, []);
      seenInFiles.get(h.name).push(path.basename(file));
      const sig = byName.get(h.name);
      if (h.paramCount !== sig.params.length) {
        arityMismatch.push(
          `${h.name}(源码 ${h.paramCount} 个 / core.ts ${sig.params.length} 个)`
        );
      }
    }

    // 从后往前替换,避免前面的改动把后面的偏移量弄乱
    let out = code;
    for (const h of hits.slice().sort((a, b) => b.start - a.start)) {
      out = out.slice(0, h.start) + renderFunction(byName.get(h.name)) + out.slice(h.end);
      done.push(h.name);
    }
    const at = insertionIndex(out);
    out = out.slice(0, at) + runtime + out.slice(at);
    fs.writeFileSync(file, out, 'utf8');
    injected = true;
  }

  // 同名不同语义:一个 core.ts 导出只有一份实现,多个同名函数都会被换成它。
  // 这事必须让用户知道 —— 否则等于悄悄改了其中一个函数的行为。
  for (const [name, files] of seenInFiles) {
    const uniq = Array.from(new Set(files));
    if (uniq.length > 1) {
      const msg =
        `${name} 在多个文件里都有定义(${uniq.join('、')}),都会被替换成 core.ts 里的同一份实现;` +
        '如果它们本来语义就不一样,请改用不同函数名。';
      warnings.push(msg);
      console.warn('[wasm] ' + msg);
    }
  }
  if (arityMismatch.length) {
    const msg = '以下函数的参数个数与 core.ts 不一致,调用时可能传错参:' + arityMismatch.join(';');
    warnings.push(msg);
    console.warn('[wasm] ' + msg);
  }
  if (skippedContentScripts.length) {
    const msg =
      '以下「注入主世界」的 content script 已跳过下沉(' + skippedContentScripts.join('、') + '):' +
      '主世界套用的是网页自己的 CSP,严格站点会拦掉 wasm。';
    warnings.push(msg);
    console.warn('[wasm] ' + msg);
  }

  return { sunk: done, injected, warnings };
}

module.exports = {
  parseSignatures,
  compileWithRuntime,
  buildRuntime,
  renderFunction,
  rewriteMatches,
};
