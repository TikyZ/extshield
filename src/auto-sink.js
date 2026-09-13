'use strict';

/**
 * 自动下沉(规则分析版,纯本地、不联网、不用 AI)
 *
 * 干的事:扫扩展源码 -> 按规则挑出"适合沉进 WASM 的函数" -> 自动生成
 *        core.ts -> 编译成 core.wasm -> 把原 JS 里的函数换成 wasm 调用。
 *
 * 目的:省掉"你得自己手写 core.ts"这一步。
 *
 * 为什么用内联 base64 + 同步实例化:
 *   常规 wasm 加载是异步的(fetch + await)。如果拿它去替换你原来的同步函数,
 *   调用方全得改成 await,一改就崩。所以这里把 wasm 编译结果以 base64 内联进
 *   JS,用 new WebAssembly.Module()/Instance() 同步实例化 —— 替换是无缝的,
 *   同步调用点一行都不用动。
 */

const fs = require('fs');
const path = require('path');
const ASC = require('./asc');
const RT = require('./runtime-gen');
const WASMRENAME = require('./wasm-rename');

let acorn;
function lazyAcorn() {
  if (!acorn) acorn = require('acorn');
  return acorn;
}

/**
 * 这些"名字"一出现就说明函数碰了浏览器/扩展环境,不能沉进 wasm。
 * 走 AST 精确判定(而不是对整段代码做文本 includes),避免 myDocument、
 * consoleX 这类名字被误杀。
 */
const FORBIDDEN_IDENTS = new Set([
  'chrome', 'browser', 'document', 'window', 'fetch', 'XMLHttpRequest',
  'localStorage', 'sessionStorage', 'console', 'eval', 'Function', 'require',
  'module', 'exports', 'globalThis', 'alert', 'setTimeout', 'setInterval',
  'Promise', 'importScripts', 'navigator', 'location', 'WebSocket', 'self',
  'process', '__dirname', '__filename', 'Buffer', 'performance',
]);

/**
 * 允许引用的全局对象。wasm(AssemblyScript)里 Math 是实现了的,
 * 所以 Math.floor / Math.max 这类是安全的。
 */
const ALLOWED_GLOBALS = new Set(['Math', 'Number']);

/** 文本兜底:少数 AST 抓不到但确实很危险的特征(比如模板里塞 eval) */
const FORBIDDEN_TEXT_RE = [/\beval\s*\(/, /\bnew\s+Function\b/, /\bimportScripts\s*\(/];

/**
 * 递归遍历 AST 所有节点。带 parent,用来区分"变量名"和"成员访问的属性名"
 * (Math.floor 里的 floor 是属性,不是变量,不能当成未知引用)。
 */
function walk(node, visit, parent) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, parent);
    return;
  }
  if (typeof node.type === 'string') visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    walk(node[key], visit, node);
  }
}

/**
 * 检查一个函数"自身"能不能沉进 wasm。
 *
 * 跟老版本的关键区别:遇到"调用另一个已声明的函数"时不直接放行也不直接拒绝,
 * 而是记进 deps,交给外面的不动点算法去决定 —— 因为 a 能不能沉,取决于它调用的
 * b 能不能沉(老版本只看了 b 的名字在不在源码里,于是 a 调了一个碰 document 的 b
 * 也照样被选中,生成出来的 core.ts 里 b 根本没定义,一编译就炸)。
 *
 * 返回 { ok, reason, deps } —— deps 是它调用到的、源码里声明过的函数名。
 */
