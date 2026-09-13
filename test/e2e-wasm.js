'use strict';

/**
 * WASM 下沉端到端回归(GUI 处理链路)
 *
 * 跑: npm test
 *
 * 覆盖两条路:
 *   ① 自动下沉 —— 不提供 core.ts,工具按规则扫源码自己挑纯计算函数
 *   ② 手动下沉 —— 提供 core.ts,以用户的为准
 *
 * 断言的都是"踩过坑"的点:
 *   - 自动下沉产物里 wasm 内联、原 JS 实现消失
 *   - 手动下沉产物里 core.wasm + wasm-loader.js 都在,且 loader 按真实导出生成
 *   - 内联 base64 不能把合规扫描打成"中等风险"(verify 那边加了白名单)
 *   - core.ts 本身绝不能进发布包(以前会,等于白下沉)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// PORT=0:让测试里的服务监听随机端口,免得占着 4173
process.env.PORT = process.env.PORT || '0';
const { pack } = require('../gui/server');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const MANIFEST = b64(
  JSON.stringify({
    manifest_version: 3,
    name: 'e2e',
    version: '1.0',
    background: { service_worker: 'background.js' },
  })
);

// 两个纯计算函数(应下沉)+ 一个碰 DOM 的(应跳过)
const AUTO_JS = b64(`
chrome.runtime.onMessage.addListener((m, s, r) => { r(scoreOf(m.a, m.b)); });
function scoreOf(a, b) { let t = a * 3; return t + b; }
function hashSeed(n) { return (n * 7 + 11) % 1000003; }
function readTitle() { return document.title; }
`);

const USER_CORE_TS = b64(
  'export function scoreOf(a: f64, b: f64): f64 { return a * 3 + b; }\n'
);

let failed = 0;
function check(name, cond, extra) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? '  -> ' + extra : ''}`);
  if (!cond) failed++;
}

async function caseAuto() {
  console.log('\n[1/7] 自动下沉(不提供 core.ts)');
  const res = await pack({
    methods: ['wasm'],
    mangleProps: false,
    files: [
      { path: 'manifest.json', data: MANIFEST },
      { path: 'background.js', data: AUTO_JS },
    ],
  });
  const w = res.report.wasm || {};
  console.log('    wasm 报告:', JSON.stringify(w));
  check('source = auto', w.source === 'auto', w.source);
  check('下沉了 2 个纯计算函数', (w.sunk || []).length === 2, (w.sunk || []).join(','));
  check(
    '碰 DOM 的函数被正确跳过',
    (w.skipped || []).some((s) => s.name === 'readTitle'),
    (w.skipped || [])
      .map((s) => s.name)
      .join(',')
  );
  check('合规扫描无误报(中等风险 0)', res.report.counts.medium === 0, JSON.stringify(res.report.counts));
  check('合规通过', res.report.passed === true);

  // zip 里文件名是明文存的,直接搜字节即可判断条目是否存在
  const zip = res.buf;
  check('包里不含 core.wasm(已内联,不需要)', !zip.includes(Buffer.from('core.wasm')));
  check('包里不含 core.ts', !zip.includes(Buffer.from('core.ts')));
  return zip;
}

async function caseManual() {
  console.log('\n[2/7] 手动下沉(数值函数,提供 core.ts)');
  const res = await pack({
    methods: ['wasm'],
    mangleProps: false,
    files: [
      { path: 'manifest.json', data: MANIFEST },
      { path: 'background.js', data: AUTO_JS },
      { path: 'core.ts', data: USER_CORE_TS },
    ],
  });
  const w = res.report.wasm || {};
  console.log('    wasm 报告:', JSON.stringify(w));
  check('source = user-core', w.source === 'user-core', w.source);
  check('替换了同名函数 scoreOf', (w.sunk || []).includes('scoreOf'), (w.sunk || []).join(','));

  const zip = res.buf;
  // 手动下沉现在也是同步内联:不产独立 core.wasm / loader,调用点不用改 await
  check('包里不含独立 core.wasm(已内联)', !zip.includes(Buffer.from('core.wasm')));
  check('包里不含 core.ts(源码不能进包)', !zip.includes(Buffer.from('core.ts')));
  check('合规扫描无误报(中等风险 0)', res.report.counts.medium === 0, JSON.stringify(res.report.counts));
  return zip;
}

/**
 * ②-b 手动下沉**字符串函数** —— 这是真实插件里最需要的能力:
 * 核心算法往往处理字符串(URL 归一化、相似度判定),不是纯数值。
 * 字符串过 wasm 边界要靠 __new 分配 + 读 UTF-16 头长度,编译必须带 --exportRuntime。
 */
