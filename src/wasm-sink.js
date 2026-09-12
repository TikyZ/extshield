'use strict';

/**
 * WASM 下沉编排(CLI 与 GUI 共用一套逻辑)
 *
 * 三种来源,优先级从高到低:
 *   1. user-core  你自己写的 core.ts(手动下沉,价值层由你掌控)
 *   2. auto       规则分析:扫源码 -> 挑纯计算函数 -> 自动生成 core.ts
 *                 -> 编译 -> base64 内联回 JS(同步替换,调用点不用改)
 *
 * 沉不下去就如实报 auto-empty / compile-failed / auto-failed,
 * **绝不拿内置示例 wasm 顶替** —— 那会让用户以为自己的核心逻辑已经进了
 * wasm,实际只是个无关 demo,比直接告诉他没沉成更糟(实测踩过)。
 *
 * 关键时序(踩过坑,别改顺序):
 *   prepare()  必须在 harden 之前跑 —— 因为它是改「源码」的:
 *              auto 模式会重写 .js,user-core 模式会把 core.wasm 放进源码目录,
 *              再由 harden 的 copyAssets 拷进产物。
 *   finalize() 必须在 harden 之后跑 —— harden 会清空输出目录,
 *              之前把 wasm-loader.js 写早了,直接被清掉,根本没进最终包。
 *
 * auto 模式为什么不需要 core.wasm / web_accessible_resources:
 *   wasm 以 base64 内联进 JS,用 new WebAssembly.Module() 同步实例化,
 *   不存在"运行时去 fetch 一个文件"这回事,自然也不用声明可访问资源。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const WASMGEN = require('./wasm-loader-gen');
const AUTOSINK = require('./auto-sink');
const MANUAL = require('./manual-sink');

const ROOT = path.join(__dirname, '..');
const TPL_DIR = path.join(ROOT, 'wasm-template');

/** 源码目录里是否自带 core.ts */
function hasUserCore(srcDir) {
  const p = path.join(srcDir, 'core.ts');
  return fs.existsSync(p) ? p : null;
}

/** Windows 下路径大小写不敏感,比较时统一小写 */
function pathKey(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * 找出「注入主世界(world: MAIN)」的 content script 文件(路径集合)。
 *
 * ⚠️ 这里区分得很细,因为两类 content script 的 CSP 完全不同。以下事实已核对
 * Chrome 官方文档(不是凭印象),别再搞错:
 *
 *   1. 默认的 content script 跑在**隔离世界(isolated world)**,它有**自己独立的 CSP**,
 *      而且 Chrome 给这个 CSP 的默认值里本来就带 'wasm-unsafe-eval':
 *        script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules'
 *                     chrome-extension://<扩展ID>/; object-src 'self';
 *      → 隔离世界里跑 WebAssembly 是**官方允许**的,跟网页 CSP 无关。
 *        所以这类 content script **不需要**排除,照常下沉。
 *
 *   2. 只有显式写了 "world": "MAIN" 的 content script 才会注入到**网页的主世界**,
 *      这时套用的是**网页自己的 CSP**:
 *        "When a content script is injected into the main world, the CSP of the page applies."
 *      → 严格 CSP 的站点会拦掉 WebAssembly,沉进去等于把功能打坏,
 *        而且是运行时才炸、很难排查。这类**必须**排除。
 *
 *   参考:https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
 *
 * 覆盖不到的地方:用 chrome.scripting.executeScript({world:'MAIN'}) 动态注入的脚本
 * 不写在 manifest 里,这里看不见,只能在 README 里提醒。
 */
function mainWorldContentScripts(srcDir) {
  const set = new Set();
  const mp = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(mp)) return set;
  let m;
  try {
    m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch {
    return set;
  }
  for (const cs of m.content_scripts || []) {
    if (!cs) continue;
    // world 缺省 = ISOLATED(隔离世界,自带放行 wasm 的 CSP),只有 MAIN 才要排除
    if (String(cs.world || '').toUpperCase() !== 'MAIN') continue;
    for (const js of cs.js || []) {
      if (typeof js !== 'string') continue;
      set.add(pathKey(path.join(srcDir, js.replace(/\\/g, '/').replace(/^\/+/, ''))));
    }
  }
  return set;
}

/**
 * 把源码复制一份到临时工作区。
 *
 * 为什么要复制:auto 模式是「就地重写 .js」的。CLI 的 srcDir 就是用户自己的
 * 工程目录,直接改等于把用户的源码改了(而且是不可逆的)。所以 CLI 一律先在
 * 临时区改,再拿临时区去打包,原始源码一行不动。
 */
function stageSource(srcDir, stageDir, ignore) {
  const ig = new Set(
    ignore || ['node_modules', '.git', '.svn', '.work', 'dist', 'sample-dist', '.wrangler']
  );
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  (function walk(from, to) {
    for (const name of fs.readdirSync(from)) {
      if (ig.has(name)) continue;
      const f = path.join(from, name);
      const t = path.join(to, name);
      const st = fs.statSync(f);
      if (st.isDirectory()) {
        fs.mkdirSync(t, { recursive: true });
        walk(f, t);
      } else {
        fs.copyFileSync(f, t);
      }
    }
  })(srcDir, stageDir);
  return stageDir;
}

/** 新建一次性工作目录(放生成的 core.ts / core.wasm,不进产物) */
function makeWorkDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'extshield-wasm-'));
}