function checkBody(fnNode, code, declaredNames, constNames) {
  const body = code.slice(fnNode.body.start, fnNode.body.end);

  for (const re of FORBIDDEN_TEXT_RE) {
    if (re.test(body)) return { ok: false, reason: `用了动态执行特性(${re.source})` };
  }

  for (const p of fnNode.params) {
    if (p.type !== 'Identifier') return { ok: false, reason: '参数不是简单标识符(有默认值/解构/rest)' };
  }
  if (fnNode.async || fnNode.generator) return { ok: false, reason: 'async/generator 函数' };

  const locals = new Set(fnNode.params.map((p) => p.name));
  const kinds = new Set();
  const deps = new Set();
  const usedConsts = new Set();
  let badLit = null;

  walk(fnNode.body, (n) => {
    if (n.type) kinds.add(n.type);
    if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier') {
      locals.add(n.id.name);
    }
    // 函数声明会提升,函数体内的嵌套函数也算局部
    if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.id) {
      locals.add(n.id.name);
    }
    // 数字常量在 wasm 里完全合法,只有字符串 / 正则 / null / 布尔不该出现
    if (n.type === 'Literal' && !badLit) {
      const v = n.value;
      if (typeof v === 'string') badLit = '字符串常量';
      else if (v instanceof RegExp) badLit = '正则';
      else if (v === null) badLit = 'null';
      else if (typeof v === 'boolean') badLit = '布尔常量';
    }
  });
  if (badLit) return { ok: false, reason: `函数体里用了 wasm 不支持的常量(${badLit})` };

  // wasm(minimal runtime)里支持不了的结构
  const bannedKinds = [
    'TemplateLiteral', 'ArrayExpression', 'ObjectExpression', 'NewExpression',
    'ThisExpression', 'AwaitExpression', 'YieldExpression',
    'ClassExpression', 'ArrowFunctionExpression', 'FunctionExpression',
  ];
  for (const k of bannedKinds) {
    if (kinds.has(k)) return { ok: false, reason: `函数体里用了 wasm 不支持的结构(${k})` };
  }

  // 引用的外部名字只能是:局部变量/参数、允许的全局、模块级数字常量、其它声明过的函数
  let badRef = null;
  walk(fnNode.body, (n, parent) => {
    if (badRef) return;
    if (n.type === 'Identifier') {
      // a.b 里的 b 是属性名,不是变量引用 —— 别当成未知名字
      if (parent && parent.type === 'MemberExpression' && !parent.computed && parent.property === n) return;
      const name = n.name;
      if (locals.has(name)) return;
      if (ALLOWED_GLOBALS.has(name)) return;
      // 模块级数字常量:顺手记下用到了哪个,后面据此往 core.ts 里内联
      if (constNames.has(name)) { usedConsts.add(name); return; }
      if (FORBIDDEN_IDENTS.has(name)) { badRef = name + '(浏览器/扩展 API)'; return; }
      if (declaredNames.has(name)) { deps.add(name); return; } // 交给调用图决定
      badRef = name;
    }
    if (n.type === 'MemberExpression') {
      const obj = n.object;
      if (obj && obj.type === 'Identifier' && ALLOWED_GLOBALS.has(obj.name)) return;
      badRef = '成员访问';
    }
  });
  if (badRef) return { ok: false, reason: `引用了 wasm 里没有的东西(${badRef})` };

  return { ok: true, deps, usedConsts };
}

/** 收集每个文件顶层的 const NAME = <数字>,只有"全局唯一"的才敢内联进 core.ts */
function collectModuleConsts(files) {
  const seen = new Map(); // name -> { value, count }
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = lazyAcorn().parse(code, { ecmaVersion: 2022, sourceType: 'module', allowReturnOutsideFunction: true });
    } catch {
      continue;
    }
    for (const n of ast.body) {
      if (n.type !== 'VariableDeclaration' || n.kind !== 'const') continue;
      for (const d of n.declarations) {
        if (!d.id || d.id.type !== 'Identifier' || !d.init) continue;
        let value = null;
        if (d.init.type === 'Literal' && typeof d.init.value === 'number') value = d.init.value;
        else if (d.init.type === 'UnaryExpression' && d.init.operator === '-' &&
                 d.init.argument.type === 'Literal' && typeof d.init.argument.value === 'number') {
          value = -d.init.argument.value;
        }
        if (value === null) continue;
        const rec = seen.get(d.id.name) || { value, count: 0 };
        rec.count += 1;
        seen.set(d.id.name, rec);
      }
    }
  }
  const out = new Map();
  for (const [name, rec] of seen) if (rec.count === 1) out.set(name, rec.value);
  return out;
}

/**
 * 收集函数自己的 return 语句。
 * 遇到嵌套函数就停 —— 里面 return 的是那个函数的,不是当前函数的。
 */
function collectReturns(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectReturns(n, out);
    return;
  }
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression') return;
  if (node.type === 'ReturnStatement') { out.push(node); return; }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    collectReturns(node[key], out);
  }
}

/**
 * 判断一个表达式的结果是不是"布尔"。
 *
 * 这个必须判准 —— wasm 里只有 f64 和 bool,判成 f64 的话调用点拿到的
 * 就从 true/false 变成 1/0(falsy/truthy 行为一样,但 === true 和
 * JSON.stringify 就变了)。
 */
