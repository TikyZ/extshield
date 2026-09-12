'use strict';

/**
 * 内联 wasm 运行时的统一外壳(自动下沉 / 手动下沉共用)。
 *
 * 为什么要包一层 try/catch:
 *   编译 WebAssembly 会被 CSP 当成"代码求值" —— MV3 扩展页默认 CSP 是
 *   script-src 'self',于是 new WebAssembly.Module() 直接抛 CompileError。
 *   这行以前写在文件最外层,一抛就把**整个** JS 文件带崩(实测:popup 整个白掉,
 *   不只是被下沉的那几个函数坏)。现在初始化失败只让相关函数报错,其余功能照常。
 *
 * 注意:真正让 wasm 能跑起来的还是 manifest 里放行 'wasm-unsafe-eval'
 * (见 wasm-sink.js 的 patchCsp)。这里的兜底只是防止"一处失败、全盘皆崩"。
 */
const HINT =
  "[extshield] wasm 未能初始化 —— 扩展页 CSP 需要放行 WebAssembly" +
  "(manifest.json 的 content_security_policy.extension_pages 里加 'wasm-unsafe-eval')";

/**
 * @param {string} bodyExpr 初始化语句(不含 return)
 * @param {string} tailExpr 初始化成功后要返回的表达式
 */
function guarded(bodyExpr, tailExpr) {
  const h = JSON.stringify(HINT);
  return (
    'var __essW=(function(){try{' +
    bodyExpr +
    'return ' +
    tailExpr +
    ';' +
    '}catch(e){console.error(' +
    h +
    ',e);' +
    'var f=function(){throw new Error(' +
    h +
    ')};' +
    'return new Proxy({},{get:f,apply:f});}})();\n'
  );
}

module.exports = { HINT, guarded };
