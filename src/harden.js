'use strict';

const path = require('path');
const fs = require('fs');

let esbuild, terser;

function lazyLoad() {
  if (!esbuild) {
    esbuild = require('esbuild');
  }
  if (!terser) {
    terser = require('terser');
  }
}

/**
 * 把 srcDir 下的静态资源(manifest、html、css、图片、json、wasm 等)原样拷到 outDir。
 * 刻意跳过 .js —— 所有 JS 都由 esbuild 打包压缩后产出,避免混入未压缩的副本。
 */
function copyAssets(srcDir, outDir, ignore) {
  fs.mkdirSync(outDir, { recursive: true });
  const ig = new Set(ignore || []);
  function walk(from, to) {
    for (const name of fs.readdirSync(from)) {
      if (ig.has(name)) continue;
      if (name.endsWith('.js')) continue; // JS 全部交由 esbuild 处理
      // TypeScript 源码同样不能进产物:
      // 尤其 core.ts —— 它是用户要"下沉"进 core.wasm 的核心逻辑,
      // 如果和编译后的 wasm 一起打包发出去,人家直接读 .ts 就行,等于白下沉。
      if (name.endsWith('.ts')) continue;
      const f = path.join(from, name);
      const t = path.join(to, name);
      const st = fs.statSync(f);
      if (st.isDirectory()) {
        walk(f, t);
      } else {
        fs.mkdirSync(path.dirname(t), { recursive: true });
        fs.copyFileSync(f, t);
      }
    }
  }
  walk(srcDir, outDir);
}

/**
 * 压缩 HTML 里的内联 <script>(即不带 src 的那些)。
 *
 * 为什么要单独做:copyAssets 原样拷贝 HTML,而 esbuild 只处理 entries 里的 .js,
 * 结果内联代码完全裸奔——既不压缩(防抄形同虚设),verify 也扫不到
 * (collectJs 只收集 .js 文件)。这是两个功能的共同盲区。
 *
 * 非 JS 类型(如 application/json、text/template)一律原样保留,避免改坏模板。
 * 压缩失败时也原样保留:宁可不压,也不能产出坏代码。
 */