function isBoolExpr(e, boolPool) {
  if (!e) return false;
  switch (e.type) {
    case 'BinaryExpression':
      return ['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(e.operator);
    case 'LogicalExpression':
      // a && b 会短路返回操作数本身,只有两边都保证是布尔,结果才是布尔
      return isBoolExpr(e.left, boolPool) && isBoolExpr(e.right, boolPool);
    case 'UnaryExpression':
      return e.operator === '!';
    case 'ConditionalExpression':
      return isBoolExpr(e.consequent, boolPool) && isBoolExpr(e.alternate, boolPool);
    case 'CallExpression':
      // 调用另一个"返回布尔"的已下沉函数
      return !!(boolPool && e.callee && e.callee.type === 'Identifier' && boolPool.has(e.callee.name));
    default:
      return false;
  }
}

/** 推断函数返回的是数字还是布尔;推不出来就如实说明原因,交给上层放弃 */
function classifyReturns(fnNode, boolPool) {
  const rets = [];
  collectReturns(fnNode.body, rets);
  if (!rets.length) return { kind: 'void', reason: '没有 return 语句(wasm 里必须有返回值)' };
  let hasBool = false;
  let hasNum = false;
  for (const r of rets) {
    if (!r.argument) return { kind: 'void', reason: '存在裸 return(没有返回值)' };
    if (isBoolExpr(r.argument, boolPool)) hasBool = true;
    else hasNum = true;
  }
  if (hasBool && hasNum) {
    return { kind: 'mixed', reason: '返回类型不统一(有的分支返回布尔、有的返回数字)' };
  }
  return { kind: hasBool ? 'bool' : 'num' };
}

/**
 * 扫描 srcDir 下所有 .js,返回可下沉的候选函数与被跳过的函数(带原因)。
 *
 * 判定分三步:
 *   1. 逐个函数做"自身"检查(checkBody),顺便记下它调用了哪些已声明的函数;
 *   2. 不动点收敛 —— 只要依赖链上有一个函数沉不进去,整条链一起放弃;
 *      (否则生成的 core.ts 会引用根本不存在的函数,编译直接失败)
 *   3. 跨文件同名函数分别改名(name / name$2 / ...),各沉各的,不用一刀切丢掉。
 */
function findCandidates(srcDir, opts = {}) {
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set();
  const keyOf = (p) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };

  const files = [];
  (function collect(d) {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) collect(full);
      else if (/\.js$/i.test(name)) files.push(full);
    }
  })(srcDir);

  const all = [];
  const excludedFns = [];
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = lazyAcorn().parse(code, {
        ecmaVersion: 2022,
        sourceType: 'module',
        allowReturnOutsideFunction: true,
      });
    } catch {
      continue;
    }
    // 只跳过「注入主世界」的 content script:主世界套用网页 CSP,wasm 可能被站点拦掉。
    // 默认(隔离世界)的 content script 自带放行 wasm 的 CSP,照常参与下沉。
    const bucket = exclude.has(keyOf(file)) ? excludedFns : all;
    walk(ast, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id) {
        bucket.push({ node: n, name: n.id.name, file, code });
      }
    });
  }

  const declaredNames = new Set(all.map((f) => f.name));
  const moduleConsts = collectModuleConsts(files);
  const constNames = new Set(moduleConsts.keys());

  // 返回类型推断:先各自判一遍,再迭代收敛 ——
  // "return helper(x)" 这种要先知道 helper 是不是布尔函数,才能定自己的类型。
  const retKinds = new Map();
  for (const f of all) retKinds.set(f, classifyReturns(f.node, null));
  for (let round = 0; round < 5; round++) {
    const boolPool = new Set();
    for (const f of all) if (retKinds.get(f).kind === 'bool') boolPool.add(f.name);
    let changed = false;
    for (const f of all) {
      if (retKinds.get(f).kind !== 'num') continue;
      const r = classifyReturns(f.node, boolPool);
      if (r.kind === 'bool') { retKinds.set(f, r); changed = true; }
    }
    if (!changed) break;
  }

  // 步骤 1:自身检查 + 返回类型可用性
  const verdicts = new Map();
  const base = [];
  for (const f of all) {
    let v = checkBody(f.node, f.code, declaredNames, constNames);
    if (v.ok) {
      const rk = retKinds.get(f);
      if (rk.kind !== 'num' && rk.kind !== 'bool') v = { ok: false, reason: rk.reason };
    }
    verdicts.set(f, v);
    if (v.ok) base.push(f);
  }

  // 步骤 2:不动点收敛(依赖链上任一环节沉不下去,整条链放弃)
  const okSet = new Set(base);
  const failReason = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of Array.from(okSet)) {
      const v = verdicts.get(f);
      for (const dep of v.deps) {
        // 依赖必须"本身也在 okSet 里"。注意同名函数:用名字判断,
        // 只要存在任意一个同名且仍可沉的定义,就认为调用能满足。
        const satisfied = Array.from(okSet).some((g) => g.name === dep);
        if (!satisfied) {
          okSet.delete(f);
          failReason.set(f, `调用了无法下沉的函数(${dep})`);
          changed = true;
          break;
        }
      }
    }
  }

  // 步骤 3:跨文件同名函数分别改名,避免 core.ts 里出现重复 export
  const wasmNameOf = new Map(); // fn 对象 -> core.ts 里的名字
  const usedNames = new Set();
  for (const f of all) {
    if (!okSet.has(f)) continue;
    let wn = f.name;
    if (usedNames.has(wn)) {
      let i = 2;
      while (usedNames.has(`${f.name}$${i}`)) i++;
      wn = `${f.name}$${i}`;
    }
    usedNames.add(wn);
    wasmNameOf.set(f, wn);
  }

  // 步骤 4:把函数体里对其它函数的调用改成改名后的名字(优先同文件的定义),
  //         并给局部变量标上正确类型(布尔表达式不能标成 f64,AS 会直接报错)
  const finalBoolPool = new Set();
  for (const f of all) if (retKinds.get(f).kind === 'bool') finalBoolPool.add(f.name);

  const candidates = [];
  const skipped = [];
  for (const f of all) {
    if (!okSet.has(f)) {
      const v = verdicts.get(f);
      skipped.push({
        name: f.name,
        file: path.basename(f.file),
        reason: (v && v.reason) || failReason.get(f) || '不可下沉',
      });
      continue;
    }
    const v = verdicts.get(f) || { deps: new Set(), usedConsts: new Set() };
    const depTargets = new Map();
    for (const dep of v.deps) {
      const pool = Array.from(okSet).filter((g) => g.name === dep);
      if (!pool.length) continue;
      const target = pool.find((g) => g.file === f.file) || pool[0];
      depTargets.set(dep, wasmNameOf.get(target));
    }
    candidates.push({
      name: f.name,                // JS 里的原名(替换调用点时用)
      wasmName: wasmNameOf.get(f), // core.ts 里的名字
      file: f.file,
      params: f.node.params.map((p) => p.name),
      retKind: retKinds.get(f).kind === 'bool' ? 'bool' : 'f64',
      usesConsts: v.usedConsts || new Set(),
      src: f.code.slice(f.node.start, f.node.end), // 原文,用来找用到了哪些常量
      body: buildBody(f.node, f.code, depTargets, finalBoolPool),
      start: f.node.start,
      end: f.node.end,
    });
  }

  // 只保留最终候选真正用到的常量。
  // 这里用 AST 收集到的 usedConsts,不再用 `\b名字\b` 正则 —— `\b` 对
  // `$` 开头的名字(如 $MAX)根本不成立,会漏掉常量声明,生成的 core.ts 编译不过。
  const consts = new Map();
  for (const c of candidates) {
    for (const name of c.usesConsts) {
      if (!consts.has(name)) consts.set(name, moduleConsts.get(name));
    }
  }

  // 主世界的 content script 单独报出来,让用户知道是"故意没沉",不是漏了
  for (const f of excludedFns) {
    skipped.push({
      name: f.name,
      file: path.basename(f.file),
      reason: '在「注入主世界」的 content script 里 —— 它套用网页 CSP,wasm 可能被站点拦掉,已跳过',
    });
  }

  return { candidates, skipped, consts };
}

