// src/wasm-loader.js
// 【自动生成,请勿手改】
// 由 src/wasm-loader-gen.js 在 core.wasm 编译完成后生成。
// 你改了 core.ts 里 export 的函数,重新编译就会同步更新本文件。
//
// 当前 core.wasm 导出的函数: generateToken, verifyToken
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

export async function generateToken(...args) {
  const inst = await loadWasm();
  return inst.exports.generateToken(...args);
}

export async function verifyToken(...args) {
  const inst = await loadWasm();
  return inst.exports.verifyToken(...args);
}