const STR_JS = b64(`
chrome.runtime.onMessage.addListener((m, s, r) => { r(normalize(m.u)); });
function normalize(u) {
  if (!u) return "";
  let x = u.trim().toLowerCase();
  if (x.startsWith("http://")) x = x.slice(7);
  return x;
}
`);
const STR_CORE_TS = b64(
  'export function normalize(u: string): string {\n' +
    '  if (!u) return "";\n' +
    '  let x = u.trim().toLowerCase();\n' +
    '  if (x.startsWith("http://")) x = x.substring(7);\n' +
    '  return x;\n' +
    '}\n'
);

async function caseManualString() {
  console.log('\n[3/7] 手动下沉(字符串函数)');
  const res = await pack({
    methods: ['wasm'],
    mangleProps: false,
    files: [
      { path: 'manifest.json', data: MANIFEST },
      { path: 'background.js', data: STR_JS },
      { path: 'core.ts', data: STR_CORE_TS },
    ],
  });
  const w = res.report.wasm || {};
  console.log('    wasm 报告:', JSON.stringify(w));
  check('source = user-core', w.source === 'user-core', w.source);
  check('替换了字符串函数 normalize', (w.sunk || []).includes('normalize'), (w.sunk || []).join(','));

  check('包里不含独立 core.wasm(已内联)', !res.buf.includes(Buffer.from('core.wasm')));
  check('包里不含 core.ts(源码不能进包)', !res.buf.includes(Buffer.from('core.ts')));
  check('合规扫描无误报(中等风险 0)', res.report.counts.medium === 0, JSON.stringify(res.report.counts));
}

/**
 * ④ 字符串函数下沉后**算得对不对** —— 光"沉进去了"没用,语义必须一致。
 * 走 CLI(能直接读输出文件),把产物里的内联 wasm 抽出来实跑,和原始 JS 比对。
 */
const { execFileSync } = require('child_process');

/**
 * 建临时目录并登记,测试结束时统一删除。
 * 以前直接用 fs.mkdtempSync,跑一次 npm test 就在系统临时目录里留下十几个
 * ess-* 目录,长期累积(实测攒了 250+ 个)。清理失败不影响测试结论。
 */
const TMP_DIRS = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of TMP_DIRS) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // 清不掉就算了,不能因为清理失败掩盖测试结果
    }
  }
});