async function minifyInlineScripts(cfg) {
  const htmls = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      if (fs.statSync(f).isDirectory()) walk(f);
      else if (/\.html?$/i.test(n)) htmls.push(f);
    }
  })(cfg.outDir);

  const re = /(<script(?![^>]*\bsrc\s*=)([^>]*)>)([\s\S]*?)(<\/script>)/gi;
  let count = 0;
  let saved = 0;

  for (const html of htmls) {
    const src = fs.readFileSync(html, 'utf8');
    let out = '';
    let last = 0;
    let changed = false;
    let m;
    while ((m = re.exec(src))) {
      const [full, open, attrs, code, close] = m;
      const type = (attrs.match(/type\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
      const isJs =
        !type ||
        /^(text|application)\/(javascript|ecmascript)$/i.test(type) ||
        /^module$/i.test(type);

      out += src.slice(last, m.index);
      if (!isJs || !code.trim()) {
        out += full;
      } else {
        try {
          const r = await esbuild.transform(code, {
            loader: 'js',
            minify: true,
            target: 'chrome100',
            charset: 'utf8',
            // type="module" 的内联脚本自带私有作用域,可以放心做标识符改名;
            // 普通 <script> 的顶层变量是全局的,改名会破坏跨脚本引用,所以不指定 format。
            ...(/^module$/i.test(type) ? { format: 'esm' } : {}),
            ...(cfg.dropConsole ? { drop: ['console', 'debugger'] } : {}),
            ...(cfg.stripComments ? { legalComments: 'none' } : {}),
          });
          const min = r.code.trim();
          out += open + min + close;
          count++;
          saved += code.length - min.length;
          changed = true;
        } catch (e) {
          console.warn(
            `[harden] 内联脚本压缩失败(${path.relative(cfg.outDir, html)}):` +
              `${e.message},已原样保留`
          );
          out += full;
        }
      }
      last = m.index + full.length;
    }
    out += src.slice(last);
    if (changed) fs.writeFileSync(html, out, 'utf8');
  }

  if (count) {
    console.log(`[harden] 内联脚本:压缩 ${count} 段,减少 ${saved} 字节`);
  }
  return count;
}

/**
 * 分类入口:哪些应按 ESM 打包(被 HTML 以 <script type="module"> 引用的),
 * 其余按 IIFE 打包(background service_worker / content_scripts / 普通 <script>)。
 * 原因:浏览器会按 HTML 标签的 type 加载脚本,IIFE 文件被当 module 加载会静默失败,
 * 导致弹窗/页面"点了没反应"。这是之前功能失效的主因。
 */
function classifyEntries(entries, srcDir) {
  const esm = new Set();
  const htmls = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f);
      else if (n.endsWith('.html')) htmls.push(f);
    }
  })(srcDir);
  for (const h of htmls) {
    const content = fs.readFileSync(h, 'utf8');
    const re = /<script([^>]*?)\bsrc=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(content))) {
      const attrs = m[1].toLowerCase();
      const src = m[2].replace(/^\.\//, '');
      if (/\btype\s*=\s*["']module["']/.test(attrs)) esm.add(src);
    }
  }
  return {
    iife: entries.filter((e) => !esm.has(e)),
    esm: entries.filter((e) => esm.has(e)),
  };
}

/**
 * 打包后自检:遍历产物目录里每个 HTML,确认其中 <script src="..."> 引用的
 * 脚本在产物中真实存在。若有 404 风险(典型:esbuild 把子目录扁平化),直接抛错,
 * 避免产出"装上去点了没反应"的残包。
 */
function selfCheckReferencedScripts(cfg) {
  const htmls = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f);
      else if (n.endsWith('.html')) htmls.push(f);
    }
  })(cfg.outDir);

  let missing = [];
  for (const h of htmls) {
    const content = fs.readFileSync(h, 'utf8');
    const re = /<script([^>]*?)\bsrc=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(content))) {
      const src = m[2].replace(/^\.\//, '');
      const target = path.resolve(cfg.outDir, src);
      if (!fs.existsSync(target)) {
        missing.push(`${path.relative(cfg.outDir, h)} -> ${src} (缺失)`);
      }
    }
  }
  if (missing.length) {
    throw new Error(
      '[harden] 自检失败:以下 HTML 引用的脚本在产物中不存在(会 404):\n  ' +
      missing.join('\n  ') +
      '\n请检查 esbuild 的 outbase 是否正确保留了子目录结构。'
    );
  }
  console.log('[harden] 自检通过:HTML 引用的脚本在产物中均存在。');
}

/**
 * 安全兜底:扫描产物,凡是路径命中敏感特征(如 .wrangler/、wrangler-account.json)
 * 一律视为红线 —— 这类文件含云端账号 / 凭据,随扩展发布等于把账号交出去。
 * 即使 ignore 配漏了,这一层也会把住最后一道关。
 */
function assertNoSensitiveFiles(cfg) {
  const patterns = cfg.sensitivePatterns || [];
  if (!patterns.length) return;
  const found = [];
  (function walk(d, rel) {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      const r = rel ? rel + '/' + n : n;
      if (fs.statSync(f).isDirectory()) walk(f, r);
      else if (patterns.some((p) => p.test('/' + r) || p.test(f))) found.push(r);
    }
  })(cfg.outDir, '');

  if (!found.length) {
    console.log('[harden] 安全检查通过:产物中无账号 / 凭据类敏感文件。');
    return;
  }
  const msg =
    '[harden] 安全检查失败 —— 产物中检出可能含账号 / 凭据的敏感文件:\n  ' +
    found.join('\n  ') +
    '\n这些文件绝不能随扩展发布。请把它们加入 ignore 排除后重新打包。';
  if (cfg.onSensitive === 'warn') {
    console.warn('⚠️  ' + msg);
    return;
  }
  throw new Error(msg);
}

/**
 * 检测"跨文件共享的全局变量"。
 *
 * 每个入口会被 esbuild 打包成独立 IIFE,顶层变量不再是全局;若在自身文件内
 * 又没有引用,还会被 tree-shaking 直接删掉 —— 另一个入口再调用就是
 * ReferenceError。典型表现就是"压缩后插件点了没反应"。
 * 这里在打包前提前找出来,并把修复办法直接告诉你。
 */
