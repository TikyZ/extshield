// core/core.ts
// 用 AssemblyScript(语法基本就是 TypeScript 的子集)编写的「核心逻辑」模板。
//
// ── 这里放的就是"你最怕被抄的逻辑" ──
//   比如:授权令牌的签发/校验、签名算法、关键数值计算、自研的加解密/编码。
//   编译后它变成 core.wasm 二进制 —— 逆向的人拿到的是字节码,得先反汇编才能读,
//   比直接看 JS 源码的门槛高得多(注意:这是"抬高门槛",不是"绝对防不住")。
//
// ── 怎么换成你自己的逻辑 ──
//   1. 把下面的示例函数替换成你的实现,保持 export;
//   2. 跑 `node build.mjs` 重新编译;
//   3. wasm-loader.js 会按你的导出自动重新生成,**不用手改 loader**。
//
// ── 两个硬限制 ──
//   ① 只传基础数字类型(i32 / i64 / f32 / f64)。
//      编译用的是 --runtime minimal(不引入 GC,产物最小),
//      所以用不了 string / 数组 / 对象。复杂数据请在 JS 侧拆开逐个数传入。
//   ② 别在这里调 DOM / chrome.* API —— wasm 里没有这些;
//      只放"纯计算"逻辑,和浏览器的交互留给 JS 侧。

// 基于种子的令牌生成(示例)
// 手法:用几轮「异或 + 乘法 + 位移」把输入打散,让"输入→输出"的规律不易被猜出来。
// 这类"给一个种子算出一个令牌"的逻辑,正是最适合沉进 wasm 的东西 ——
// 沉进去之后,校验规则就不再以明文形式出现在 JS 里。
export function generateToken(seed: i32): i32 {
  let h: i32 = 2166136261;
  h = (h ^ seed) * 16777619;
  h = (h ^ (h >>> 15)) * 2246822519;
  return (h ^ (h >>> 13)) >>> 0;
}

// 校验令牌(示例)
// JS 侧只拿到 true / false,判定过程发生在 wasm 内部。
export function verifyToken(seed: i32, token: i32): bool {
  return generateToken(seed) == token;
}
