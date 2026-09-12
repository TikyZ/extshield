'use strict';

/**
 * 调 AssemblyScript 编译器(asc)的唯一入口 —— 三个坑全在这一处处理掉,
 * CLI 与 GUI、自动下沉与手动下沉共用,别再各写一份。
 *
 * 坑 1:package exports 只给 'assemblyscript/asc' 定义了 import(ESM)条件,
 *       没有 require。写 require(...) 直接抛 ERR_PACKAGE_PATH_NOT_EXPORTED,
 *       以前还被 catch 掉静默回退,导致"编译"这条路根本没跑通过。
 *
 * 坑 2:asc 会在**模块被 import 的那一刻**扫 process.argv 找它自己的
 *       --wasm <path>(不是等调用 main())。我们的 CLI 开关也叫 --wasm,
 *       于是它把我们 --wasm 后面那个不存在的参数当模块路径去 import,
 *       报 Cannot find module '<cwd>/undefined'。
 *       → 必须**先**把 argv 收干净**再** import,顺序反了照样崩。
 *
 * 坑 3:asc v0.28 的 main() 返回的是对象,且**没有数字退出码**
 *       (res.code 其实是 stdout 流,不是数字),编译错误在 res.error 里。
 *       以前只取 res.code,取不到就默认 0 —— 等于**把编译失败当成功**,
 *       于是拿着不存在的 wasm 继续往下走。
 *       → 这里既看 res.error,也回头确认产物文件真的生成了。
 */

const fs = require('fs');

async function compile(entry, outFile, opts = {}) {
  const realArgv = process.argv;
  // 只保留前两项,并过滤掉非字符串(node -e / REPL 下 argv 只有 1 项)
  process.argv = realArgv.slice(0, 2).filter((a) => typeof a === 'string');

  let ascMod;
  try {
    ascMod = await import('assemblyscript/asc');
  } catch (e) {
    process.argv = realArgv;
    throw e;
  }

  try {
    const asc = ascMod.default || ascMod;
    const argv = [
      entry,
      '--outFile',
      outFile,
      '--optimize',
      '--runtime',
      opts.runtime || 'minimal',
      // 字符串参数要靠 __new 在 wasm 内存里分配空间,
      // 不加这个标志就不导出 __new,JS 侧没法把字符串传进去。
      ...(opts.exportRuntime ? ['--exportRuntime'] : []),
    ];
    const res = await asc.main(argv, {
      stdout: process.stdout,
      stderr: process.stderr,
    });

    const code =
      typeof res === 'number'
        ? res
        : res && typeof res.code === 'number'
        ? res.code
        : res && res.error
        ? 1
        : 0;

    if (code !== 0) {
      throw new Error('asc 编译失败: ' + (res && res.error ? String(res.error) : '退出码 ' + code));
    }
    if (!fs.existsSync(outFile)) {
      throw new Error('asc 没产出 wasm 文件(很可能编译已失败): ' + outFile);
    }
    return 0;
  } finally {
    process.argv = realArgv;
  }
}

module.exports = { compile };