/** 只保留这批候选真正用到的常量(候选里带着 AST 收集的 usesConsts,不用正则去猜) */
function pickConsts(consts, list) {
  if (!consts || !consts.size) return new Map();
  const out = new Map();
  for (const [n, v] of consts) {
    if (list.some((c) => c.usesConsts && c.usesConsts.has(n))) out.set(n, v);
  }
  return out;
}

/** 试着把一批候选编译成 wasm,失败只返回原因,不抛 */
async function tryCompile(list, consts, workDir, tag) {
  const ts = path.join(workDir, `${tag}.ts`);
  const wasm = path.join(workDir, `${tag}.wasm`);
  fs.writeFileSync(ts, AUTOSINK.toAssemblyScript(list, pickConsts(consts, list)), 'utf8');
  try {
    await AUTOSINK.compile(ts, wasm);
    return { ok: true, ts, wasm };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * 规则分析版自动下沉。
 *
 * 编译策略(能保则保):先整批编一次,成功就完事;失败了再逐个累加试,
 * 谁把编译搞崩就踢掉谁 —— 宁可少沉几个,也别因为一个函数编译不过
 * 就把其余本来能沉的全丢掉(整批失败以前是直接放弃整轮的)。
 */
async function autoSink(srcDir, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const scan = AUTOSINK.findCandidates(srcDir, { exclude: mainWorldContentScripts(srcDir) });
  const info = {
    source: 'auto',
    exports: [],
    sunk: [],
    skipped: scan.skipped || [],
    // 扫过的函数总数,报告里要能说清"看了多少个、一个都没看上"
    scanned: (scan.candidates || []).length + (scan.skipped || []).length,
  };
  if (!scan.candidates.length) {
    info.source = 'auto-empty';
    return info;
  }

  let list = scan.candidates;
  let res = await tryCompile(list, scan.consts, workDir, 'auto-core');
  if (!res.ok) {
    console.warn('[wasm] 整批编译失败,改为逐个试,能沉几个算几个:', res.err);
    const kept = [];
    for (const c of scan.candidates) {
      const r = await tryCompile(kept.concat([c]), scan.consts, workDir, 'try');
      if (r.ok) {
        kept.push(c);
      } else {
        info.skipped.push({
          name: c.name,
          file: path.basename(c.file),
          reason: '生成的 AssemblyScript 编译不过,已放弃下沉',
        });
      }
    }
    list = kept;
    if (!list.length) {
      info.source = 'auto-empty';
      return info;
    }
    res = await tryCompile(list, scan.consts, workDir, 'auto-core');
    if (!res.ok) {
      info.source = 'auto-failed';
      info.error = res.err;
      return info;
    }
  }

  info.sunk = AUTOSINK.rewriteWithInlineWasm(list, res.wasm);
  // 一个都没换成功(理论上不会)就别硬说是 auto
  if (!info.sunk.length) info.source = 'auto-empty';
  return info;
}

/**
 * harden 之前调用。
 * @param cfg  配置(srcDir 必须是「可写副本」——CLI 传 stage 目录,
 *             GUI 传自己的临时任务目录,两者都不会碰到用户原始源码)
 * @param opts { coreTs, workDir, fallbackTemplate }
 * @returns wasmInfo
 */
async function prepare(cfg, opts = {}) {
  const info = { enabled: true, source: null, exports: [], sunk: [], skipped: [], scanned: 0, warnings: [] };
  const workDir = opts.workDir || makeWorkDir();
  const coreTs = opts.coreTs || hasUserCore(cfg.srcDir);

  // 1) 用户自带 core.ts -> 编译 + 同步内联 + 按同名函数改写调用点
  if (coreTs) {
    try {
      const sigs = MANUAL.parseSignatures(fs.readFileSync(coreTs, 'utf8'));
      if (!sigs.length) {
        console.warn('[wasm] core.ts 里没解析到任何 export function,本次未下沉。');
        info.source = 'user-core-empty';
        return info;
      }
      const wasm = path.join(workDir, 'user-core.wasm');
      await MANUAL.compileWithRuntime(coreTs, wasm);
      const r = MANUAL.rewriteMatches(cfg.srcDir, sigs, wasm, {
        exclude: mainWorldContentScripts(cfg.srcDir),
      });
      info.exports = sigs.map((s) => s.name);
      info.sunk = r.sunk;
      info.warnings = r.warnings || [];
      if (!r.sunk.length) {
        // 编译成功但一个同名函数都没找到 —— 沉了等于没沉,必须说清楚,
        // 而不是让用户以为 core.wasm 已经保护了他的代码。
        console.warn(
          '[wasm] core.ts 导出 ' + info.exports.join(', ') +
            ',但源码里没有同名的函数,没有替换任何东西。'
        );
        console.warn('[wasm] 想让工具替你改写调用点,core.ts 里的函数名要和源码里的一致。');
        info.source = 'user-core-unused';
        return info;
      }
      info.source = 'user-core';
      return info;
    } catch (e) {
      console.warn('[wasm] 编译 core.ts 失败:', e.message);
      if (process.env.EXTSHIELD_DEBUG) console.warn(e.stack);
      // 不回退示例模板:让用户知道自己的 core.ts 没编译过,
      // 而不是拿一个能跑的 demo 把问题盖住。
      info.source = 'compile-failed';
      return info;
    }
  }

  // 2) 没带 core.ts -> 规则分析自动下沉
  try {
    const auto = await autoSink(cfg.srcDir, workDir);
    info.source = auto.source;
    info.sunk = auto.sunk;
    info.skipped = auto.skipped;
    info.scanned = auto.scanned;
    if (auto.source === 'auto-failed') {
      console.warn('[wasm] 自动下沉失败,本次未下沉任何代码:', auto.error || '编译未通过');
    }
    return info;
  } catch (e) {
    console.warn('[wasm] 自动下沉失败:', e.message);
    if (process.env.EXTSHIELD_DEBUG) console.warn(e.stack);
    info.source = 'auto-failed';
    return info;
  }
}

/** MV3 / MV2 的 web_accessible_resources 写法不一样,必须分流 */
function patchManifest(outDir) {
  const mp = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(mp)) return false;
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const isV3 = Number(m.manifest_version) === 3;
  m.web_accessible_resources = m.web_accessible_resources || [];

  if (isV3) {
    const has = m.web_accessible_resources.some(
      (e) => e && Array.isArray(e.resources) && e.resources.includes('core.wasm')
    );
    if (!has) {
      m.web_accessible_resources.push({
        resources: ['core.wasm'],
        matches: ['<all_urls>'],
      });
    }
  } else {
    // MV2 是平铺字符串,写成 MV3 的对象格式会被 Chrome 拒绝加载
    const has = m.web_accessible_resources.some(
      (e) => typeof e === 'string' && e === 'core.wasm'
    );
    if (!has) m.web_accessible_resources.push('core.wasm');
  }

  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return true;
}

/**
 * 给产物 manifest 放行 WebAssembly。
 *
 * 为什么必须做:MV3 扩展页默认 CSP 是 script-src 'self',而"编译 WebAssembly"
 * 被 CSP 当成代码求值 —— 于是内联进 popup / service worker 的 wasm 会被直接拦下:
 *   CompileError: ...violates the following CSP directive: "script-src 'self'"
 * 官方给的解法是显式加 'wasm-unsafe-eval'(它只放行 wasm,不放行 eval):
 *   "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" }
 * 注意 MV3 里 script-src 只允许 self / none / wasm-unsafe-eval,写 'unsafe-eval'
 * 会让扩展**直接安装失败**,所以绝不能图省事加它。
 * 参考:https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure
 */
function patchCsp(outDir) {
  const mp = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(mp)) return { ok: false, reason: '没有 manifest.json' };

  let m;
  try {
    m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'manifest.json 解析失败: ' + e.message };
  }

  if (Number(m.manifest_version) !== 3) {
    // MV2 里 wasm 要靠 'unsafe-eval',而 MV2 已被 Chrome 停用,不主动改,只提示。
    return { ok: false, reason: 'manifest_version 不是 3' };
  }

  const csp =
    m.content_security_policy && typeof m.content_security_policy === 'object'
      ? m.content_security_policy
      : {};
  const cur =
    typeof csp.extension_pages === 'string' && csp.extension_pages.trim()
      ? csp.extension_pages
      : "script-src 'self'; object-src 'self';";

  // 已经放行过(用户自己加过,或工具跑第二遍),不动。
  if (/\bwasm-unsafe-eval\b/.test(cur) || /\bunsafe-eval\b/.test(cur)) {
    return { ok: true, changed: false, policy: cur };
  }

  // 尽量保留用户原有配置,只在 script-src 后面追加一个来源。
  const next = /(^|;)\s*script-src\b/.test(cur)
    ? cur.replace(/(script-src[^;]*)/, (s) => s.replace(/\s*$/, '') + " 'wasm-unsafe-eval'")
    : "script-src 'self' 'wasm-unsafe-eval'; " + cur;

  m.content_security_policy = Object.assign(csp, { extension_pages: next });
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return { ok: true, changed: true, policy: next };
}

