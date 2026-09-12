// build.mjs — 把 core/core.ts 编译成 core.wasm,并按真实导出自动生成 wasm-loader.js
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// 本文件是 ESM,而 wasm-loader-gen.js / assemblyscript 是 CommonJS,用 createRequire 桥一下。
const require = createRequire(import.meta.url);
const { generateLoader } = require('../src/wasm-loader-gen.js');

// 走 assemblyscript 的 JS API,而不是 spawn 它的 CLI 二进制:
// Windows 下 node_modules/.bin/asc 是个 shell 脚本,execFileSync 直接跑会 ENOENT。
// 另外它的 package exports 只给 'assemblyscript/asc' 定义了 import(ESM)条件,
// 没有 require 条件 —— 所以必须用动态 import(),require() 会直接抛
// ERR_PACKAGE_PATH_NOT_EXPORTED。
const ascMod = await import('assemblyscript/asc');
const asc = ascMod.default || ascMod;

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, 'core', 'core.ts');
const outFile = path.join(dir, 'core', 'core.wasm');
const textFile = path.join(dir, 'core', 'core.wat');

// --runtime minimal: 不引入 GC,产物最小;仅基础数字类型,无需导出内存。
// --optimize: 开启优化。
// --textFile:  同时产出可读的 .wat 文本,方便人工确认导出了哪些函数。
const res = await asc.main(
  [entry, '--outFile', outFile, '--optimize', '--runtime', 'minimal', '--textFile', textFile],
  { stdout: process.stdout, stderr: process.stderr }
);

// 不同版本 asc.main 的返回值不一样:有的直接返回数字退出码,有的返回对象
// (形如 { code, stats })。统一取成数字,避免拿到对象去 process.exit 直接抛
// ERR_INVALID_ARG_TYPE。
const code =
  typeof res === 'number' ? res : res && typeof res.code === 'number' ? res.code : 0;

if (code !== 0) {
  console.error('asc 编译失败,退出码:', code);
  process.exit(code || 1);
}

console.log('core.wasm 已生成 ->', outFile);

// 按产物 core.wasm 的真实导出重新生成 wasm-loader.js。
// 你改了 core.ts 的 export,loader 自动跟上,不用手改。
const loaderPath = path.join(dir, 'src', 'wasm-loader.js');
const exportNames = generateLoader(outFile, loaderPath);
console.log(
  'wasm-loader.js 已按导出自动更新 ->',
  loaderPath,
  '\n  导出函数:',
  exportNames.length ? exportNames.join(', ') : '(无)'
);
