// background.js — 示例 service worker(Manifest V3)
// 这里放的是"合规"代码:监听消息 + 用 chrome.storage 存配置。
// 注意:没有 eval / 字符串加密 / 控制流平坦化。

const DEFAULT_CONFIG = {
  enabled: true,
  threshold: 0.5,
  label: 'demo',
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['config'], (res) => {
    if (!res.config) {
      chrome.storage.local.set({ config: DEFAULT_CONFIG });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'getConfig') {
    chrome.storage.local.get(['config'], (res) => {
      sendResponse({ ok: true, config: res.config || DEFAULT_CONFIG });
    });
    return true; // 异步响应
  }
  if (message && message.type === 'compute') {
    const value = computeScore(message.payload || {});
    sendResponse({ ok: true, score: value });
    return false;
  }
  return false;
});

// 纯数值计算、不碰浏览器 API —— 这类函数会被 --wasm 自动下沉进 core.wasm,
// 打包后你在这里看到的是 wasm 字节码,不再是明文的 JS 算法。
function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// 一个会被压缩改名的普通业务函数(无敏感逻辑)
function computeScore(payload) {
  const base = payload.base || 0;
  const weight = payload.weight || 1;
  const adjusted = (base * weight) / (1 + Math.abs(weight - 1));
  return clamp01(adjusted);
}

function logInternal(tag, data) {
  // 这段会在 harden 时被 drop(因为 dropConsole)
  console.log('[demo]', tag, data);
}