/**
 * 兜底警告:产物里**注入主世界**的 content script(如果有)含内联 wasm。
 *
 * 隔离世界的 content script 里带 wasm 是正常的 —— Chrome 给隔离世界的默认 CSP 本来就
 * 放行 'wasm-unsafe-eval',不警告。只有主世界的才会套用网页 CSP,严格站点会拦掉;
 * 而正常流程里这类文件已被 mainWorldContentScripts() 排除,这里还能命中就说明
 * 配置被绕过或文件被手工改过,值得提示。
 */
function warnContentScripts(outDir) {
  const mp = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(mp)) return [];
  let m;
  try {
    m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch {
    return [];
  }
  const hits = [];
  for (const cs of m.content_scripts || []) {
    if (!cs) continue;
    if (String(cs.world || '').toUpperCase() !== 'MAIN') continue;
    for (const js of cs.js || []) {
      const f = path.join(outDir, js);
      try {
        if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('__essW')) hits.push(js);
      } catch {
        /* 读不了就当没命中 */
      }
    }
  }
  if (hits.length) {
    console.warn(
      '[wasm] 注意:以下「注入主世界」的 content script 里也内联了 wasm —— ' + hits.join('、') + '\n' +
        '[wasm] 主世界套用的是网页自己的 CSP,严格站点会拦掉 WebAssembly。\n' +
        '[wasm] 建议改成默认(隔离世界)的 content script,或别在这类文件里放 wasm。'
    );
  }
  return hits;
}