function caseStringRoundTrip() {
  console.log('\n[4/7] 字符串下沉的语义一致性(实跑 wasm)');
  const root = tmpDir('ess-str-');
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 't', version: '1.0', background: { service_worker: 'b.js' } })
  );
  fs.writeFileSync(
    path.join(src, 'b.js'),
    'chrome.runtime.onMessage.addListener((m,s,r)=>{ r(normalize(m.u)); });\n' +
      'function normalize(u) {\n' +
      '  if (!u) return "";\n' +
      '  let x = u.trim().toLowerCase();\n' +
      '  if (x.startsWith("http://")) x = x.slice(7);\n' +
      '  return x;\n' +
      '}\n'
  );
  fs.writeFileSync(
    path.join(root, 'core.ts'),
    'export function normalize(u: string): string {\n' +
      '  if (!u) return "";\n' +
      '  let x = u.trim().toLowerCase();\n' +
      '  if (x.startsWith("http://")) x = x.substring(7);\n' +
      '  return x;\n' +
      '}\n'
  );
  const out = path.join(root, 'dist');
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'bin', 'extshield.js'),
      'harden',
      '--src', src,
      '--out', out,
      '--wasm',
      '--wasm-core', path.join(root, 'core.ts'),
    ],
    { stdio: 'pipe' }
  );

  const code = fs.readFileSync(path.join(out, 'b.js'), 'utf8');
  check('产物含内联 wasm', /atob\(/.test(code) && /WebAssembly\./.test(code));
  check('原实现已移除(无 startsWith("http://"))', !code.includes('startsWith("http://")'));

  const m = code.match(/"([A-Za-z0-9+/=]{200,})"/);
  if (!m) {
    check('抽出内联 wasm', false);
    return;
  }
  const wasmBytes = Buffer.from(m[1], 'base64');
  const mod = new WebAssembly.Module(wasmBytes);
  const X = new WebAssembly.Instance(mod, {
    env: { abort: () => { throw new Error('abort'); } },
  }).exports;

  // 导出名必须已抹除:原函数名一旦留在 wasm 里,等于给逆向的人一套"哪个函数值钱"
  // 的路标。同时运行时接口(memory / __new)必须原样保留,否则字符串过不去。
  const names = WebAssembly.Module.exports(mod).map((e) => e.name);
  const userFns = names.filter((n) => n.indexOf('__') !== 0 && n !== 'memory');
  check('wasm 里搜不到原函数名(normalize)', !wasmBytes.includes(Buffer.from('normalize', 'utf8')));
  check(
    '函数导出只剩短名',
    userFns.length === 1 && /^f\d+$/.test(userFns[0]),
    userFns.join(',') || '(无)'
  );
  check(
    '运行时接口未被改名(memory / __new)',
    names.includes('memory') && names.includes('__new'),
    names.join(',')
  );
  const lo = (v) => {
    if (v == null) return 0;
    const p = X.__new(v.length << 1, 1) >>> 0;
    const a = new Uint16Array(X.memory.buffer);
    for (let i = 0; i < v.length; i++) a[(p >>> 1) + i] = v.charCodeAt(i);
    return p;
  };
  const li = (p) => {
    if (!p) return null;
    const end = (p + new Uint32Array(X.memory.buffer)[(p - 4) >>> 2]) >>> 1;
    const a = new Uint16Array(X.memory.buffer);
    let s = '';
    for (let i = p >>> 1; i < end; i++) s += String.fromCharCode(a[i]);
    return s;
  };
  const ref = (u) => {
    if (!u) return '';
    let x = u.trim().toLowerCase();
    if (x.startsWith('http://')) x = x.slice(7);
    return x;
  };
  const sinkFn = X[userFns[0]]; // 导出名已改成短名,只能按实际导出取
  const cases = ['', 'HTTP://Example.COM/x', '  https://a.b/  ', 'abc', 'http://中文.com/路径'];
  let ok = true;
  for (const c of cases) {
    const got = li(sinkFn(lo(c)));
    if (got !== ref(c)) {
      ok = false;
      console.log('    差异', JSON.stringify(c), 'wasm=', JSON.stringify(got), 'js=', JSON.stringify(ref(c)));
    }
  }
  check('wasm 版与原 JS 输出一致(5 例,含中文/空串/大写)', ok);
}

/**
 * ③ 没有可下沉的函数时必须如实报空,**不能**塞内置示例 wasm 充数。
 * 这条是踩出来的:真实插件 87 个函数 0 个可沉,产物里却出现了
 * core.wasm + wasm-loader.js(内置示例 + 没人引用的死代码),
 * 用户据此以为自己的逻辑已经沉进去了。
 */
async function caseNoCandidates() {
  console.log('\n[5/7] 无可沉函数(不得拿示例 wasm 充数)');
  const noSinkable = b64(`
chrome.runtime.onMessage.addListener((m, s, r) => { r(1); });
function renderUI() { return document.title; }
function saveIt() { return chrome.storage; }
`);
  const res = await pack({
    methods: ['wasm'],
    mangleProps: false,
    files: [
      { path: 'manifest.json', data: MANIFEST },
      { path: 'background.js', data: noSinkable },
    ],
  });
  const w = res.report.wasm || {};
  console.log('    wasm 报告:', JSON.stringify(w));
  check('source = auto-empty', w.source === 'auto-empty', w.source);
  check('报告带扫描数量', typeof w.scanned === 'number' && w.scanned > 0, String(w.scanned));
  check('包里不含 core.wasm(不充数)', !res.buf.includes(Buffer.from('core.wasm')));
  check('包里不含 wasm-loader.js(不留死代码)', !res.buf.includes(Buffer.from('wasm-loader.js')));
  check('合规仍然通过', res.report.passed === true);
}