/**
 * 生成 core.ts 里那个函数的函数体(不带大括号)。
 *
 * 两件事一起做,而且是基于 AST 的精确位置改(不做字符串全局替换):
 *   1. 把"调用其它已下沉函数"的标识符改成它在 core.ts 里的新名字;
 *   2. 给局部变量标类型 —— 布尔表达式标 bool,其余标 f64。
 *      标错的话 AssemblyScript 会直接类型报错(比如把 `a > b` 标成 f64)。
 * 函数体的边界取 AST 的 body 范围,不用 indexOf('{')(注释里出现 { 就会切歪)。
 */
function buildBody(fnNode, code, depTargets, boolPool) {
  const from = fnNode.body.start + 1; // 跳过 {
  const to = fnNode.body.end - 1;     // 去掉 }
  const raw = code.slice(from, to);

  const locals = new Set(fnNode.params.map((p) => p.name));
  walk(fnNode.body, (n) => {
    if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier') locals.add(n.id.name);
    if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.id) locals.add(n.id.name);
  });

  const edits = [];
  walk(fnNode.body, (n, parent) => {
    if (n.type === 'Identifier') {
      if (parent && parent.type === 'MemberExpression' && !parent.computed && parent.property === n) return;
      if (locals.has(n.name)) return;
      const t = depTargets && depTargets.get(n.name);
      if (t && t !== n.name) edits.push({ start: n.start, end: n.end, text: t });
      return;
    }
    if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier') {
      const type = isBoolExpr(n.init, boolPool) ? 'bool' : 'f64';
      edits.push({ start: n.id.end, end: n.id.end, text: `: ${type}` });
    }
  });

  edits.sort((a, b) => b.start - a.start);
  let body = raw;
  for (const e of edits) {
    body = body.slice(0, e.start - from) + e.text + body.slice(e.end - from);
  }
  return body;
}

