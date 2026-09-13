'use strict';
/* extshield GUI 的轻量 i18n —— 不依赖任何构建步骤，浏览器直接跑。
 *
 * 语言来源优先级：
 *   1) URL 上的 ?lang= 参数（zh / en）
 *   2) localStorage 里上次选择的语言
 *   3) 浏览器语言（navigator.language，zh 开头 → 中文，其余 → 英文）
 *   4) 兜底：英文（本工具面向 npm / 国际开发者，英文是安全默认；
 *      中文用户由第 3 步自动命中，无需手动切换）
 *
 * 用法：
 *   <h2 data-i18n="step1.title">…</h2>          ← 纯文本，用 textContent 填
 *   <h2 data-i18n-html="step2.wasm.title">…</h2> ← 含 <b>/<span> 的，用 innerHTML 填
 *   <html data-i18n-title="doc.title">           ← 页面标题
 *   <button data-lang-btn="en">EN</button>       ← 语言切换按钮（自动绑定）
 *   I18N.t('folder.selected', { n: 3 })          ← JS 里取值，{n} 为占位符
 */
(function (global) {
  const STORAGE_KEY = 'extshield.lang';
  const SUPPORTED = ['zh', 'en'];
  // 兜底英文:中文用户由 navigator.language 自动命中,其余一律给英文
  const FALLBACK = 'en';

  const DICT = {
    zh: {
      // ── 头部 / 语言切换 ──
      'doc.title': 'extshield · 扩展压缩合规打包器',
      'hero.title': 'extshield 可视化打包器',
      'hero.sub': '选插件文件夹 → 选保护方式 → 一键合规打包。只做压缩与 WASM 下沉,不做被商店禁止的混淆。',
      'lang.aria': '界面语言',

      // ── 步骤 1 ──
      'step1.title': '选择插件文件夹',
      'step1.pick': '点击选择扩展根目录(含 manifest.json)',

      // ── 步骤 2 ──
      'step2.title': '选择保护方式',
      'step2.hint': '二选一',
      'step2.minify.title': '激进压缩 (Minify)',
      'step2.minify.desc': 'esbuild 去空白/改名/去注释/去 console。合规,逆向需费力解读。轻量快速,是所有模式的基础。',
      'step2.wasm.title': '激进压缩 + WASM 下沉 <span class="rec">推荐</span>',
      'step2.wasm.desc': '在压缩基础上,把核心逻辑编译成 WebAssembly 二进制,逆向需反汇编。合规,且复刻门槛更高。wasm 以 base64 内联进 JS,不产出可单独下载的 wasm 文件。',
      'step2.wasm.note': '把核心算法写成 core.ts 放进插件根目录即可现场编译;不写也可以 —— 工具会自动扫描并筛选适合下沉的纯计算函数。若未发现符合条件的函数,将明确说明。',
      'step2.mangle': '属性名也改名(更激进,可能破坏外部 API)——压缩阶段生效',

      // ── 步骤 3 ──
      'step3.title': '开始打包',
      'step3.hint': '点击后会先弹出「另存为」窗口,你选好保存位置和文件名,再开始打包。',
      'step3.btn': '开始打包',

      // ── 步骤 4 ──
      'step4.title': '合规扫描报告',
      'step4.hint': '打包后自动生成',
      'step4.empty': '打包完成后,这里会显示产物是否触碰 Chrome Web Store 审核红线(高危 / 中等 / 提示)。',

      // ── 页脚 ──
      'foot.note': '合规提示:本工具刻意不做字符串加密 / 控制流平坦化 / eval 解密代码——易触发 Chrome Web Store 审核拒绝。只做服务端下沉或 WASM。',

      // ── 报告：静态段 ──
      'report.nojs.title': '⚠️ 合规扫描未执行',
      'report.nojs.body': '产物里没有找到 .js 文件',
      'report.passed': '✅ 合规扫描通过',
      'report.failed': '❌ 合规扫描发现风险',
      'report.summary': '扫描 {files} 个 js{inlineMore} · 高危 <b class="{hcls}">{high}</b> / 中等 <b class="{mcls}">{medium}</b> / 提示 {info}',
      'report.inlineMore': ' + {n} 段内联脚本',
      'report.sev.high': '高危',
      'report.sev.medium': '中等',
      'report.sev.info': '提示',
      'report.clean': '未检测到会触发商店审核红线的混淆特征,可以打包上传。',
      'report.lineRef': ' (行 {n})',

      // ── 报告：WASM 来源 ──
      'report.wasm.line': 'WASM 下沉:{src}',
      'report.wasm.auto': '🤖 <b>自动下沉</b>:从你的代码中扫描出 {n} 个纯计算函数,已编译成 wasm 并内联(原实现已替换)',
      'report.wasm.userCore': '✅ 来自你自己的 <b>core.ts</b>(已编译进 core.wasm)',
      'report.wasm.compileFailed': '⚠️ 你的 core.ts <b>编译失败</b>,本次没有下沉任何函数',
      'report.wasm.autoFailed': '⚠️ <b>自动下沉失败</b>,本次没有下沉任何函数',
      'report.wasm.none': '⚠️ <b>本次没有下沉任何函数</b>:共扫描 {n} 个,均不符合下沉条件(涉及浏览器 / 扩展 API,或非纯数值运算)。<b>产物中不含 wasm</b>,你的逻辑仍保留在 JS 中,由压缩与合规扫描提供保护。如需下沉,可将核心算法拆分为仅做数值计算的独立函数,或编写 core.ts 放入插件根目录。',
      'report.wasm.sunkLabel': ' · 已下沉:{names}',
      'report.wasm.exportsLabel': ' · 导出:{names}',
      'report.wasm.skippedMore': '<br><span style="opacity:.75">另有 {n} 个函数未下沉(涉及浏览器 / 扩展 API 或非数值运算):{names}{etc}</span>',
      'report.wasm.etc': ' 等',

      // ── 文件夹选择 ──
      'folder.selected': '已选择 {n} 个文件',
      'folder.loaded': '已载入 <b>{n}</b> 个文件。',
      'folder.entries': ' 检测到入口文件: <b>{list}</b>。',
      'folder.none': '无',
      'folder.parseFailed': ' (manifest.json 解析失败)',
      'folder.noManifest': ' <b style="color:#b91c1c">未找到 manifest.json</b>,将无法打包。',

      // ── 打包 ──
      'picker.zipDesc': 'ZIP 压缩包',
      'pack.noMethod': '❌ 请选择一种保护方式。',
      'pack.canceled': '已取消,没有打包。',
      'pack.running': '<span class="spin"></span>正在打包({mode})…',
      'pack.savingTo': '保存到:{name}',
      'pack.savedTo': '✅ 打包完成,已保存到 <b>{name}</b>。解压后即是可上传商店的扩展目录。',
      'pack.downloaded': '✅ 打包完成,已下载 <b>{name}</b>。当前浏览器不支持选位置弹窗,文件进了浏览器默认下载目录(Chrome 可在设置里打开「下载前询问每个文件的保存位置」)。',
      'pack.serverError': '服务端错误 {code}',
      'pack.failed': '❌ 打包失败:{msg}',
    },

    en: {
      // ── Header / language switch ──
      'doc.title': 'extshield · Extension Minifier & Compliance Packer',
      'hero.title': 'extshield Visual Packer',
      'hero.sub': 'Pick the extension folder → choose a protection mode → pack it compliantly in one click. Minification and WASM sinking only — no store-banned obfuscation.',
      'lang.aria': 'Interface language',

      // ── Step 1 ──
      'step1.title': 'Choose the extension folder',
      'step1.pick': 'Click to select the extension root folder (containing manifest.json)',

      // ── Step 2 ──
      'step2.title': 'Choose a protection mode',
      'step2.hint': 'pick one',
      'step2.minify.title': 'Aggressive minify',
      'step2.minify.desc': 'esbuild strips whitespace, renames identifiers, drops comments and console calls. Compliant; reverse engineering still takes real effort. Fast and lightweight — the basis of every mode.',
      'step2.wasm.title': 'Minify + WASM sinking <span class="rec">Recommended</span>',
      'step2.wasm.desc': 'On top of minification, core logic is compiled to a WebAssembly binary, which has to be disassembled to be reversed. Compliant, and much harder to replicate. The wasm is inlined into JS as base64 — no separately downloadable wasm file is produced.',
      'step2.wasm.note': 'Write your core algorithm as core.ts in the extension root and it is compiled on the spot; optional — the tool also scans for and selects pure computation functions suitable for sinking. If no function qualifies, the tool will state this explicitly.',
      'step2.mangle': 'Also mangle property names (more aggressive; may break external APIs) — applied at the minify stage',

      // ── Step 3 ──
      'step3.title': 'Start packing',
      'step3.hint': 'Clicking opens a "Save as" dialog first — pick the location and filename, then packing begins.',
      'step3.btn': 'Start packing',

      // ── Step 4 ──
      'step4.title': 'Compliance scan report',
      'step4.hint': 'generated after packing',
      'step4.empty': 'Once packing finishes, this section shows whether the output touches any Chrome Web Store review red line (high / medium / info).',

      // ── Footer ──
      'foot.note': 'Compliance note: this tool deliberately avoids string encryption, control-flow flattening and eval-based decryption — they easily trigger Chrome Web Store rejections. Only server-side sinking or WASM is performed.',

      // ── Report: static ──
      'report.nojs.title': '⚠️ Compliance scan not run',
      'report.nojs.body': 'No .js file found in the output',
      'report.passed': '✅ Compliance scan passed',
      'report.failed': '❌ Compliance scan found risks',
      'report.summary': 'Scanned {files} js{inlineMore} · high <b class="{hcls}">{high}</b> / medium <b class="{mcls}">{medium}</b> / info {info}',
      'report.inlineMore': ' + {n} inline script(s)',
      'report.sev.high': 'high',
      'report.sev.medium': 'medium',
      'report.sev.info': 'info',
      'report.clean': 'No obfuscation pattern that would trigger a store review red line was detected — the package is ready to upload.',
      'report.lineRef': ' (line {n})',

      // ── Report: WASM source ──
      'report.wasm.line': 'WASM sinking: {src}',
      'report.wasm.auto': '🤖 <b>Auto-sunk</b>: found {n} pure computation function(s) in your code, compiled to wasm and inlined (original implementation replaced)',
      'report.wasm.userCore': '✅ From your own <b>core.ts</b> (compiled into core.wasm)',
      'report.wasm.compileFailed': '⚠️ Your core.ts <b>failed to compile</b> — no function was sunk this time',
      'report.wasm.autoFailed': '⚠️ <b>Auto-sink failed</b> — no function was sunk this time',
      'report.wasm.none': '⚠️ <b>No function was sunk this time</b>: scanned {n}, none meets the criteria for sinking (they touch browser / extension APIs, or are not pure numeric computation). <b>The package contains no wasm</b> — your logic remains in JS, protected by minification and the compliance scan. To sink code, split the core algorithm into standalone functions that perform numeric computation only, or write core.ts into the extension root.',
      'report.wasm.sunkLabel': ' · Sunk: {names}',
      'report.wasm.exportsLabel': ' · Exports: {names}',
      'report.wasm.skippedMore': '<br><span style="opacity:.75">{n} more function(s) were not sunk (they touch browser / extension APIs, or are not numeric): {names}{etc}</span>',
      'report.wasm.etc': ' …',

      // ── Folder picking ──
      'folder.selected': '{n} file(s) selected',
      'folder.loaded': 'Loaded <b>{n}</b> file(s).',
      'folder.entries': ' Entry files detected: <b>{list}</b>.',
      'folder.none': 'none',
      'folder.parseFailed': ' (failed to parse manifest.json)',
      'folder.noManifest': ' <b style="color:#b91c1c">manifest.json not found</b> — packing is unavailable.',

      // ── Packing ──
      'picker.zipDesc': 'ZIP archive',
      'pack.noMethod': '❌ Please choose a protection mode.',
      'pack.canceled': 'Canceled — nothing was packed.',
      'pack.running': '<span class="spin"></span>Packing ({mode})…',
      'pack.savingTo': 'Saving to: {name}',
      'pack.savedTo': '✅ Packing done, saved to <b>{name}</b>. Unzip it and you get the folder ready to upload.',
      'pack.downloaded': '✅ Packing done, downloaded <b>{name}</b>. This browser does not support the save-location dialog, so the file went to the default download folder (in Chrome you can enable "Ask where to save each file before downloading").',
      'pack.serverError': 'Server error {code}',
      'pack.failed': '❌ Packing failed: {msg}',
    },
  };

  // ── 语言判定 ──
  // 也支持 ?lang=en / ?lang=zh 强制指定（便于调试、或分享指定语言的界面）
  function fromQuery() {
    try {
      const v = new URLSearchParams(location.search).get('lang');
      if (v) {
        const s = v.toLowerCase();
        if (SUPPORTED.indexOf(s) >= 0) return s;
        if (s.indexOf('zh') === 0) return 'zh';
        if (s.indexOf('en') === 0) return 'en';
      }
    } catch (e) {
      /* 忽略解析失败 */
    }
    return null;
  }

  function detect() {
    const q = fromQuery();
    if (q) return q;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.indexOf(saved) >= 0) return saved;
    } catch (e) {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
    const nav = String((navigator && (navigator.language || navigator.userLanguage)) || '').toLowerCase();
    if (nav.indexOf('zh') === 0) return 'zh';
    if (nav) return 'en';
    return FALLBACK;
  }

  let lang = detect();
  const listeners = [];

  /** 取文案；params 用于替换 {name} 占位符。缺失的 key 原样返回，便于发现遗漏。 */
  function t(key, params) {
    const table = DICT[lang] || DICT[FALLBACK];
    let s = table[key];
    if (s == null) s = DICT[FALLBACK][key];
    if (s == null) return key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, (m, name) => (params[name] == null ? '' : String(params[name])));
    }
    return s;
  }

  /** 按 data-i18n / data-i18n-html 把整棵 DOM 的文案刷新一遍。 */
  function apply(root) {
    const scope = root || document;

    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    // data-i18n-attr="aria-label:key" 或 "placeholder:key1|title:key2" —— 翻译属性值
    scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.getAttribute('data-i18n-attr').split('|').forEach((pair) => {
        const i = pair.indexOf(':');
        if (i < 0) return;
        const attr = pair.slice(0, i).trim();
        const key = pair.slice(i + 1).trim();
        if (attr && key) el.setAttribute(attr, t(key));
      });
    });

    const titleKey = document.documentElement.getAttribute('data-i18n-title');
    if (titleKey) document.title = t(titleKey);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

    document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
      const active = btn.getAttribute('data-lang-btn') === lang;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  /** 切换语言：写 localStorage → 刷新静态文案 → 通知订阅者（用于重渲染动态区域）。 */
  function set(next) {
    if (SUPPORTED.indexOf(next) < 0 || next === lang) return;
    lang = next;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      /* 忽略写入失败 */
    }
    apply();
    listeners.forEach((fn) => {
      try {
        fn(lang);
      } catch (e) {
        console.error('[i18n] listener failed:', e);
      }
    });
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function init() {
    document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
      btn.addEventListener('click', () => set(btn.getAttribute('data-lang-btn')));
    });
    apply();
  }

  global.I18N = {
    get lang() {
      return lang;
    },
    t: t,
    apply: apply,
    set: set,
    onChange: onChange,
    supported: SUPPORTED.slice(),
  };

  // 脚本位于 </body> 之前，此时 DOM 已完整 —— 同步渲染，避免首屏闪一下另一种语言。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
