// content.js — 示例 content script
// 合规:只是读取页面信息、发消息给 background。无动态执行。

(function () {
  function extractTitle() {
    const el = document.querySelector('title');
    return el ? el.textContent : '';
  }

  function extractMeta() {
    const desc = document.querySelector('meta[name="description"]');
    return desc ? desc.getAttribute('content') : '';
  }

  chrome.runtime.sendMessage(
    {
      type: 'compute',
      payload: { base: extractTitle().length, weight: extractMeta().length ? 2 : 1 },
    },
    (response) => {
      if (response && response.ok) {
        // 仅做演示,不在页面注入任何脚本
        window.__demoScore = response.score;
      }
    }
  );
})();
