'use strict';

const folderInput = document.getElementById('folder');
const folderLabel = document.getElementById('folderLabel');
const folderInfo = document.getElementById('folderInfo');
const packBtn = document.getElementById('packBtn');
const progress = document.getElementById('progress');
const result = document.getElementById('result');

let selectedFiles = []; // { path, data(base64) }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c]));
}

function hideReport() {
  const box = document.getElementById('report');
  if (box) box.classList.add('hidden');
  const empty = document.getElementById('reportEmpty');
  if (empty) empty.classList.remove('hidden');
}

function renderReport(report) {
  const box = document.getElementById('report');
  if (!box) return;
  if (!report) {
    box.classList.add('hidden');
    return;
  }

  const empty = document.getElementById('reportEmpty');
  if (empty) empty.classList.add('hidden');

  if (report.noJs) {
    box.className = 'report warn';
    box.innerHTML =
      '<div class="rtitle">⚠️ 合规扫描未执行</div>' +
      '<div class="rbody">' + esc(report.error || '产物里没有找到 .js 文件') + '</div>';
    box.classList.remove('hidden');
    return;
  }

  const c = report.counts || { high: 0, medium: 0, info: 0 };
  let html =
    '<div class="rtitle">' +
    (report.passed ? '✅ 合规扫描通过' : '❌ 合规扫描发现风险') +
    '</div>';
  html +=
    '<div class="rsum">扫描 ' + (report.fileCount || 0) + ' 个 js' +
    (report.inlineCount ? ' + ' + report.inlineCount + ' 段内联脚本' : '') +
    ' · 高危 <b class="' + (c.high ? 'sev-high' : '') + '">' + c.high + '</b>' +
    ' / 中等 <b class="' + (c.medium ? 'sev-mid' : '') + '">' + c.medium + '</b>' +
    ' / 提示 ' + c.info + '</div>';

  // WASM 来源:明确告诉用户打进去的是他自己的逻辑还是内置示例。
  // 免得出现"以为沉了自己的核心代码,实际是 demo"这种误导。
  const w = report.wasm || {};
  if (w.enabled) {
    const srcText =
      w.source === 'auto'
        ? '🤖 <b>自动下沉</b>:从你的代码中扫描出 ' +
          (w.sunk ? w.sunk.length : 0) +
          ' 个纯计算函数,已编译成 wasm 并内联(原实现已替换)'
        : w.source === 'user-core'
        ? '✅ 来自你自己的 <b>core.ts</b>(已编译进 core.wasm)'
        : w.source === 'compile-failed'
        ? '⚠️ 你的 core.ts <b>编译失败</b>,本次没有下沉任何函数'
        : w.source === 'auto-failed'
        ? '⚠️ <b>自动下沉失败</b>,本次没有下沉任何函数'
        : '⚠️ <b>本次没有下沉任何函数</b>:共扫描 ' +
          (w.scanned || 0) +
          ' 个,均不适合(涉及浏览器 / 扩展 API,或非纯数值运算)。' +
          '<b>包里不会有 wasm</b>,你的逻辑仍在 JS 里 —— 靠压缩 + 合规扫描保护。' +
          '想真正下沉:把核心算法拆成只做数值计算的独立函数,或编写 core.ts 放到插件根目录。';
    html += '<div class="rsum">WASM 下沉:' + srcText;
    if (w.sunk && w.sunk.length) {
      html += ' · 已下沉:' + esc(w.sunk.join(', '));
    }
    if (w.exports && w.exports.length && w.source !== 'auto') {
      html += ' · 导出:' + esc(w.exports.join(', '));
    }
    if (w.skipped && w.skipped.length) {
      const names = w.skipped.slice(0, 4).map((s) => s.name).join(', ');
      html +=
        '<br><span style="opacity:.75">另有 ' +
        w.skipped.length +
        ' 个函数未下沉(涉及浏览器 / 扩展 API 或非数值运算):' +
        esc(names) +
        (w.skipped.length > 4 ? ' 等' : '') +
        '</span>';
    }
    html += '</div>';
  }

  const hits = report.hits || [];
  if (!hits.length) {
    html += '<div class="rbody">未检测到会触发商店审核红线的混淆特征,可以打包上传。</div>';
  } else {
    const order = { high: 0, medium: 1, info: 2 };
    hits.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    html += '<div class="rlist">';
    for (const h of hits) {
      const tag = h.severity === 'high' ? '高危' : h.severity === 'medium' ? '中等' : '提示';
      html +=
        '<div class="rhit ' + esc(h.severity) + '">' +
        '<div class="rh"><span class="rtag ' + esc(h.severity) + '">' + tag + '</span> ' +
        esc(h.name) + ' <span class="rrule">' + esc(h.rule) + '</span></div>' +
        '<div class="rmeta">' + esc(h.file) + (h.line ? ' (行 ' + h.line + ')' : '') + '</div>' +
        (h.snippet ? '<div class="rsnip">' + esc(h.snippet) + '</div>' : '') +
        '<div class="rmsg">' + esc(h.message) + '</div>' +
        '</div>';
    }
    html += '</div>';
  }

  box.className = 'report ' + (report.passed ? 'ok' : 'bad');
  box.innerHTML = html;
  box.classList.remove('hidden');
}