/**
 * ⑥ 返回类型 / 局部变量类型必须和原 JS 一致 —— 只看"沉进去了"不够,得看算出来是什么。
 *
 * 这条盯的是两个踩过的坑:
 *   - 返回布尔的函数被当成 f64 → 调用点拿到 1/0 而不是 true/false
 *     (if(x) 没事,但 `x === true` 和 JSON.stringify 就错了)
 *   - 局部变量被无脑标 f64 → `let ok = a > b` 生成 `let ok: f64 = a > b`,
 *     AssemblyScript 直接类型报错
 * 顺带验证函数体边界是按 AST 取的:函数体里带 `{` 的注释不能把切点带歪。
 */
const TYPE_JS = b64(`
chrome.runtime.onMessage.addListener((m, s, r) => { r(1); });
function isValid(n) { /* 注释里故意放个 { 大括号 */ return n > 0 && n < 100; }
function scaled(n) { let k = n * 2; return k + 1; }
function flagOf(n) { let ok = isValid(n); return ok ? 1 : 0; }
function mixedUp(n) { if (n > 0) { return n > 1; } return n; }
function nothing(n) { let a = n + 1; }
globalThis.__ALIVE = 'script-ran';
globalThis.__R = [isValid(5), isValid(500), scaled(3), flagOf(5)];
`);

function caseTypeRoundTrip() {
  console.log('\n[6/7] 返回类型与局部变量类型(实跑产物)');
  const root = tmpDir('ess-type-');
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 't', version: '1.0', background: { service_worker: 'b.js' },
  }));
  fs.writeFileSync(path.join(src, 'b.js'), Buffer.from(TYPE_JS, 'base64').toString('utf8'));

  // 规则层面:拿不准的必须明确拒绝,而不是硬塞进 wasm
  const scan = require('../src/auto-sink').findCandidates(src);
  const reasonOf = (n) => ((scan.skipped || []).find((s) => s.name === n) || {}).reason || '';
  check('返回类型不统一的函数被判跳过', reasonOf('mixedUp').includes('返回类型不统一'), reasonOf('mixedUp'));
  check('没有返回值的函数被判跳过', reasonOf('nothing').includes('没有 return'), reasonOf('nothing'));

  const out = path.join(root, 'dist');
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'extshield.js'), 'harden', '--src', src, '--out', out, '--wasm'],
    { stdio: 'pipe' }
  );

  const vm = require('vm');
  const mkCtx = (extra) => vm.createContext(Object.assign({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    console: { error() {}, log() {} },
  }, extra));
  const code = fs.readFileSync(path.join(out, 'b.js'), 'utf8');

  const ctx = mkCtx();
  vm.runInContext(code, ctx);
  const R = ctx.__R || [];

  check('布尔函数返回真值仍是 true(不是 1)', R[0] === true, JSON.stringify(R[0]));
  check('布尔函数返回假值仍是 false(不是 0)', R[1] === false, JSON.stringify(R[1]));
  check('数值函数 scaled(3) = 7', R[2] === 7, JSON.stringify(R[2]));
  check('依赖布尔函数算出的 flagOf(5) = 1', R[3] === 1, JSON.stringify(R[3]));

  // ── wasm 被 CSP 拦下时,不能把整个文件带崩 ──
  // 真实事故:内联 wasm 的初始化写在文件最外层,被 CSP 拦掉后 popup 整个白屏
  // (不只是被下沉的函数坏)。现在初始化有 try/catch 兜底。
  const ctx2 = mkCtx({
    WebAssembly: {
      Module: function () { throw new Error('simulated CSP block'); },
      Instance: function () {},
    },
  });
  let thrown = null;
  try {
    vm.runInContext(code, ctx2);
  } catch (e) {
    thrown = e;
  }
  check('wasm 被拦下时,脚本其余部分照常执行', ctx2.__ALIVE === 'script-ran', String(ctx2.__ALIVE));
  check(
    'wasm 被拦下时只在调用处报错,且错误信息可读',
    thrown && /wasm/.test(String(thrown.message)),
    thrown ? String(thrown.message) : '(没有报错)'
  );

  // ── 内联 wasm 必须能在扩展页里跑起来:manifest 得放行 wasm-unsafe-eval ──
  // 这是踩出来的:MV3 默认 CSP 是 script-src 'self',wasm 编译会被当成代码求值拦掉,
  // 报 CompileError: ...violates the following CSP directive: "script-src 'self'"
  const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const csp = (man.content_security_policy || {}).extension_pages || '';
  check("产物 manifest 放行了 'wasm-unsafe-eval'", csp.includes("'wasm-unsafe-eval'"), csp);
  check(
    "没有引入危险的 'unsafe-eval'(MV3 会直接安装失败)",
    !csp.replace(/wasm-unsafe-eval/g, '').includes('unsafe-eval'),
    csp
  );
  check('保留原有指令(object-src)', /object-src/.test(csp), csp);

  // 已有 CSP 时必须只做"追加",不能把用户原有配置覆盖掉
  const mergeDir = tmpDir('ess-csp-');
  fs.writeFileSync(path.join(mergeDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'm', version: '1.0',
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none';" },
  }));
  const WASMSINK = require('../src/wasm-sink');
  const r1 = WASMSINK.patchCsp(mergeDir);
  const merged = JSON.parse(fs.readFileSync(path.join(mergeDir, 'manifest.json'), 'utf8'))
    .content_security_policy.extension_pages;
  check('已有 CSP 时做追加而非覆盖', merged.includes("'wasm-unsafe-eval'") && /object-src 'none'/.test(merged), merged);
  check('patchCsp 幂等(第二遍不再改)', WASMSINK.patchCsp(mergeDir).changed === false, String(r1.changed));
}