/**
 * harden 之后调用:按产物里 core.wasm 的真实导出生成 loader + 改 manifest。
 * auto 模式走内联,这两步都不需要。
 */
function finalize(cfg, info) {
  if (!info || !info.enabled) return info;

  // 本次压根没沉进去的状态:产物里本来就不该有 wasm,
  // 直接说清楚,别再去检查 core.wasm 打一条让人误会的日志。
  const NOT_SUNK = ['auto-empty', 'auto-failed', 'compile-failed', 'user-core-empty', 'user-core-unused'];
  if (NOT_SUNK.includes(info.source)) {
    console.log(`[wasm] 本次没有沉入任何代码(${info.source}),按普通加固包处理。`);
    return info;
  }

  // 自动下沉和手动下沉现在都是"内联"的:wasm 直接编进 JS,
  // 产物里不会有 core.wasm,自然也不需要 loader 和 manifest 资源声明。
  if (info.source === 'auto' || info.source === 'user-core') {
    const who = info.source === 'auto' ? '自动下沉' : '手动下沉(core.ts)';
    console.log(
      `[wasm] ${who}完成,已内联 ${info.sunk.length} 个函数:` + (info.sunk.join(', ') || '(无)')
    );
    console.log('[wasm] wasm 已内联进 JS,无需单独的 core.wasm / 资源声明。');

    // 内联的 wasm 要能跑起来,必须让扩展页 CSP 放行 WebAssembly。
    const csp = patchCsp(cfg.outDir);
    info.csp = csp;
    if (csp.ok && csp.changed) {
      console.log('[wasm] 已给 manifest 加上 content_security_policy.extension_pages,放行 wasm-unsafe-eval。');
      console.log('[wasm]   -> ' + csp.policy);
    } else if (csp.ok && !csp.changed) {
      console.log('[wasm] manifest 里已有 CSP 放行 wasm,无需改动。');
    } else {
      console.warn(
        '[wasm] 没能在 manifest 里放行 WebAssembly(' + csp.reason + '),' +
          '内联 wasm 在扩展页里可能被 CSP 拦下。'
      );
    }
    info.contentScriptsWithWasm = warnContentScripts(cfg.outDir);
    return info;
  }

  const outWasm = path.join(cfg.outDir, 'core.wasm');
  if (!fs.existsSync(outWasm)) {
    console.warn('[wasm] 产物里没有 core.wasm,跳过生成 loader。');
    return info;
  }

  try {
    info.exports = WASMGEN.generateLoader(outWasm, path.join(cfg.outDir, 'wasm-loader.js'));
    console.log(`[wasm] 已生成 wasm-loader.js,导出: ${info.exports.join(', ') || '(无)'}`);
  } catch (e) {
    console.warn('[wasm] 生成 loader 失败,回退模板自带 loader:', e.message);
    const tplLoader = path.join(TPL_DIR, 'src', 'wasm-loader.js');
    if (fs.existsSync(tplLoader)) {
      fs.copyFileSync(tplLoader, path.join(cfg.outDir, 'wasm-loader.js'));
    }
  }

  if (patchManifest(cfg.outDir)) {
    console.log('[wasm] manifest 已声明 core.wasm 为可访问资源。');
  }
  return info;
}

module.exports = {
  hasUserCore,
  mainWorldContentScripts,
  stageSource,
  makeWorkDir,
  autoSink,
  patchManifest,
  patchCsp,
  warnContentScripts,
  prepare,
  finalize,
};
