'use strict';

/**
 * 产物安装前检查。
 *
 * 只回答一个问题:**这个包能不能顺利装进浏览器**。
 * 不关心里程碑式的"支持列表"，只查三类会真正导致装不上 / 装了是坏的硬伤:
 *   1. manifest_version 不对(Chrome 与 Edge 已停用 MV2,MV2 包会被直接拒绝);
 *   2. manifest 里写了、但产物中不存在的文件 —— 表现是图标变问号、页面白屏;
 *   3. 会被浏览器拒绝加载的写法(比如 MV3 的 CSP 里用 unsafe-eval)。
 *
 * 产物本身一个字节都不会被改动,这里是纯检查。
 */

const path = require('path');
const fs = require('fs');

/** 从 manifest 里收集所有"指向包内文件"的引用,用于检查文件是否真的在产物里 */
function collectRefs(m) {
  const refs = [];
  const add = (v, where) => {
    if (typeof v !== 'string') return;
    if (/^(?:https?:)?\/\//i.test(v)) return; // 远程地址不是包内文件
    refs.push({ file: v.replace(/^\.\//, ''), where });
  };

  if (m.icons) for (const [k, v] of Object.entries(m.icons)) add(v, `icons.${k}`);
  if (m.default_locale) add(`_locales/${m.default_locale}/messages.json`, 'default_locale');

  for (const key of ['action', 'browser_action', 'page_action']) {
    const host = m[key];
    if (!host) continue;
    add(host.default_popup, `${key}.default_popup`);
    if (host.default_icon) {
      if (typeof host.default_icon === 'string') add(host.default_icon, `${key}.default_icon`);
      else for (const v of Object.values(host.default_icon)) add(v, `${key}.default_icon`);
    }
  }
  add(m.options_page, 'options_page');
  if (m.options_ui) add(m.options_ui.page, 'options_ui.page');

  if (m.background) {
    add(m.background.service_worker, 'background.service_worker');
    if (Array.isArray(m.background.scripts)) {
      m.background.scripts.forEach((v) => add(v, 'background.scripts'));
    }
    add(m.background.page, 'background.page');
  }

  if (Array.isArray(m.content_scripts)) {
    m.content_scripts.forEach((cs, i) => {
      (cs.js || []).forEach((v) => add(v, `content_scripts[${i}].js`));
      (cs.css || []).forEach((v) => add(v, `content_scripts[${i}].css`));
    });
  }

  for (const key of ['chrome_url_overrides', 'browser_url_overrides']) {
    if (!m[key]) continue;
    for (const [k, v] of Object.entries(m[key])) add(v, `${key}.${k}`);
  }
  add(m.devtools_page, 'devtools_page');
  if (m.side_panel) add(m.side_panel.default_path, 'side_panel.default_path');
  if (m.sandbox && Array.isArray(m.sandbox.pages)) {
    m.sandbox.pages.forEach((v) => add(v, 'sandbox.pages'));
  }
  if (Array.isArray(m.web_accessible_resources)) {
    m.web_accessible_resources.forEach((r, i) => {
      if (typeof r === 'string') return; // MV2 写法是通配字符串,不检查
      (r.resources || []).forEach((v) => add(v, `web_accessible_resources[${i}]`));
    });
  }
  return refs;
}

/**
 * 检查产物目录。
 * @param {string} outDir 产物目录(harden 的输出)
 */
function analyze(outDir) {
  const res = {
    outDir,
    hasManifest: false,
    mv: null,
    missing: [],
    warnings: [],
  };
  const mp = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(mp)) {
    res.warnings.push({
      level: 'high',
      text: '产物里没有 manifest.json —— 任何浏览器都无法安装。',
    });
    return res;
  }
  res.hasManifest = true;

  let m;
  try {
    m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch (e) {
    res.warnings.push({
      level: 'high',
      text: `manifest.json 解析失败,浏览器会拒绝加载: ${e.message}`,
    });
    return res;
  }
  res.mv = Number(m.manifest_version) || null;

  // 1) manifest 里写了、但产物里没有的文件
  for (const r of collectRefs(m)) {
    if (!r.file) continue;
    if (/[*?]/.test(r.file)) continue; // 通配路径不检查
    if (!fs.existsSync(path.join(outDir, r.file))) res.missing.push(r);
  }

  // 2) manifest 版本
  if (res.mv === 2) {
    res.warnings.push({
      level: 'high',
      text: '这是 Manifest V2 扩展:Chrome 与 Edge 已停用 MV2,现在会被浏览器直接拒绝加载(不是打包的问题)。请升级到 MV3。',
    });
  } else if (res.mv !== 3) {
    res.warnings.push({
      level: 'high',
      text: `manifest_version 是 ${res.mv}(或缺失)—— 必须是 3,否则浏览器无法识别。`,
    });
  }

  // 3) 必填字段:缺了浏览器直接拒绝加载
  if (!m.name || !m.version) {
    res.warnings.push({
      level: 'high',
      text: 'manifest 缺少必填的 name 或 version,浏览器会拒绝加载。',
    });
  }

  // 4) 会被拒绝加载的写法
  const csp =
    m.content_security_policy && typeof m.content_security_policy === 'object'
      ? m.content_security_policy.extension_pages
      : m.content_security_policy;
  if (typeof csp === 'string' && /'unsafe-eval'/.test(csp)) {
    res.warnings.push({
      level: 'high',
      text: "CSP 里含 'unsafe-eval':MV3 下浏览器会直接拒绝加载,应改用 'wasm-unsafe-eval'。",
    });
  }

  return res;
}

/** 打印检查结果 */
function print(res) {
  console.log('');
  console.log('── 浏览器兼容性 ──');
  if (!res.hasManifest) {
    for (const w of res.warnings) console.log(`  ❌ ${w.text}`);
    return res;
  }
  console.log(`  manifest_version: ${res.mv}`);

  if (res.missing.length) {
    console.log('');
    console.log(`  ❌ manifest 引用了 ${res.missing.length} 个产物中不存在的文件(会导致图标缺失 / 页面空白):`);
    for (const r of res.missing.slice(0, 12)) {
      console.log(`     - ${r.file}   (来自 ${r.where})`);
    }
    if (res.missing.length > 12) console.log(`     ... 还有 ${res.missing.length - 12} 个`);
  }
  for (const w of res.warnings) {
    console.log(`  ❌ ${w.text}`);
  }
  if (!res.missing.length && !res.warnings.length) {
    console.log('  ✅ 未发现会导致安装失败的问题');
  }
  return res;
}

function run(cfg) {
  return print(analyze(cfg.outDir));
}

module.exports = { analyze, collectRefs, print, run };