function bufToBase64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ── 另存为:让用户可以自己选保存位置 ───────────────────────
// 说明:必须在点击事件的"用户手势"里直接调用 showSaveFilePicker,
// 如果等 fetch 打包完成再调用,Chrome 的瞬时激活(约 5 秒)早就过期,
// 会抛 SecurityError 导致弹不出窗口。所以这里先选位置、再打包。
function suggestedName(method) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `extshield-${method}-${ts}.zip`;
}

function pickSaveHandle(name) {
  if (typeof window.showSaveFilePicker !== 'function') {
    return Promise.resolve(null); // Firefox / Safari → 降级
  }
  return window
    .showSaveFilePicker({
      suggestedName: name,
      types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }],
    })
    .catch((e) => {
      if (e && e.name === 'AbortError') throw e; // 用户主动点了取消
      console.warn('showSaveFilePicker 不可用,降级为浏览器默认下载:', e);
      return null;
    });
}

async function saveZip(blob, handle, fallbackName) {
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return { name: handle.name, picked: true };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { name: fallbackName, picked: false };
}

async function readFile(file) {
  const buf = await file.arrayBuffer();
  // webkitRelativePath 格式: "选中的文件夹名/相对路径"
  // 服务端期望相对于插件根目录的路径,所以去掉第一层(文件夹名)
  let rel = file.webkitRelativePath || file.name;
  const parts = rel.split('/');
  if (parts.length > 1) parts.shift(); // 去掉顶层文件夹名
  rel = parts.join('/') || rel;
  return {
    path: rel,
    data: bufToBase64(buf),
  };
}

folderInput.addEventListener('change', async () => {
  selectedFiles = [];
  const files = Array.from(folderInput.files || []);
  if (!files.length) return;

  folderLabel.textContent = `已选择 ${files.length} 个文件`;
  progress.classList.add('hidden');
  result.classList.add('hidden');
  hideReport();

  // 读取(小文件夹同步读完足够)
  for (const f of files) {
    selectedFiles.push(await readFile(f));
  }

  // 尝试解析 manifest 显示信息
  let info = `已载入 <b>${files.length}</b> 个文件。`;
  const manifestFile = files.find(
    (f) => (f.webkitRelativePath || f.name).replace(/.*\//, '') === 'manifest.json'
  );
  if (manifestFile) {
    try {
      const m = JSON.parse(await manifestFile.text());
      const ents = [];
      // 与 src/config.js 的 detectEntries 保持一致,别漏了 options 页。
      const push = (v) => {
        if (typeof v === 'string' && v) ents.push(v.replace(/^\.\//, ''));
      };
      if (m.background) {
        push(m.background.service_worker);
        (m.background.scripts || []).forEach(push);
      }
      (m.content_scripts || []).forEach((cs) => (cs.js || []).forEach(push));
      if (m.action) push(m.action.default_popup);
      push(m.options_page);
      if (m.options_ui) push(m.options_ui.page);
      info += ` 检测到入口文件: <b>${ents.join(', ') || '无'}</b>。`;
    } catch (e) {
      info += ' (manifest.json 解析失败)';
    }
  } else {
    info += ' <b style="color:#b91c1c">未找到 manifest.json</b>,将无法打包。';
  }
  folderInfo.innerHTML = info;
  folderInfo.classList.remove('hidden');

  packBtn.disabled = !manifestFile;
});

packBtn.addEventListener('click', async () => {
  if (!selectedFiles.length) return;
  // 收集选中的保护方式(单选)
  const checked = document.querySelector('input[name="method"]:checked');
  if (!checked) {
    result.className = 'result err';
    result.innerHTML = '❌ 请选择一种保护方式。';
    result.classList.remove('hidden');
    return;
  }
  const methods = [checked.value];
  const mangleProps = document.getElementById('mangleProps').checked;

  // 先弹"另存为"让用户选位置(必须在用户手势内)
  const defaultName = suggestedName(checked.value);
  let handle = null;
  try {
    handle = await pickSaveHandle(defaultName);
  } catch (e) {
    // 用户在另存为窗口点了取消 → 不打包,直接结束
    result.className = 'result err';
    result.innerHTML = '已取消,没有打包。';
    result.classList.remove('hidden');
    return;
  }

  packBtn.disabled = true;
  result.classList.add('hidden');
  progress.classList.remove('hidden');
  progress.innerHTML =
    '<span class="spin"></span>正在打包(' + checked.value + ')…' +
    (handle ? '<div class="sub-prog">保存到:' + esc(handle.name) + '</div>' : '');

  try {
    const resp = await fetch('/api/pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ methods, mangleProps, files: selectedFiles }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '服务端错误 ' + resp.status);
    }

    const data = await resp.json();

    // 1) zip 由 base64 还原后写入用户选的位置
    const bin = atob(data.zip);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/zip' });
    const saved = await saveZip(blob, handle, data.filename || defaultName);

    progress.classList.add('hidden');
    result.className = 'result ok';
    result.innerHTML = saved.picked
      ? `✅ 打包完成,已保存到 <b>${esc(saved.name)}</b>。解压后即是可上传商店的扩展目录。`
      : `✅ 打包完成,已下载 <b>${esc(saved.name)}</b>。当前浏览器不支持选位置弹窗,` +
        `文件进了浏览器默认下载目录(Chrome 可在设置里打开「下载前询问每个文件的保存位置」)。`;

    // 2) 展示合规扫描报告
    renderReport(data.report);
  } catch (e) {
    progress.classList.add('hidden');
    result.className = 'result err';
    result.innerHTML = '❌ 打包失败:' + e.message;
  } finally {
    packBtn.disabled = false;
  }
});