function detectCrossFileGlobals(cfg) {
  const entries = cfg.entries || [];
  const contents = new Map();
  const decls = new Map();
  for (const e of entries) {
    const f = path.join(cfg.srcDir, e);
    if (!fs.existsSync(f)) continue;
    const code = fs.readFileSync(f, 'utf8');
    contents.set(e, code);
    const re = /^(?:var|let|const|function|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(code))) {
      if (!decls.has(m[1])) decls.set(m[1], e);
    }
  }
  const esc = (s) => s.replace(/\$/g, '\\$');
  const risks = [];
  for (const [name, owner] of decls) {
    const ownerCode = contents.get(owner) || '';
    // 已经挂到 window / globalThis 的,可以跨 IIFE 访问,安全
    const exported = new RegExp(
      '(?:window|globalThis|self)\\s*\\.\\s*' + esc(name) + '\\s*='
    ).test(ownerCode);
    if (exported) continue;
    for (const [e, code] of contents) {
      if (e === owner) continue;
      // 边界用 lookbehind/lookahead,不用 \b。
      //
      // 为什么:\w 是 [A-Za-z0-9_],**不包含 `$`**,而 `$` 明明是合法的 JS 标识符
      // 字符。用 \b 会两头出错:
      //   漏检 —— `a + $MAX`、行首 `$MAX`、`window.$MAX` 里 `$MAX` 前面是空格/`(`,
      //          \b 要求"一边是词字符一边不是",两边都不是词字符时它不成立 → 匹配不到;
      //   误报 —— `foo$MAX` 里 \b 在 o(词字符)和 $(非词字符)之间**成立**,
      //          于是把 `$MAX` 误当成一个独立变量(其实它是 `foo$MAX` 的一部分)。
      // 把 `$` 也算进"标识符字符"(`[\w$]`)两侧都不许相邻,才是对的。
      //
      // 注意 esc(name) 仍要保留:它负责把名字里的 `$` 转成字面 `\$`(否则 $ 会被
      // 当成行尾锚点),跟边界判断是两件事,不能因为有了 lookbehind 就删掉。
      if (new RegExp('(?<![\\w$])' + esc(name) + '(?![\\w$])').test(code)) {
        risks.push({ name, owner, usedIn: e });
        break;
      }
    }
  }
  return risks;
}

/**
 * 列出源码里存在、但没有进入打包的 .js。
 * 以前是静默跳过,丢了什么用户完全不知道;现在明确列出来供人工确认
 * (比如后端的 worker/ 本就不该进包,扫一眼就能确认)。
 */
function reportUnbundledJs(cfg) {
  const ignore = new Set(cfg.ignore || []);
  const all = [];
  (function walk(d, rel) {
    for (const n of fs.readdirSync(d)) {
      if (ignore.has(n)) continue;
      const f = path.join(d, n);
      const r = rel ? rel + '/' + n : n;
      if (fs.statSync(f).isDirectory()) walk(f, r);
      else if (n.endsWith('.js')) all.push(r);
    }
  })(cfg.srcDir, '');
  const bundled = new Set(cfg.entries || []);
  return all.filter((f) => !bundled.has(f));
}

function runEsbuild(entries, srcDir, outDir, format, cfg) {
  if (!entries.length) return;
  const { execFileSync } = require('child_process');
  const esbuildBin = require.resolve('esbuild/bin/esbuild');
  const entryPoints = entries.map((e) => path.join(srcDir, e));
  const args = [
    ...entryPoints,
    '--bundle',
    '--outdir=' + outDir,
    // 关键:显式指定 outbase=srcDir,保留入口的相对子目录结构(如 js/)。
    // 否则 esbuild 默认取所有入口的公共父目录(如 .../js/)作为 outbase,
    // 会把 "js/locale.js" 扁平输出成 "locale.js",导致 HTML 引用的
    // "js/locale.js" 404 —— 表现就是"打包后点了没反应"。
    '--outbase=' + srcDir,
    '--format=' + format,
    '--target=chrome100',
    '--platform=browser',
    '--minify',
    '--tree-shaking=true',
    // 保留 UTF-8 原字符(中文等),避免 esbuild 默认把非 ASCII 转成 \uXXXX
    // 转义导致体积膨胀(中文插件尤其明显)。
    '--charset=utf8',
  ];
  if (cfg.dropConsole) {
    args.push('--drop:console', '--drop:debugger');
  }
  if (cfg.stripComments) {
    args.push('--legal-comments=none');
  }
  execFileSync(process.execPath, [esbuildBin, ...args], { stdio: 'inherit' });
  console.log(`[harden] esbuild 压缩完成(${format}, ${entries.length} 个入口)`);
}

