'use strict';

/**
 * 根据 core.wasm 的「真实导出」自动生成 wasm-loader.js。
 *
 * 为什么需要它:
 *   以前 loader 是手写的,里面把 generateToken / verifyToken / fib 三个函数写死。
 *   用户只要改了 core.ts 的导出,loader 就对不上(调用不存在的导出直接报错)。
 *   现在改成:编译完 core.wasm 后,读出它实际导出了哪些函数,再生成对应的包装,
 *   用户只管改 core.ts,不用碰 loader。
 *
 * 用法:
 *   const names = generateLoader(wasmPath, loaderOutPath);
 */

const fs = require('fs');
const path = require('path');

/**
 * 读出 wasm 里导出的所有函数名。
 * 用 Node 内置的 WebAssembly.Module.exports(),不用手工解析二进制,稳。
 */
function readExportNames(wasmPath) {
  const buf = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(buf); // 不是合法 wasm 会在这里抛错
  return WebAssembly.Module.exports(mod)
    .filter((e) => e.kind === 'function')
    .map((e) => e.name);
}

/** 生成 loader 源码。exportNames 为空时只留 loadWasm()。 */
function renderLoader(exportNames) {
  const list = exportNames.length ? exportNames.join(', ') : '(无导出函数)';

  // 用 rest 参数(...args),这样不管 core.ts 里函数几个参数,包装都能原样透传。
  const wrappers = exportNames
    .map(
      (n) =>
        `export async function ${n}(...args) {\n` +
        `  const inst = await loadWasm();\n` +
        `  return inst.exports.${n}(...args);\n` +
        `}`
    )
    .join('\n\n');

  return `// src/wasm-loader.js
// 【自动生成,请勿手改】
// 由 src/wasm-loader-gen.js 在 core.wasm 编译完成后生成。
// 你改了 core.ts 里 export 的函数,重新编译就会同步更新本文件。
//
// 当前 core.wasm 导出的函数: ${list}
//
// 注意:WASM 实例只在「单次 Service Worker 生命周期」内缓存。
// MV3 的 SW 会被浏览器回收,下次事件唤醒时要重新实例化,这是正常现象。

let _modulePromise = null;

function getModule() {
  if (!_modulePromise) {
    _modulePromise = (async () => {
      let bytes;
      try {
        // 合规要点:core.wasm 必须随包发布,通过 chrome.runtime.getURL 取本地文件。
        // 绝不能从远程 URL 拉取——那属于远程代码,会被 Chrome Web Store 拒绝。
        const res = await fetch(chrome.runtime.getURL('core.wasm'));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        bytes = await res.arrayBuffer();
      } catch (e) {
        throw new Error(
          '[extshield] 加载 core.wasm 失败: ' +
            ((e && e.message) || e) +
            '。请确认 core.wasm 已随包发布,并在 manifest 的 web_accessible_resources 里声明。'
        );
      }
      return WebAssembly.compile(bytes);
    })();
  }
  return _modulePromise;
}

let _instance = null;

export async function loadWasm() {
  if (_instance) return _instance;
  const mod = await getModule();
  _instance = await WebAssembly.instantiate(mod);
  return _instance;
}

${wrappers}
`;
}

/**
 * 读 wasm 导出 -> 生成 loader 写到 outPath -> 返回导出函数名数组。
 */
function generateLoader(wasmPath, outPath) {
  const names = readExportNames(wasmPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderLoader(names), 'utf8');
  return names;
}

module.exports = { readExportNames, renderLoader, generateLoader };