/**
 * 把候选函数转成 AssemblyScript(core.ts)。数值一律 f64,只有确实返回布尔的才用 bool。
 */
function toAssemblyScript(candidates, consts) {
  const header =
    '// core.ts —— 由 extshield 自动下沉生成(规则分析,未改动你的原始语义)\n' +
    '// 下面这些函数是从你的扩展源码里扫出来的"纯计算逻辑",会被编译进 core.wasm,\n' +
    '// 原 JS 里的实现替换成对 wasm 的同步调用。\n' +
    '// 想自己掌控的话:提供你自己的 core.ts,工具会优先用你的。\n\n';

  const constBlock = consts && consts.size
    ? '// 源码里顶层定义的数字常量(值直接内联,语义不变)\n' +
      Array.from(consts.entries())
        .map(([n, v]) => `const ${n}: f64 = ${v};`)
        .join('\n') +
      '\n\n'
    : '';

  const bodies = candidates
    .map((c) => {
      const paramsTyped = c.params.map((p) => `${p}: f64`).join(', ');
      return `export function ${c.wasmName}(${paramsTyped}): ${c.retKind || 'f64'} {${c.body}}`;
    })
    .join('\n\n');

  return header + constBlock + bodies + '\n';
}

/**
 * 编译 core.ts -> core.wasm。
 * 三个坑(只能动态 import / 会误读 process.argv 里的 --wasm / 失败时没有数字
 * 退出码容易把失败当成功)统一在 src/asc.js 里处理,这里不再复制一份。
 */
function compile(coreTsPath, wasmPath) {
  return ASC.compile(coreTsPath, wasmPath);
}

/**
 * 把候选函数在原 JS 里替换成 wasm 调用(同步、无缝)。返回被替换的函数名。
 */
function rewriteWithInlineWasm(candidates, wasmPath) {
  // 先抹掉 wasm 里的函数导出名。否则 `(export "hashSeed" ...)` 会把原函数名原样
  // 交给逆向的人 —— 等于给他一套"哪个函数值钱"的路标。JS 侧调用点靠返回的 map 对齐。
  const ren = WASMRENAME.renameFunctionExports(wasmPath);
  const b64 = fs.readFileSync(wasmPath).toString('base64');
  // 包一层 try/catch:扩展页 CSP 拦掉 wasm 编译时,不能把整个文件带崩。
  const runtime = RT.guarded(
    'var s=' +
      JSON.stringify(b64) +
      ',b=atob(s),u=new Uint8Array(b.length);' +
      'for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);' +
      'var m=new WebAssembly.Module(u);',
    'new WebAssembly.Instance(m).exports'
  );

  const byFile = new Map();
  for (const c of candidates) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }

  const done = [];
  for (const [file, list] of byFile) {
    let code = fs.readFileSync(file, 'utf8');
    if (code.includes('__essW')) {
      // 同一个文件里已经有内联 wasm(重复加固),再插一遍会重复实例化且替换点错位。
      console.warn(`[wasm] ${path.basename(file)} 里已存在内联 wasm,跳过该文件的替换。`);
      continue;
    }

    const sorted = list.slice().sort((a, b) => b.start - a.start);
    for (const c of sorted) {
      // 返回布尔的必须 !! 收一下 —— wasm 返回的是 1/0,不收就变成数字了
      const coerce = c.retKind === 'bool' ? '!!' : '';
      // wasm 侧的函数名已被抹成短名,这里必须用同一份映射,否则取不到导出。
      // JS 这边的函数名(c.name)保持不变 —— 它是用户代码的调用接口。
      const callName = ren.map.get(c.wasmName) || c.wasmName;
      const replacement =
        `function ${c.name}(${c.params.join(', ')}) { ` +
        `return ${coerce}__essW.${callName}(${c.params.join(', ')}); }`;
      code = code.slice(0, c.start) + replacement + code.slice(c.end);
      done.push(c.name);
    }
    fs.writeFileSync(file, runtime + code, 'utf8');
  }
  return done;
}

module.exports = { findCandidates, toAssemblyScript, compile, rewriteWithInlineWasm };
