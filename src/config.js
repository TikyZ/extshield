'use strict';

const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  // 源码目录(相对或绝对)
  srcDir: 'src',
  // 加固输出目录
  outDir: 'dist',
  // 显式指定入口 js(相对 srcDir)。为空则从 manifest 自动探测。
  entries: null,
  // 是否额外用 terser 做属性名改名(更激进,需谨慎)
  mangleProps: false,
  // 是否启用 WASM 下沉(核心逻辑进 wasm,提高复刻门槛)
  wasm: false,
  // 手动下沉用:你自己的 core.ts 路径。留空则走规则分析自动下沉。
  wasmCore: null,
  // 是否丢弃 console.* / debugger
  dropConsole: true,
  // 是否剥离所有注释(含 license 注释)。保留 license 请设为 false。
  stripComments: true,
  // 属性改名时保留的名字(避免破坏 chrome / DOM / 跨文件消息键)
  reservedProps: [
    'chrome', 'browser', 'window', 'document', 'location', 'navigator',
    'self', 'globalThis', 'top', 'parent', 'frameElement', 'localStorage',
    'sessionStorage', 'console', 'setTimeout', 'setInterval', 'clearTimeout',
    'clearInterval', 'fetch', 'XMLHttpRequest', 'JSON', 'Math', 'Date',
    'RegExp', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'addEventListener',
  ],
  // 静态资源拷贝时跳过的目录/文件(按 basename 匹配)
  ignore: [
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'sample-dist',
    // 云端部署工具产物与缓存:含账号凭据,绝不能进发布包
    '.wrangler', '.vercel', '.netlify', '.serverless',
    // 后端服务代码:与浏览器扩展无关,不参与打包
    'worker', 'workers',
    // 云端部署配置:含 KV namespace id 等内部信息,且与扩展运行无关
    'wrangler.toml', 'wrangler.json', 'vercel.json', 'netlify.toml',
    'serverless.yml', 'Dockerfile', 'docker-compose.yml',
    // 编辑器 / 系统噪声
    '.vscode', '.idea', '.DS_Store',
    // 开发产物与说明文档:发布包不需要
    'README.md', 'CHANGELOG.md', '.test-response.zip',
  ],
  // 敏感文件红线:即使上面 ignore 漏了,打包后也会扫一遍产物,
  // 命中即报错并拒绝产出,防止 Cloudflare / 云厂商账号信息被打包上传。
  sensitivePatterns: [
    /[\\/]\.wrangler[\\/]/i,
    /wrangler-account\.json$/i,
    /[\\/]\.git[\\/]/i,
    /[\\/]\.env/i,
    /(^|[\\/])(credentials?|secrets?)\.json$/i,
    /service[-_]?account.*\.json$/i,
    /\.(pem|p12|pfx|key)$/i,
    /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  ],
  // 命中敏感文件时:throw = 直接中断(默认,安全优先);warn = 仅告警
  onSensitive: 'throw',
};

/**
 * 从 manifest.json 自动探测入口 js 与需要拷贝的 html。
 */
