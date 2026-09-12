'use strict';

/**
 * 合规扫描规则。
 *
 * 这些规则专门用来识别"会触发 Chrome Web Store 审核红线"的模式——
 * 也就是被官方明令禁止的 obfuscation 手法,而非正常的 minify。
 *
 * severity:
 *   high   高危,几乎必然被判定为混淆 -> 必须修掉才能上传
 *   medium 中等风险,可能是无意引入,需要人工确认
 *   info   信息项,提示而非阻断
 *
 * 注意:很多正常库(如某些加密 SDK)也会命中 atob/fromCharCode,
 * 所以命中 != 违规,但需要你能在审核时解释清楚用途。verify 只负责
 * 把"雷"标出来。
 */

module.exports = [
  {
    id: 'eval',
    name: 'eval() 直接执行',
    severity: 'high',
    // 直接调用 eval( 或 window.eval(
    pattern: /\beval\s*\(/,
    message:
      '出现 eval()。动态执行字符串是典型的混淆/远程代码特征,Chrome 明令禁止。' +
      '除非是极特殊的合法用途(且能在审核中解释),否则应移除。',
  },
  {
    id: 'new-function',
    name: 'new Function() 动态构造',
    severity: 'high',
    pattern: /\bnew\s+Function\s*\(/,
    message:
      'new Function(...) 会动态编译字符串为代码,属于被禁止的动态执行。',
  },
  {
    id: 'settimeout-string',
    name: 'setTimeout/setInterval 传入字符串',
    severity: 'high',
    pattern: /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/,
    message:
      '把字符串传给 setTimeout/setInterval 会被当作代码执行,等同于 eval。',
  },
  {
    id: 'atob-decode',
    name: 'atob/btoa 解码链',
    severity: 'medium',
    pattern: /\batob\s*\(|\bbtoa\s*\(/,
    message:
      'atob/btoa 常出现在"字符串先 base64 再解密执行"的混淆套路里。' +
      '若仅用于正常编解码(如图标/数据),请确认没有配合 eval/new Function 使用。',
  },
  {
    id: 'string-fromcharcode',
    name: 'fromCharCode 解码循环',
    severity: 'medium',
    pattern: /\bString\.fromCharCode\s*\(/,
    message:
      'fromCharCode 用于把数字数组还原成字符串,常见于隐藏真实字符串的混淆。',
  },
  {
    id: 'decode-uricomponent',
    name: 'decodeURIComponent 解码',
    severity: 'medium',
    pattern: /\bdecodeURIComponent\s*\(/,
    message: 'decodeURIComponent 偶尔出现在字符串隐藏套路,确认是否必要。',
  },
  {
    id: 'hex-string-table',
    name: '长 \\xHH 十六进制字符串',
    severity: 'medium',
    // 一段文本里密集出现 \x 转义,通常是被编码隐藏的字符串
    pattern: /(\\x[0-9a-fA-F]{2}){6,}/,
    message:
      '检测到密集的 \\xHH 十六进制转义字符串,这是常见的字符串隐藏手法。',
  },
  {
    id: 'long-base64-table',
    name: '超长 base64 常量(疑似字符串表)',
    severity: 'medium',
    // 单个字符串里出现很长且不含空格的 base64 串。
    // 负向前瞻排除常见图片的 base64 魔数(PNG / JPEG / GIF / BMP / WebP / SVG / XML),
    // 否则内联的 base64 图标、字体、SVG 会被大量误报——那种属于正常资源,不是字符串表。
    pattern:
      /["'`](?!(?:iVBORw0|\/9j\/|R0lGOD|Qk0|UklGR|PHN2Z|PD94b|AAABAA))[A-Za-z0-9+/]{120,}={0,2}["'`]/,
    message:
      '出现超长 base64 字符串常量。minify 不会生成这种东西,通常是被加密/编码的' +
      '逻辑或资源。若配合解码后执行,属于违规混淆。' +
      '(已排除 PNG/JPEG/GIF/WebP/SVG 等图片资源的 base64 头,不会误报内联图标)',
  },
  {
    id: 'obfuscator-hex-vars',
    name: '混淆器特征变量名(_0x...)',
    severity: 'medium',
    pattern: /\b_[0-9a-fA-F]{2,}\b/,
    message:
      '出现 _0x 风格的十六进制变量名,这是 javascript-obfuscator 等工具的典型产物。' +
      '本工具的 minify 不会产生这种命名,命中说明你源码里混入了被混淆的代码。',
  },
  {
    id: 'control-flow-flattening',
    name: '控制流平坦化特征',
    severity: 'high',
    // 识别常见的 switch 分发器 + while(true) 状态机形态
    pattern:
      /\bwhile\s*\(\s*true\s*\)\s*\{[\s\S]{0,200}?switch\s*\(\s*[a-zA-Z_$][\w$]*\s*\)/,
    message:
      '疑似控制流平坦化(while(true)+switch 状态机)。这是被明确禁止的混淆手法。',
  },
  {
    id: 'constructor-constructor',
    name: 'Function 构造器逃逸',
    severity: 'high',
    pattern: /\.constructor\.constructor\s*\(/,
    message:
      '通过 .constructor.constructor 拿到 Function 再执行字符串,是进阶版动态执行。',
  },
  {
    id: 'sourcemap-residual',
    name: 'sourceMappingURL 残留',
    severity: 'info',
    pattern: /(?:sourceMappingURL|=sourceMappingURL)/,
    message:
      '产物里残留了 sourceMappingURL。虽然不违规,但等于把源码地图交出去,' +
      '建议发布包里不要带 sourcemap。',
  },
  {
    id: 'remote-code',
    name: '远程代码加载特征',
    severity: 'high',
    pattern: /\b(?:importScripts|chrome\.scripting\.executeScript)\s*\([^)]*https?:\/\//,
    message:
      '从远程 URL 加载/执行脚本是被限制的行为,需确认属于 Manifest V3 合规用法。',
  },
];