async function run(cfg) {
  lazyLoad();

  console.log(`[harden] 源码目录: ${cfg.srcDir}`);
  console.log(`[harden] 输出目录: ${cfg.outDir}`);
  console.log(`[harden] 入口 js (${cfg.entries.length}): ${cfg.entries.join(', ')}`);

  // 0) 打包前告警:HTML 引用的远程脚本(不是本地文件,且 MV3 禁止远程代码)
  if (cfg.remoteScripts && cfg.remoteScripts.length) {
    console.warn(
      '\n[harden] ⚠️  检测到远程脚本引用(不是本地文件,已跳过,不参与打包):'
    );
    for (const u of cfg.remoteScripts) console.warn('    ' + u);
    console.warn(
      '    MV3 不允许加载远程代码,请把这些库下载到本地再引用,否则扩展会加载失败。\n'
    );
  }

  // 0.5) 打包前告警:跨文件共享的全局变量会被 IIFE 隔离 / tree-shaking 删除
  const globalRisks = detectCrossFileGlobals(cfg);
  if (globalRisks.length) {
    console.warn(
      `\n[harden] ⚠️  跨文件全局变量风险 (${globalRisks.length} 处) —— 压缩后可能直接报错:`
    );
    for (const r of globalRisks) {
      console.warn(`    ${r.name}   在 ${r.owner} 定义, ${r.usedIn} 使用`);
    }
    console.warn(
      '    原因:每个入口被打包成独立 IIFE,顶层变量不再是全局;且在自身文件内'
    );
    console.warn(
      '          没有引用时会被删除 -> 另一入口调用时报错(表现:点了没反应)。'
    );
    console.warn(
      '    修复:在定义方末尾挂到全局,例如 window.X = X; 或把这些文件合并成一个入口。\n'
    );
  }

  // 0.5) 清空输出目录:避免上一轮的残留文件混进本次产物(脏构建)。
  //      安全护栏:outDir 与 srcDir 相同、或 srcDir 在 outDir 内部时绝不清理,
  //      否则会把源码本身删掉。
  //      两点注意:
  //      ① 空目录直接跳过 —— 新建的 outDir 本来就是空的,没必要白删一遍;
  //      ② 删除失败不能让整次打包失败 —— 某些安全软件/沙箱会拦截批量删除,
  //         这里只告警并继续,顶多产物里混入上次的残留,不该整个打包挂掉。
  if (cfg.cleanOutDir !== false) {
    const srcAbs = path.resolve(cfg.srcDir);
    const outAbs = path.resolve(cfg.outDir);
    const dangerous = outAbs === srcAbs || srcAbs.startsWith(outAbs + path.sep);
    if (dangerous) {
      console.warn('[harden] 跳过清空输出目录:输出目录与源码目录重合,避免误删源码。');
    } else if (fs.existsSync(outAbs) && fs.readdirSync(outAbs).length > 0) {
      try {
        fs.rmSync(outAbs, { recursive: true, force: true });
        console.log(`[harden] 已清空输出目录: ${outAbs}`);
      } catch (e) {
        console.warn(
          `[harden] 清空输出目录失败(已跳过并继续打包): ${outAbs}\n  ${e.message}\n` +
            '  提示:产物里可能混入上次的残留文件,建议手动删除该目录后重试。'
        );
      }
    }
  }

  // 1) 先拷静态资源
  copyAssets(cfg.srcDir, cfg.outDir, cfg.ignore);

  // 1.5) 压缩 HTML 里的内联 <script>
  //      之前这块完全裸奔:既不压缩,verify 也扫不到(collectJs 只收 .js)。
  await minifyInlineScripts(cfg);

  // 2) esbuild 激进压缩(合规核心手段)
  //    按脚本类型分流:module -> esm,其余 -> iife
  const groups = classifyEntries(cfg.entries, cfg.srcDir);
  if (groups.esm.length) {
    console.log(`[harden] 检测到 ESM(module)脚本: ${groups.esm.join(', ')}`);
  }
  if (groups.iife.length) {
    console.log(`[harden] 普通脚本(IIFE): ${groups.iife.join(', ')}`);
  }
  runEsbuild(groups.iife, cfg.srcDir, cfg.outDir, 'iife', cfg);
  runEsbuild(groups.esm, cfg.srcDir, cfg.outDir, 'esm', cfg);

  // 2.5) 打包后自检:HTML 里引用的每个 <script src> 在产物中必须存在。
  // 拦截"路径被扁平化导致 404"这类问题(表现:装上去点了没反应)。
  selfCheckReferencedScripts(cfg);

  // 2.6) 安全兜底:产物里绝不能出现账号 / 凭据类敏感文件
  assertNoSensitiveFiles(cfg);

  // 2.7) 列出没参与打包的 js,供人工确认(不再"丢了也不知道")
  const unbundled = reportUnbundledJs(cfg);
  if (unbundled.length) {
    console.log(`[harden] 未参与打包的 js (${unbundled.length} 个) —— 请确认是否有意排除:`);
    for (const f of unbundled) console.log('    ' + f);
    console.log('    (若其中有扩展真正需要的,请加进 entries 或在 HTML 里引用它)');
  }

  // 3) 可选:terser 属性名改名(更激进,需谨慎)
  if (cfg.mangleProps) {
    console.log('[harden] 额外执行 terser 属性名改名 (--mangle-props)');
    const outputs = cfg.entries.map((e) => path.join(cfg.outDir, e));
    // 关键:所有文件共享同一份 nameCache。
    // 否则每个文件各改各的,同一个属性会被改成不同的短名
    // (popup 发出 {o:...}、background 读 m) -> 跨脚本通信字段直接对不上。
    const nameCache = {};
    for (const outFile of outputs) {
      if (!fs.existsSync(outFile)) continue;
      const code = fs.readFileSync(outFile, 'utf8');
      // 仅做属性名改名,不动压缩(压缩已由 esbuild 完成)
      const mangled = await terser.minify(code, {
        compress: false,
        mangle: {
          properties: {
            reserved: cfg.reservedProps,
            // keep_quoted: 'strict' —— 只要某个属性在代码里以字符串形式出现过
            // ({"type": 1} 或 obj["type"]),就整个不改名。
            // 不加这条的话,跨边界的"契约字段"(chrome.runtime.sendMessage 的键、
            // chrome.storage 里存的对象、postMessage 的字段)会被改名,
            // 而动态访问 obj[key] 又不改名 —— 两边对不上,通信直接断。
            keep_quoted: 'strict',
          },
        },
        nameCache,
      });
      if (mangled.error) {
        console.warn(`[harden] 属性改名跳过 ${outFile}: ${mangled.error}`);
        continue;
      }
      fs.writeFileSync(outFile, mangled.code);
    }
    console.log('[harden] 属性改名完成(注意:请务必用 verify 兜底,确认未破坏外部 API)');
  }

  // 4) 统计体积
  const sizes = cfg.entries.map((e) => {
    const f = path.join(cfg.outDir, e);
    const min = fs.existsSync(f) ? fs.statSync(f).size : 0;
    const src = path.join(cfg.srcDir, e);
    const org = fs.existsSync(src) ? fs.statSync(src).size : 0;
    return { e, org, min };
  });

  console.log('\n[harden] 体积对比:');
  for (const s of sizes) {
    const pct = s.org ? Math.round((1 - s.min / s.org) * 100) : 0;
    console.log(
      `  ${s.e.padEnd(20)} ${s.org}B -> ${s.min}B  (减小 ${pct}%)`
    );
  }
  console.log(`\n[harden] 完成。加固产物在: ${cfg.outDir}`);
  console.log('[harden] 下一步:运行 `extshield verify` 检查是否踩审核红线。\n');
}

// detectCrossFileGlobals 一并导出,供回归测试直接锁定"$ 前缀变量"的边界行为
module.exports = { run, detectCrossFileGlobals };