function detectEntries(manifestPath, srcDir) {
  const entries = new Set();
  const htmlFiles = new Set();
  // HTML 里引用的远程脚本(http/https)。它们不是本地文件,
  // 若当成本地入口传给 esbuild 会拼成 "src\https:\..." 直接崩溃。
  // 单独收集出来告警,提示用户本地化(MV3 本身也禁止远程代码)。
  const remoteScripts = new Set();

  if (!fs.existsSync(manifestPath)) {
    return { entries: [], htmlFiles: [], remoteScripts: [] };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const pushJs = (p) => {
    if (typeof p !== 'string') return;
    if (/^(?:https?:)?\/\//i.test(p)) {
      remoteScripts.add(p);
      return;
    }
    entries.add(p.replace(/^\.\//, ''));
  };
  const pushHtml = (p) => {
    if (typeof p === 'string') htmlFiles.add(p.replace(/^\.\//, ''));
  };

  if (manifest.background) {
    if (typeof manifest.background.service_worker === 'string') {
      pushJs(manifest.background.service_worker);
    }
    if (Array.isArray(manifest.background.scripts)) {
      manifest.background.scripts.forEach(pushJs);
    }
    // MV2 的后台页:整页都是 HTML,里面的 <script src> 也得跟着进来
    if (typeof manifest.background.page === 'string') {
      pushHtml(manifest.background.page);
    }
  }
  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts.forEach((cs) => {
      if (Array.isArray(cs.js)) cs.js.forEach(pushJs);
    });
  }

  // 所有"会弹出/展示一个 HTML 页面"的字段都要收集。
  // 少收一个,那个页面里的 <script src> 就不会被打包,
  // 产物里 HTML 还在、JS 没了 —— 表现就是"装上了但点开没反应",
  // 或者被 harden 自检直接以 404 拦下(连包都打不出来)。
  const popupHosts = [
    'action', // MV3
    'browser_action', // MV2 / Firefox
    'page_action', // MV2
  ];
  for (const key of popupHosts) {
    const host = manifest[key];
    if (host && typeof host.default_popup === 'string') pushHtml(host.default_popup);
  }
  if (typeof manifest.options_page === 'string') pushHtml(manifest.options_page);
  if (manifest.options_ui && typeof manifest.options_ui.page === 'string') {
    pushHtml(manifest.options_ui.page);
  }
  // 覆盖浏览器内置页(新标签页 / 历史 / 书签)
  if (manifest.chrome_url_overrides) {
    for (const v of Object.values(manifest.chrome_url_overrides)) pushHtml(v);
  }
  // Firefox 里同名字段也叫 chrome_url_overrides,但也有人写 browser_url_overrides
  if (manifest.browser_url_overrides) {
    for (const v of Object.values(manifest.browser_url_overrides)) pushHtml(v);
  }
  if (typeof manifest.devtools_page === 'string') pushHtml(manifest.devtools_page);
  if (manifest.side_panel && typeof manifest.side_panel.default_path === 'string') {
    pushHtml(manifest.side_panel.default_path);
  }
  if (manifest.sandbox && Array.isArray(manifest.sandbox.pages)) {
    manifest.sandbox.pages.forEach(pushHtml);
  }

  // 解析 html 里引用的 <script src>
  for (const html of htmlFiles) {
    const full = path.join(srcDir, html);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, 'utf8');
    const re = /<script[^>]+src=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(content))) {
      pushJs(m[1]);
    }
  }

  return {
    entries: [...entries],
    htmlFiles: [...htmlFiles],
    remoteScripts: [...remoteScripts],
  };
}

function load(configPath, overrides = {}, opts = {}) {
  const requireEntries = opts.requireEntries !== false; // harden 需要入口,verify 不需要

  let fileCfg = {};
  if (configPath && fs.existsSync(configPath)) {
    try {
      fileCfg = require(path.resolve(configPath)) || {};
    } catch (e) {
      console.warn(`[config] 读取配置文件 ${configPath} 失败,使用默认: ${e.message}`);
    }
  }

  const cfg = { ...DEFAULTS, ...fileCfg };

  // 覆盖
  if (overrides.srcDir) cfg.srcDir = overrides.srcDir;
  if (overrides.outDir) cfg.outDir = overrides.outDir;
  if (overrides.mangleProps !== undefined) cfg.mangleProps = overrides.mangleProps;
  if (overrides.wasm !== undefined) cfg.wasm = overrides.wasm;
  if (overrides.wasmCore) cfg.wasmCore = overrides.wasmCore;

  // 解析为绝对路径(仅当提供了才解析)
  if (cfg.srcDir) cfg.srcDir = path.resolve(cfg.srcDir);
  if (cfg.outDir) cfg.outDir = path.resolve(cfg.outDir);

  // 探测入口(仅当存在源码目录与 manifest)
  let detected = { entries: [], htmlFiles: [], remoteScripts: [] };
  if (cfg.srcDir) {
    const manifestPath = path.join(cfg.srcDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      detected = detectEntries(manifestPath, cfg.srcDir);
    }
  }
  if (!cfg.entries || cfg.entries.length === 0) {
    cfg.entries = detected.entries;
  } else {
    cfg.entries = cfg.entries.map((e) => e.replace(/^\.\//, ''));
  }
  cfg.htmlFiles = detected.htmlFiles;
  cfg.remoteScripts = detected.remoteScripts;

  if (requireEntries) {
    if (cfg.srcDir && !fs.existsSync(cfg.srcDir)) {
      throw new Error(`源码目录不存在: ${cfg.srcDir}`);
    }
    if (!cfg.entries.length) {
      const mp = cfg.srcDir ? path.join(cfg.srcDir, 'manifest.json') : 'manifest.json';
      throw new Error(
        `未探测到任何入口 js。请检查 ${mp} 或在配置里显式指定 entries。`
      );
    }
  } else if (!cfg.outDir) {
    throw new Error('verify 需要指定输出目录(--dir)。');
  }

  return cfg;
}

module.exports = { load, detectEntries, DEFAULTS };
