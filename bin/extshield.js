#!/usr/bin/env node
'use strict';

/**
 * extshield — Chrome 扩展压缩合规加固 CLI
 *
 * 子命令:
 *   harden   对扩展源码做合规加固(激进压缩 + 改名 + 去注释/sourcemap)
 *   verify   扫描打包产物,识别会触发商店审核红线的风险模式
 *   demo     用内置示例扩展跑一遍 harden + verify,验证工具可用
 *
 * 设计原则:只做 Chrome Web Store 政策允许的"压缩(minification)",
 * 不做被禁止的"混淆(obfuscation:字符串加密 / 控制流平坦化 / eval 解密代码)"。
 * 真正的逆向抗性是靠 verify 守住红线 + 把核心逻辑下沉到 WASM/服务端。
 */

const path = require('path');
const fs = require('fs');

const HARDEN = require('../src/harden');
const VERIFY = require('../src/verify');
const CONFIG = require('../src/config');

function printHelp() {
  console.log(`
extshield — Chrome 扩展压缩合规加固工具

用法:
  extshield harden [--src <dir>] [--out <dir>] [--config <file>] [--mangle-props] [--wasm]
  extshield verify [--dir <dir>] [--config <file>] [--strict]
  extshield demo [--wasm]

选项:
  --src <dir>          扩展源码目录 (默认 ./src 或配置里的 srcDir)
  --out <dir>          加固输出目录 (默认 ./dist)
  --config <file>      配置文件路径 (默认 ./extshield.config.js)
  --mangle-props       在 esbuild 压缩后再用 terser 做属性名改名(更激进,
                       但可能破坏跨文件/外部 API 调用,需谨慎并靠 verify 兜底)
  --wasm               启用 WASM 下沉:把纯计算函数编译进 wasm,提高复刻门槛
  --wasm-core <file>   手动下沉:指定你自己的 core.ts(不指定则走规则分析自动下沉)
  --keep-stage         保留 WASM 下沉用的临时工作副本(调试用,会打印路径)
  --strict             任意高风险命中即视为不通过(用于 CI 卡口)
  -h, --help           显示此帮助

说明:
  本工具刻意不做字符串加密、控制流平坦化、eval(解密代码) 等被 Chrome
  Web Store 明令禁止的混淆手段——那会直接导致审核拒绝。它在"合规"前提
  下尽可能提高逆向门槛:激进 minify + 标识符改名 + 去注释/sourcemap,并
  用 verify 在上传前自动拦住一切踩红线的苗头。

WASM 下沉 (--wasm):
  把"纯计算"的函数编译进 WebAssembly,别人拿到包看到的是 wasm 字节码,
  要读懂需先反汇编 —— 复刻门槛比裸 JS 高一截,而且它是 Chrome 政策允许的
  (不是加密,审核能过)。
  不指定 --wasm-core 时走规则分析自动下沉:扫你的源码,挑出只做数值运算、
  不碰浏览器 API 的函数,自动生成 core.ts 并编译内联,无需编写任何 wasm 代码。
  想自己掌控核心逻辑,就写个 core.ts 用 --wasm-core 指定,工具会优先使用它。
  注意:自动下沉只在临时副本上修改,你的原始源码不会被改动。
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === '--mangle-props') {
      args.mangleProps = true;
    } else if (a === '--strict') {
      args.strict = true;
    } else if (a === '--wasm') {
      args.wasm = true;
    } else if (a === '--keep-stage') {
      args.keepStage = true;
    } else if (a === '--wasm-core') {
      args.wasmCore = argv[++i];
    } else if (a === '--src') {
      args.src = argv[++i];
    } else if (a === '--out') {
      args.out = argv[++i];
    } else if (a === '--dir') {
      args.dir = argv[++i];
    } else if (a === '--config') {
      args.config = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

/**
 * 打印 WASM 下沉结果(只讲人话,不甩术语)。
 */
function printWasmSummary(info) {
  const label = {
    'user-core': '手动下沉(用了你自己的 core.ts)',
    auto: '自动下沉(规则分析,函数已内联进 JS)',
    'auto-empty': '没有找到可下沉的纯计算函数,本次未下沉',
    'compile-failed': 'core.ts 编译失败,本次未下沉',
    'auto-failed': '自动下沉失败,本次未下沉',
  };
  console.log(`\n[wasm] 结果: ${label[info.source] || info.source || '(未启用)'}`);
  if (info.source === 'auto-empty') {
    console.log(
      `[wasm] 扫了 ${info.scanned || 0} 个函数,一个都没看上 —— ` +
        '它们都碰了浏览器/扩展 API,或不是纯数值运算。'
    );
    console.log('[wasm] 包里不会有 wasm(不会拿示例 wasm 充数),你的逻辑仍在 JS 里。');
    console.log('[wasm] 想真正下沉:把核心算法拆成只做数值计算的独立函数,或用 --wasm-core 指定 core.ts。');
  }
  if (info.sunk && info.sunk.length) {
    console.log(`[wasm] 已下沉 ${info.sunk.length} 个函数: ${info.sunk.join(', ')}`);
  }
  if (info.exports && info.exports.length) {
    console.log(`[wasm] core.wasm 导出: ${info.exports.join(', ')}`);
  }
  if (info.skipped && info.skipped.length) {
    console.log(`[wasm] 以下函数没下沉(属正常,它们碰了浏览器能力/非数值类型):`);
    for (const s of info.skipped.slice(0, 10)) {
      console.log(`    - ${s.name}  ${s.reason}`);
    }
    if (info.skipped.length > 10) {
      console.log(`    ... 还有 ${info.skipped.length - 10} 个`);
    }
  }
}

/**
 * harden 的统一入口(含可选 WASM 下沉)。
 *
 * 顺序不能乱,每一步都是踩过坑定下来的:
 *   ① 先把源码复制一份到临时区 —— 自动下沉是"就地重写 .js"的,
 *      直接对用户工程目录动手等于改了人家的源码,必须隔离;
 *   ② 在副本上做下沉(prepare):改 .js / 编译 core.ts;
 *   ③ 拿副本跑 harden;
 *   ④ harden 之后再做收尾(finalize):补 manifest 的 CSP 放行(以及
 *      手动下沉时产出的 loader)—— 写早了会被"清空输出目录"那一步
 *      一起删掉,loader 根本进不了包。
 */
async function runHarden(cfg, args = {}) {
  const WASM = require('../src/wasm-sink');
  let stageRoot = null;
  let workDir = null;
  let wasmInfo = { enabled: false, source: null, exports: [], sunk: [], skipped: [] };

  if (cfg.wasm) {
    stageRoot = WASM.makeWorkDir('extshield-stage-');
    const stageDir = path.join(stageRoot, 'src');
    WASM.stageSource(cfg.srcDir, stageDir, cfg.ignore);
    workDir = WASM.makeWorkDir('extshield-wasm-');
    cfg.srcDir = stageDir; // 之后所有操作都在副本上,你的原始源码一行不动
    console.log(`[wasm] 已启用下沉,工作副本: ${stageDir}`);

    wasmInfo = await WASM.prepare(cfg, {
      coreTs: cfg.wasmCore ? path.resolve(cfg.wasmCore) : null,
      workDir,
    });
    wasmInfo.enabled = true;
  }

  await HARDEN.run(cfg);

  if (cfg.wasm) {
    WASM.finalize(cfg, wasmInfo);
    printWasmSummary(wasmInfo);
  }

  // 清理临时工作区(--keep-stage 时保留,方便你检查副本里到底改了什么)
  if (!args.keepStage) {
    for (const d of [stageRoot, workDir]) {
      if (!d) continue;
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // 删不掉不是致命问题(某些安全软件会拦批量删除),留着也不影响产物
      }
    }
  } else if (stageRoot) {
    console.log(`[wasm] 已保留工作副本(--keep-stage): ${path.join(stageRoot, 'src')}`);
  }
}

async function run() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (args.help || !cmd) {
    printHelp();
    return;
  }

  if (cmd === 'harden') {
    const cfg = CONFIG.load(args.config || 'extshield.config.js', {
      srcDir: args.src,
      outDir: args.out,
      mangleProps: args.mangleProps,
      wasm: args.wasm ? true : undefined,
      wasmCore: args.wasmCore,
    });
    await runHarden(cfg, args);
    return;
  }

  if (cmd === 'verify') {
    const cfg = CONFIG.load(
      args.config || 'extshield.config.js',
      { outDir: args.dir },
      { requireEntries: false }
    );
    const report = await VERIFY.run(cfg, { strict: args.strict });
    process.exit(report.exitCode);
    return;
  }

  if (cmd === 'demo') {
    const demoSrc = path.join(__dirname, '..', 'sample');
    const demoOut = path.join(__dirname, '..', 'sample-dist');
    const cfg = CONFIG.load(null, {
      srcDir: demoSrc,
      outDir: demoOut,
      mangleProps: true,
      wasm: args.wasm ? true : undefined,
    });
    console.log('==> [1/2] harden 示例扩展');
    await runHarden(cfg, args);
    console.log('\n==> [2/2] verify 加固产物');
    const report = await VERIFY.run(cfg, { strict: false });
    process.exit(report.exitCode);
    return;
  }

  console.error(`未知子命令: ${cmd}\n`);
  printHelp();
  process.exit(2);
}

run().catch((err) => {
  console.error('运行出错:', err && err.stack ? err.stack : err);
  process.exit(1);
});
