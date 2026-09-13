'use strict';

const folderInput = document.getElementById('folder');
const folderLabel = document.getElementById('folderLabel');
const folderInfo = document.getElementById('folderInfo');
const packBtn = document.getElementById('packBtn');
const progress = document.getElementById('progress');
const result = document.getElementById('result');

let selectedFiles = []; // { path, data(base64) }
// 已选文件夹的信息快照 —— 切换语言时据此重新渲染,而不是留下另一种语言的残句
let folderState = null; // { count, hasManifest, entries, parseFailed }

// 进度 / 结果 / 报告的「数据快照」—— 切换语言时据此用新语言原地重绘,
// 而不是把已经出来的结果收起、让用户重新打包一遍。
let lastProgress = null; // { mode, savingName }
let lastResult = null;   // { cls, key, params }
let lastReport = null;   // /api/pack 返回的 report 对象

// 按当前语言重绘进度区(打包进行中切语言 / 复用同一段逻辑)
function redrawProgress() {
  if (!lastProgress) {
    progress.classList.add('hidden');
    return;
  }
  progress.innerHTML =
    I18N.t('pack.running', { mode: lastProgress.mode }) +
    (lastProgress.savingName
      ? '<div class="sub-prog">' + I18N.t('pack.savingTo', { name: esc(lastProgress.savingName) }) + '</div>'
      : '');
  progress.classList.remove('hidden');
}

