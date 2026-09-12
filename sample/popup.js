// popup.js — 示例 popup 脚本
(function () {
  const btn = document.getElementById('btn');
  const out = document.getElementById('out');
  if (!btn) return;

  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'getConfig' }, (response) => {
      if (response && response.ok) {
        out.textContent = JSON.stringify(response.config, null, 2);
      } else {
        out.textContent = '出错了';
      }
    });
  });
})();