/**
 * ⑦ 安全与健壮性回归(评审清单里核实的几条)
 */
async function caseHardening() {
  console.log('\n[7/7] 安全与健壮性回归');
  const A = require('../src/auto-sink');
  const WSINK = require('../src/wasm-sink');

  // (1) $ 开头的模块级常量:以前用 `\b$MAX\b` 匹配不到,常量没进 core.ts,
  //     引用它的函数会被判"可沉"但编译不过、最后被丢掉
  const d1 = tmpDir('ess-h1-');
  fs.writeFileSync(path.join(d1, 'a.js'),
    'const $MAX = 50;\nfunction clampDollar(v){ return v > $MAX ? $MAX : v; }\n');
  const s1 = A.findCandidates(d1);
  check('$ 开头的模块级常量能被收集', s1.consts.has('$MAX'), Array.from(s1.consts.keys()).join(','));
  check('引用 $ 常量的函数被判可沉', s1.candidates.some((c) => c.name === 'clampDollar'));
  // 补上一环:以前只测"被收集/可沉",没测"真的编译得过"。万一 AS 不接受 $ 开头
  // 标识符,这 bug 就会在"收集"之后才炸,前面的断言根本拦不住。
  const cand1 = s1.candidates.filter((c) => c.name === 'clampDollar');
  check('$ 常量函数进入编译阶段', cand1.length === 1, 'candidates=' + s1.candidates.map((c) => c.name).join(','));
  let compiled1 = false;
  if (cand1.length) {
    const ts1 = path.join(d1, 'core.ts');
    const wasm1 = path.join(d1, 'core.wasm');
    fs.writeFileSync(ts1, A.toAssemblyScript(cand1, s1.consts), 'utf8');
    try {
      await A.compile(ts1, wasm1);
      compiled1 = fs.existsSync(wasm1) && fs.statSync(wasm1).size > 0;
    } catch (e) {
      compiled1 = false;
    }
  }
  check('$ 常量函数编译产物非空(AS 接受 $ 前缀标识符)', compiled1);

  // (2) content script 要分两类(CSP 规则完全不同,已核对 Chrome 官方文档):
  //     默认「隔离世界」的 content script 自带放行 wasm 的 CSP → 照常下沉
  //     只有 "world":"MAIN" 的才套用网页 CSP → 必须排除
  const d2 = tmpDir('ess-h2-');
  fs.writeFileSync(path.join(d2, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'h', version: '1.0',
    content_scripts: [
      { matches: ['<all_urls>'], js: ['cs.js'] },                       // 默认 = 隔离世界
      { matches: ['<all_urls>'], js: ['main.js'], world: 'MAIN' },      // 主世界
    ],
  }));
  fs.writeFileSync(path.join(d2, 'cs.js'), 'function csScore(a, b){ return a * 3 + b; }\n');
  fs.writeFileSync(path.join(d2, 'main.js'), 'function mainScore(a, b){ return a * 7 + b; }\n');
  fs.writeFileSync(path.join(d2, 'popup.js'), 'function popScore(a, b){ return a * 5 + b; }\n');
  const ex2 = WSINK.mainWorldContentScripts(d2);
  const s2 = A.findCandidates(d2, { exclude: ex2 });
  check('隔离世界的 content script 照常下沉(官方 CSP 放行 wasm)',
    s2.candidates.some((c) => c.name === 'csScore'));
  check('主世界的 content script 被排除', !s2.candidates.some((c) => c.file.endsWith('main.js')));
  check(
    '排除原因写清楚了(点明主世界)',
    /主世界/.test((s2.skipped.find((s) => s.name === 'mainScore') || {}).reason || ''),
    (s2.skipped.find((s) => s.name === 'mainScore') || {}).reason
  );
  check('扩展页里的函数照常下沉', s2.candidates.some((c) => c.name === 'popScore'));
  check('排除集合只含主世界那份', ex2.size === 1);

  // (3) zip 由纯 Node 生成:格式合法 + manifest 在包根
  const okZip = await pack({
    methods: ['minify'],
    mangleProps: false,
    files: [
      { path: 'manifest.json', data: MANIFEST },
      { path: 'background.js', data: b64('chrome.runtime.onMessage.addListener(()=>{});') },
    ],
  });
  const z = okZip.buf;
  check('zip 以 PK\\x03\\x04 开头', z.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
  check('zip 以 EOCD 结尾', z.slice(-22, -18).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])));
  check('manifest.json 在包根(无 ./ 前缀)', z.includes(Buffer.from('manifest.json')) && !z.includes(Buffer.from('./manifest.json')));

  // (4) 上传路径校验
  let e1 = null;
  try {
    await pack({ methods: ['minify'], files: [{ path: '../evil.js', data: b64('1') }] });
  } catch (e) { e1 = e.message; }
  check('拒绝路径穿越', /非法文件路径/.test(String(e1)), String(e1));

  let e2 = null;
  try {
    await pack({ methods: ['minify'], files: [{ path: '', data: b64('1') }] });
  } catch (e) { e2 = e.message; }
  check('拒绝空文件名', /缺少文件名/.test(String(e2)), String(e2));

  // (5) 本机访问校验(防 DNS rebinding / CSRF)
  const { checkLocalRequest, boundPort } = require('../gui/server');
  const port = boundPort();
  check('能拿到实际监听端口', typeof port === 'number' && port > 0, String(port));
  const H = '127.0.0.1:' + port;
  check('拒绝陌生 Host(DNS rebinding)', checkLocalRequest({ headers: { host: 'evil.example.com' } }) === false);
  check(
    '拒绝跨站 Origin',
    checkLocalRequest({ headers: { host: H, origin: 'https://evil.example.com' } }) === false
  );
  check(
    '拒绝跨站简单请求(Sec-Fetch-Site)',
    checkLocalRequest({ headers: { host: H, 'sec-fetch-site': 'cross-site' } }) === false
  );
  check(
    '放行本机同源页面',
    checkLocalRequest({ headers: { host: H, origin: 'http://' + H, 'sec-fetch-site': 'same-origin' } }) === true
  );

  // (6) 字符串不再无界吃内存(manual sink 已换 incremental 运行时)
  const MANUAL = require('../src/manual-sink');
  const d3 = tmpDir('ess-h3-');
  const ts = path.join(d3, 'core.ts');
  const wasm = path.join(d3, 'core.wasm');
  fs.writeFileSync(ts, 'export function norm(u: string): string { return u.toLowerCase(); }\n');
  await MANUAL.compileWithRuntime(ts, wasm);
  const X = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(wasm)), {
    env: { abort: () => { throw new Error('abort'); } },
  }).exports;
  const U16 = () => new Uint16Array(X.memory.buffer);
  const U32 = () => new Uint32Array(X.memory.buffer);
  const lo2 = (v) => {
    const p = X.__new(v.length << 1, 1) >>> 0;
    const a = U16();
    for (let i = 0; i < v.length; i++) a[(p >>> 1) + i] = v.charCodeAt(i);
    return p;
  };
  const li2 = (p) => {
    const end = (p + U32()[(p - 4) >>> 2]) >>> 1;
    const a = U16();
    let s = '';
    for (let i = p >>> 1; i < end; i++) s += String.fromCharCode(a[i]);
    return s;
  };
  const sample = 'https://example.com/' + 'x'.repeat(80);
  const pages0 = X.memory.buffer.byteLength / 65536;
  let last = '';
  for (let i = 0; i < 5000; i++) last = li2(X.norm(lo2(sample)));
  const pages1 = X.memory.buffer.byteLength / 65536;
  check('字符串调用 5000 次后内存基本不涨(< 8 页)', pages1 - pages0 < 8, `${pages0} 页 -> ${pages1} 页`);
  check('内存优化后结果仍然正确', last === sample);

  // (7) harden 的"跨文件全局变量"检测:边界不能用 \b
  //     \w 不含 `$`,而 `$` 是合法标识符字符 —— 用 \b 会两头出错:
  //       漏检 `$` 前缀变量(前面是空格/`(` 时 \b 不成立)
  //       误报 foo$MAX(\b 在 o 和 $ 之间成立,把 $MAX 当成独立变量)
  //     改用 (?<![\w$]) / (?![\w$]) 后两侧都不许与标识符字符相邻。
  const HARDEN = require('../src/harden');

  const d4 = tmpDir('ess-h4-');
  fs.writeFileSync(path.join(d4, 'a.js'), 'var $MAX = 50;\n');
  fs.writeFileSync(path.join(d4, 'b.js'), 'console.log($MAX);\n');
  const r1 = HARDEN.detectCrossFileGlobals({ srcDir: d4, entries: ['a.js', 'b.js'] });
  check(
    '$ 前缀变量跨文件引用能被检出(原 \\b 会漏检)',
    r1.some((r) => r.name === '$MAX' && r.owner === 'a.js' && r.usedIn === 'b.js'),
    JSON.stringify(r1)
  );

  const d5 = tmpDir('ess-h5-');
  fs.writeFileSync(path.join(d5, 'a.js'), 'var $MAX = 50;\n');
  fs.writeFileSync(path.join(d5, 'b.js'), 'var foo$MAX = 1;\n');
  const r2 = HARDEN.detectCrossFileGlobals({ srcDir: d5, entries: ['a.js', 'b.js'] });
  check(
    '$ 前缀变量不会被"更长标识符"误报(原 \\b 会误报)',
    !r2.some((r) => r.name === '$MAX'),
    JSON.stringify(r2)
  );

  const d6 = tmpDir('ess-h6-');
  fs.writeFileSync(path.join(d6, 'a.js'), 'var state = 1;\n');
  fs.writeFileSync(path.join(d6, 'b.js'), 'console.log(state2);\n');
  const r3 = HARDEN.detectCrossFileGlobals({ srcDir: d6, entries: ['a.js', 'b.js'] });
  check(
    '普通标识符的边界没被改坏(state 不该匹配 state2)',
    !r3.some((r) => r.name === 'state'),
    JSON.stringify(r3)
  );

  const d7 = tmpDir('ess-h7-');
  fs.writeFileSync(path.join(d7, 'a.js'), 'var state = 1;\n');
  fs.writeFileSync(path.join(d7, 'b.js'), 'console.log(state);\n');
  const r4 = HARDEN.detectCrossFileGlobals({ srcDir: d7, entries: ['a.js', 'b.js'] });
  check(
    '普通标识符照常检出(没把功能改哑)',
    r4.some((r) => r.name === 'state'),
    JSON.stringify(r4)
  );
}

(async () => {
  try {
    await caseAuto();
    await caseManual();
    await caseManualString();
    await caseNoCandidates();
    caseStringRoundTrip();
    caseTypeRoundTrip();
    await caseHardening();
  } catch (e) {
    console.error('\n测试异常:', e && e.stack ? e.stack : e);
    failed++;
  }
  console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`);
  // 服务还在监听,必须显式退出
  process.exit(failed === 0 ? 0 : 1);
})();
