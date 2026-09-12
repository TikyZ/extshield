'use strict';

/**
 * extshield 配置文件示例。
 * 放到扩展项目根目录,命名为 extshield.config.js 即可被自动读取。
 * 所有字段均可选,不填用默认值。
 */
module.exports = {
  // 源码目录(相对本配置所在目录,或绝对路径)
  srcDir: 'src',

  // 加固输出目录
  outDir: 'dist',

  // 入口 js。留空则从 manifest.json 自动探测
  // entries: ['background.js', 'content.js', 'popup.js'],

  // 是否额外用 terser 做属性名改名(更激进,可能破坏外部调用,需谨慎)
  mangleProps: false,

  // 是否丢弃 console.* / debugger
  dropConsole: true,

  // 是否剥离所有注释(含 license 注释)。要保留 license 请设为 false
  stripComments: true,

  // 属性改名时保留的名字(避免破坏 chrome / DOM API 等)
  reservedProps: [
    'chrome', 'browser', 'window', 'document', 'location', 'navigator',
    'self', 'globalThis', 'localStorage', 'sessionStorage', 'console',
    'fetch', 'JSON', 'Math', 'Date', 'RegExp', 'Promise',
  ],

  // 静态资源拷贝时跳过的目录
  ignore: ['node_modules', '.git', 'dist'],
};