// 按当前语言重绘结果区(成功 / 失败 / 提示 都只存参数,文案每次现取)
function redrawResult() {
  if (!lastResult) {
    result.classList.add('hidden');
    return;
  }
  result.className = lastResult.cls;
  result.innerHTML = I18N.t(lastResult.key, lastResult.params || {});
  result.classList.remove('hidden');
}

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
      '<div class="rtitle">' + I18N.t('report.nojs.title') + '</div>' +
      '<div class="rbody">' + esc(report.error || I18N.t('report.nojs.body')) + '</div>';
    box.classList.remove('hidden');
    return;
  }

  const c = report.counts || { high: 0, medium: 0, info: 0 };
  let html =
    '<div class="rtitle">' +
    (report.passed ? I18N.t('report.passed') : I18N.t('report.failed')) +
    '</div>';
  html +=
    '<div class="rsum">' +
    I18N.t('report.summary', {
      files: report.fileCount || 0,
      inlineMore: report.inlineCount ? I18N.t('report.inlineMore', { n: report.inlineCount }) : '',
      hcls: c.high ? 'sev-high' : '',
      high: c.high,
      mcls: c.medium ? 'sev-mid' : '',
      medium: c.medium,
      info: c.info,
    }) +
    '</div>';

  // WASM 来源:明确告诉用户打进去的是他自己的逻辑还是内置示例。
  // 免得出现"以为沉了自己的核心代码,实际是 demo"这种误导。
  const w = report.wasm || {};
  if (w.enabled) {
    const srcText =
      w.source === 'auto'
        ? I18N.t('report.wasm.auto', { n: w.sunk ? w.sunk.length : 0 })
        : w.source === 'user-core'
        ? I18N.t('report.wasm.userCore')
        : w.source === 'compile-failed'
        ? I18N.t('report.wasm.compileFailed')
        : w.source === 'auto-failed'
        ? I18N.t('report.wasm.autoFailed')
        : I18N.t('report.wasm.none', { n: w.scanned || 0 });
    html += '<div class="rsum">' + I18N.t('report.wasm.line', { src: srcText });
    if (w.sunk && w.sunk.length) {
      html += I18N.t('report.wasm.sunkLabel', { names: esc(w.sunk.join(', ')) });
    }
    if (w.exports && w.exports.length && w.source !== 'auto') {
      html += I18N.t('report.wasm.exportsLabel', { names: esc(w.exports.join(', ')) });
    }
    if (w.skipped && w.skipped.length) {
      const names = w.skipped.slice(0, 4).map((s) => s.name).join(', ');
      html += I18N.t('report.wasm.skippedMore', {
        n: w.skipped.length,
        names: esc(names),
        etc: w.skipped.length > 4 ? I18N.t('report.wasm.etc') : '',
      });
    }
    html += '</div>';
  }

  const hits = report.hits || [];
  if (!hits.length) {
    html += '<div class="rbody">' + I18N.t('report.clean') + '</div>';
  } else {
    const order = { high: 0, medium: 1, info: 2 };
    hits.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    html += '<div class="rlist">';
    for (const h of hits) {
      const tag = I18N.t(
        h.severity === 'high'
          ? 'report.sev.high'
          : h.severity === 'medium'
          ? 'report.sev.medium'
          : 'report.sev.info'
      );
      html +=
        '<div class="rhit ' + esc(h.severity) + '">' +
        '<div class="rh"><span class="rtag ' + esc(h.severity) + '">' + tag + '</span> ' +
        esc(h.name) + ' <span class="rrule">' + esc(h.rule) + '</span></div>' +
        '<div class="rmeta">' + esc(h.file) + (h.line ? I18N.t('report.lineRef', { n: h.line }) : '') + '</div>' +
        (h.snippet ? '<div class="rsnip">' + esc(h.snippet) + '</div>' : '') +
        '<div class="rmsg">' + esc(h.message) + '</div>' +
        '</div>';
    }
    html += '</div>';
  }

  // 浏览器兼容性(安装前检查):只列会导致装不上 / 装了是坏的硬伤
  const cm = report.compat;
  if (cm && cm.hasManifest) {
    html += '<div class="rbody" style="margin-top:10px">';
    html += '<div style="font-weight:600;margin-bottom:4px">' + I18N.t('compat.title') + '</div>';
    html += '<div>' + I18N.t('compat.mv') + ': ' + esc(cm.mv) + '</div>';
    if (cm.missing && cm.missing.length) {
      html +=
        '<div style="color:#b91c1c;margin-top:6px">❌ ' +
        I18N.t('compat.missing', { n: cm.missingTotal || cm.missing.length });
      for (const r of cm.missing) {
        html += '<div style="margin-left:12px">- ' + esc(r.file) + ' (' + esc(r.where) + ')</div>';
      }
      if (cm.missingTotal > cm.missing.length) {
        html += I18N.t('compat.missingMore', { n: cm.missingTotal - cm.missing.length });
      }
      html += '</div>';
    }
    for (const w of cm.warnings || []) {
      html += '<div style="margin-top:4px">❌ ' + esc(w.text) + '</div>';
    }
    if (!cm.missing.length && !(cm.warnings || []).length) {
      html += '<div>✅ ' + I18N.t('compat.clean') + '</div>';
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
      types: [{ description: I18N.t('picker.zipDesc'), accept: { 'application/zip': ['.zip'] } }],
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

// 按当前语言渲染"已选文件夹"的提示;folderState 为空则回到初始文案。
function renderFolderInfo() {
  if (!folderState) {
    folderLabel.textContent = I18N.t('step1.pick');
    folderInfo.classList.add('hidden');
    folderInfo.innerHTML = '';
    packBtn.disabled = true;
    return;
  }

  folderLabel.textContent = I18N.t('folder.selected', { n: folderState.count });

  let info = I18N.t('folder.loaded', { n: folderState.count });
  if (!folderState.hasManifest) {
    info += I18N.t('folder.noManifest');
  } else if (folderState.parseFailed) {
    info += I18N.t('folder.parseFailed');
  } else {
    const list = folderState.entries.join(', ') || I18N.t('folder.none');
    info += I18N.t('folder.entries', { list });
  }
  folderInfo.innerHTML = info;
  folderInfo.classList.remove('hidden');
  packBtn.disabled = !folderState.hasManifest;
}

folderInput.addEventListener('change', async () => {
  selectedFiles = [];
  folderState = null;
  const files = Array.from(folderInput.files || []);
  if (!files.length) {
    renderFolderInfo();
    return;
  }

  // 先给个即时反馈,读完文件后再按解析结果重渲染
  folderLabel.textContent = I18N.t('folder.selected', { n: files.length });
  progress.classList.add('hidden');
  result.classList.add('hidden');
  hideReport();

  // 读取(小文件夹同步读完足够)
  for (const f of files) {
    selectedFiles.push(await readFile(f));
  }

  // 尝试解析 manifest 显示信息
  const manifestFile = files.find(
    (f) => (f.webkitRelativePath || f.name).replace(/.*\//, '') === 'manifest.json'
  );
  let entries = [];
  let parseFailed = false;
  if (manifestFile) {
    try {
      const m = JSON.parse(await manifestFile.text());
      // 与 src/config.js 的 detectEntries 保持一致,别漏了 options 页。
      const push = (v) => {
        if (typeof v === 'string' && v) entries.push(v.replace(/^\.\//, ''));
      };
      if (m.background) {
        push(m.background.service_worker);
        (m.background.scripts || []).forEach(push);
      }
      (m.content_scripts || []).forEach((cs) => (cs.js || []).forEach(push));
      if (m.action) push(m.action.default_popup);
      push(m.options_page);
      if (m.options_ui) push(m.options_ui.page);
    } catch (e) {
      parseFailed = true;
    }
  }

  folderState = {
    count: files.length,
    hasManifest: !!manifestFile,
    entries,
    parseFailed,
  };
  renderFolderInfo();
});

packBtn.addEventListener('click', async () => {
  if (!selectedFiles.length) return;
  // 收集选中的保护方式(单选)
  const checked = document.querySelector('input[name="method"]:checked');
  if (!checked) {
    lastResult = { cls: 'result err', key: 'pack.noMethod' };
    redrawResult();
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
    lastResult = { cls: 'result err', key: 'pack.canceled' };
    redrawResult();
    return;
  }

  packBtn.disabled = true;
  // 新一轮打包:清掉上一轮的结果与报告
  lastResult = null;
  lastReport = null;
  lastProgress = { mode: checked.value, savingName: handle ? handle.name : null };
  redrawResult();
  hideReport();
  redrawProgress();

  try {
    const resp = await fetch('/api/pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ methods, mangleProps, files: selectedFiles }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || I18N.t('pack.serverError', { code: resp.status }));
    }

    const data = await resp.json();

    // 1) zip 由 base64 还原后写入用户选的位置
    const bin = atob(data.zip);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/zip' });
    const saved = await saveZip(blob, handle, data.filename || defaultName);

    lastProgress = null;
    lastResult = {
      cls: 'result ok',
      key: saved.picked ? 'pack.savedTo' : 'pack.downloaded',
      params: { name: esc(saved.name) },
    };
    redrawProgress();
    redrawResult();

    // 2) 展示合规扫描报告(数据留存,切换语言时用新语言重绘)
    lastReport = data.report || null;
    renderReport(lastReport);
  } catch (e) {
    lastProgress = null;
    lastResult = { cls: 'result err', key: 'pack.failed', params: { msg: esc(e.message) } };
    redrawProgress();
    redrawResult();
  } finally {
    packBtn.disabled = false;
  }
});

// 切换语言:i18n 已刷新静态文案,这里把动态区域(进度 / 结果 / 报告 / 文件夹信息)
// 按留存的数据用新语言原地重绘 —— 不重载页面,也不会丢掉已经出来的结果。
I18N.onChange(() => {
  redrawProgress();
  redrawResult();
  if (lastReport) renderReport(lastReport);
  renderFolderInfo();
});
