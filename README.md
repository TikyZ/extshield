# extshield — Chrome 扩展压缩合规加固工具

<p>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg" />
</p>

> 在**不踩 Chrome Web Store 审核红线**的前提下,尽量提高扩展被逆向复刻的门槛。
>
> 激进压缩(esbuild)+ 属性改名(terser)+ WASM 下沉 + 上传前合规扫描,附带一个本地可视化打包器。

## 目录

- [作用](#作用)
- [安装](#安装)
- [使用](#使用)
- [配置文件](#配置文件-extshieldconfigjs)
- [可视化打包器(GUI)](#可视化打包器gui)
- [目录结构](#目录结构)
- [开发与测试](#开发与测试)
- [CI 集成示例(GitHub Actions)](#ci-集成示例github-actions)
- [隐私说明](#隐私说明)
- [防范程度](#防范程度)
- [免责声明](#免责声明)
- [第三方依赖与许可](#第三方依赖与许可)
- [许可证](#许可证)

## 作用

Chrome Web Store 政策**明确禁止 obfuscation(混淆)**,但**允许 minification(压缩)**。

| 手段 | 是否允许 | 说明 |
|------|----------|------|
| 去空白/注释、缩短变量名、合并文件 | ✅ 允许 | 这就是 minification |
| 属性名改名(terser mangle) | ✅ 允许(需谨慎) | 更激进,可能破坏跨文件调用 |
| 字符串加密 / 控制流平坦化 / `eval(解密代码)` | ❌ **禁止** | 直接判定为混淆,审核拒绝 |

真正能称得上"代码保护"的合规路径只有两条:
1. **把核心逻辑下沉到服务端** —— 代码根本不进客户端(扩展只做请求+展示),他人拿不到;
2. **把关键计算编译成 WASM** —— 代码在客户端,但天然难逆向,且不属于 JS 混淆。

两条性质不同:一条是"让他人拿不到代码",一条是"拿到了也难读"。

本工具解决的是第 0 步:用合规手段把 JS 压到"能读但很难读",并在上传前
用 `verify` 自动拦住一切会踩红线的苗头——**避免你"阴差阳错"把违规代码传上去**。

## 安装

环境要求:**Node.js ≥ 18**(用到 `fs.rmSync` 等较新 API;Windows / macOS / Linux 均可)。

```bash
cd extshield
npm install        # 依赖:esbuild / terser / acorn / assemblyscript
```

## 使用

### 1) 加固(harden)

```bash
# 用当前目录的 extshield.config.js
node bin/extshield.js harden

# 指定目录 / 开启属性改名
node bin/extshield.js harden --src ./src --out ./dist --mangle-props
```

做了什么:
- 从 `manifest.json` 自动探测入口(background / content / popup / options);
- 用 esbuild 做 bundle + 激进压缩(去空白、改名、tree-shaking、去 `console`/`debugger`、去注释);
- 拷贝 manifest / html / css / 图片等静态资源;
- 可选:terser 属性名改名(`--mangle-props`)。

### 2) 合规扫描(verify)

```bash
node bin/extshield.js verify --dir ./dist
node bin/extshield.js verify --dir ./dist --strict   # CI 卡口:中等风险也判不通过
```

会扫描产物,识别这些**高危/中等**模式并报告:
`eval()`、`new Function()`、`setTimeout` 传字符串、`atob/btoa` 解密链、
`fromCharCode` 解码、长 base64 字符串表、`_0x` 混淆器变量名、控制流平坦化、
`constructor.constructor` 逃逸、`sourceMappingURL` 残留、远程代码加载等。

`verify` 退出码:通过 `0`,存在高危项 `1`(strict 下含中等项)。可直接接 CI。

### 3) 一键演示(demo)

```bash
node bin/extshield.js demo
```

用内置 `sample/` 扩展执行一遍 harden + verify,验证工具是否可用。

加 `--wasm` 可一并查看 WASM 下沉的效果:

```bash
node bin/extshield.js demo --wasm
```

### 4) WASM 下沉(--wasm)

把"纯计算"的函数编译进 WebAssembly。产物里是 wasm 字节码,想读懂需先反汇编 ——
复刻门槛明显高于纯 JS。它是 Chrome 政策允许的(属于编译产物,而非加密),审核能过。

```bash
# 自动下沉:由工具扫描你的源码,挑出适合的函数
node bin/extshield.js harden --src ./src --out ./dist --wasm

# 手动下沉:使用你自己编写的 core.ts(优先级更高)
node bin/extshield.js harden --src ./src --out ./dist --wasm --wasm-core ./core.ts
```

两种方式的区别:

| | 自动下沉(默认) | 手动下沉(`--wasm-core`) |
|---|---|---|
| 你要做什么 | 无需任何操作 | 自行编写 `core.ts` |
| 挑哪些函数 | 工具按规则扫描:只做数值运算、不涉及浏览器 API 的 | 由你决定 |
| 产物形态 | **wasm 以 base64 内联进 JS,同步调用** | **同样是内联**(不产出 `core.wasm` / loader) |
| 要不要改 manifest | 无需修改 | 无需修改(但工具会自动补上 CSP 放行,见下) |
| 调用点 | 无需改动 | 无需改动(同名函数自动替换) |
| 适合 | 想快速见效 / 不想接触 wasm | 想把核心算法掌握在自己手中 |

> 手动下沉以前会产出独立的 `core.wasm` + `wasm-loader.js`(需要 `web_accessible_resources`、
> 调用点还得改成 `await`)。现在改成**和自动下沉一样内联**:同步实例化,调用点无需改动,
> 也不会多出可在 `chrome-extension://` 直接下载的 wasm 文件。

### ⚠️ 内联 wasm 之后,必须放行 CSP(必读)

这是实测遇到过的问题:MV3 扩展页默认 CSP 是 `script-src 'self'`,而**编译 WebAssembly 被
CSP 当成代码求值**,于是内联进 `popup` / `service worker` 的 wasm 会被直接拦下,报:

```
CompileError: WebAssembly.Module(): ... violates the following CSP directive: "script-src 'self'"
```

工具现在会**自动补上**这段(只追加、不覆盖你原有的指令,重复执行不会重复改写):

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
}
```

三条硬约束(已核对 Chrome 官方文档):

- `script-src` / `object-src` / `worker-src` **只允许** `self` / `none` / `wasm-unsafe-eval`。
  写 `'unsafe-eval'` 会让扩展**安装直接失败**,绝不可为图省事而加上。
- `'wasm-unsafe-eval'` 只放行 wasm、不放行 `eval`,Chrome 商店接受。
- 用的是**隔离世界**的 `content script`?无需处理 CSP —— Chrome 给隔离世界的默认 CSP
  **本来就带** `'wasm-unsafe-eval'`,`script-src 'self' 'wasm-unsafe-eval' ...`,wasm 能正常跑。
  但显式写了 `"world": "MAIN"` 的 content script 会注入网页主世界,**套用网页自己的 CSP**,
  严格站点会拦掉 wasm —— 所以工具**只把这类文件排除在下沉之外**,隔离世界的照常下沉。
  (用 `chrome.scripting.executeScript({world:'MAIN'})` 动态注入的脚本不在 manifest 里,
  工具看不到,需要自行避开。)

参考:<https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>

几个要提前知道的点:

- **自动下沉不会改动你的源码**。它会先把源码复制一份到临时目录,在副本上修改,
  产物从副本打包;你的工程目录不会被改动。如需保留副本检查,加 `--keep-stage`。
- **不是所有函数都能沉**。涉及 `chrome.*` / `document` / `fetch`,或者用了
  字符串、数组、对象的函数会被跳过 —— 这些无法在 wasm 里运行。跳过时工具会
  逐个打印跳过原因,不会静默忽略。
- **没有可下沉的函数时,不会用示例 wasm 顶替**。工具会明确说明扫描了多少个
  函数、为什么一个都没有入选,产物里不会有 wasm —— 宁可如实报告"未下沉",也不会制造
  "包里有 core.wasm 就等于已受保护"的错觉(这是早期版本遇到过的问题)。
- **它只对"有纯计算逻辑"的扩展有用**。如果你的插件主要是 UI 和 DOM 操作
  (像绝大多数弹窗类插件),可能一个函数都无法下沉 —— 这属于正常情况,
  此时起作用的只有压缩 + 合规扫描,不要指望 WASM。
- 想让更多函数可下沉,就把"纯计算"部分拆成独立函数,避免与 DOM / 存储操作混写。

配置文件里也可以开启:`wasm: true` / `wasmCore: './core.ts'`。

## 配置文件 `extshield.config.js`

放到项目根目录即可被自动读取,字段全可选,见 `templates/extshield.config.js`。

## 防范程度

- ✅ **可逆但费力**:minify + 改名后,源码逻辑仍在,只是变量名变成 `a/b/c`、
  结构被打平。逆向者需要额外的时间成本,但无法 100% 阻挡有决心的逆向者。
- ❌ **不提供**:字符串加密、控制流平坦化、反调试——这些是政策明文禁止的,本工具
  **刻意不做**,因为那会导致上架失败。
- 🔒 **真正有效**:核心算法走服务端 API,或编译成 WASM。CLI 加 `--wasm` 即可
  (默认按规则自动下沉,也可用 `--wasm-core` 指定自己的 `core.ts`);
  GUI 里勾 WASM 是同一套逻辑(CLI / GUI 共用 `src/wasm-sink.js`)。
  `wasm-template/` 另有一份**独立**的 AssemblyScript 示例 + 编译脚本 + loader,
  适合希望手工走传统"单独 `core.wasm` 文件"路线的人,和工具的内联方案互不影响。

## CI 集成示例(GitHub Actions)

```yaml
- name: 加固并校验
  run: |
    npm ci
    node bin/extshield.js harden
    node bin/extshield.js verify --dir ./dist --strict
```

## 可视化打包器(GUI)

不想敲命令?进 `gui/` 启动一个本地 Web 应用:选文件夹 → 选方式 → 选保存位置 → 一键合规打包,
打包完成后同时在页面上给出合规扫描报告。

```bash
node gui/server.js   # 打开 http://localhost:4173
```

两种方式(minify / wasm)都做成可视化按钮,详见 `gui/README.md`。

服务只绑定 `127.0.0.1`,并校验 Host / Origin / `Sec-Fetch-Site`,阻断 DNS rebinding 与跨站请求。

## 目录结构

```
extshield/
├── bin/extshield.js        CLI 入口(harden / verify / demo)
├── src/
│   ├── harden.js           esbuild 打包 + 激进压缩(+ 可选 terser 属性改名)
│   ├── verify.js           scan() 纯函数扫描 + run() CLI 包装(退出码)
│   ├── rules.js            合规规则库(高危 / 中等 / 提示)
│   ├── config.js           DEFAULTS + 从 manifest 自动探测入口
│   ├── auto-sink.js        自动下沉引擎(acorn 扫 AST 选函数 → AssemblyScript)
│   ├── manual-sink.js      手动下沉(编译你的 core.ts,替换同名函数)
│   ├── wasm-sink.js        CLI / GUI 共用的下沉编排(prepare / finalize)
│   ├── zip.js              纯 Node 打 zip(不依赖外部命令)
│   └── asc.js / runtime-gen.js / wasm-loader-gen.js   编译与运行时生成
├── gui/                    本地可视化打包器(server.js + public/)
├── templates/              配置文件模板
├── wasm-template/          独立的 AssemblyScript 示例(可选,见下)
├── sample/                 内置示例扩展(demo 用)
└── test/e2e-wasm.js        端到端回归(npm test)
```

> `wasm-template/` 是给"想自己写 wasm、不使用工具的自动下沉"的人准备的**独立模板**:
> 它编译出单独的 `core.wasm` + `wasm-loader.js`(需要 `web_accessible_resources`),
> 和本工具的**内联**方案不同,按需取用。

## 开发与测试

```bash
npm test            # 端到端回归:自动下沉 / 手动下沉 / 字符串语义 / CSP / 边界安全
```

`test/e2e-wasm.js` 会实际启动一次 GUI 打包服务(随机端口)、实际编译一次 wasm、再解出产物并实际运行,验证"下沉后与原 JS 输出一致"——而非仅检查文件是否存在。

## 隐私说明

- **GUI 模式**:你上传的扩展源码会临时写入 `gui/.work/<任务ID>/` 用于处理,
  **打包完成后立即删除**,不在磁盘留存;服务启动时也会清空一次 `gui/.work/`,
  兜底清理上次异常退出(强杀 / 断电)留下的副本。
- **CLI 模式**:全程只读写你指定的 `--src` / `--out` 目录;开启 `--wasm` 时会额外在系统
  临时目录建一份源码副本(下沉必须改文件,不能在你的工程目录中就地修改),运行结束后自动删除,
  加 `--keep-stage` 可保留下来检查。
- 两种模式都**不联网**,不会把源码发往任何外部服务器。
- 建议:不要把 `gui/.work/` 纳入自己的备份或同步范围。

## 免责声明

- 本工具只做 Chrome Web Store 政策**允许**的压缩与 WASM 下沉,**不提供**任何被禁止的
  混淆手段。能否通过审核最终由 Chrome Web Store 判定,本工具不对此作保证。
- 压缩 / 属性改名可能**破坏**依赖原变量名或属性名的代码(跨文件调用、外部 API、
  消息键等)。请先在小范围验证,并用 `verify` 复检。
- 产物请自行做好版本管理与备份,使用本工具产生的一切后果由使用者自负。

## 第三方依赖与许可

本项目自身以 MIT 发布;用到的第三方组件共 16 个(直接依赖 4 个、传递依赖 12 个),
**全部是宽松许可(MIT / BSD-2-Clause / BSD-3-Clause / Apache-2.0),不含 GPL / AGPL / LGPL
等传染性许可**,因此不影响本项目继续以 MIT 发布,也不影响你对自己产出的扩展包自行授权。

各组件的版本、许可与版权归属见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) —— 它由
`scripts/gen-notices.js` 直接从实际安装的依赖中生成(不联网、不推测),依赖变动后运行
`npm run notices` 重新生成。

三点值得留意:

- **只是通过 npm 安装使用**:无需额外动作。每个依赖包自带自己的 `LICENSE`,由它自己满足
  "保留版权声明"的义务;声明文件的作用是可读与审计(企业内部做开源许可审查时常被要求提供)。
- **如果你把依赖打包进发布物**(离线包 / 单文件 / 免安装发行):则**必须**同时附上各组件的
  许可全文,Apache-2.0 组件还需保留其 `NOTICE`。声明文件末尾给出了可直接使用的生成命令。
- **启用 `--wasm` 时**:产出的 wasm 二进制里内联了 AssemblyScript 的运行时(它派生自
  TypeScript / Binaryen / musl libc / V8 / Arm Optimized Routines),按 Apache-2.0 建议随产物
  保留其归属声明 —— 摘要见声明文件第四节。

## 许可证

本项目采用 MIT 许可证,详见 [LICENSE](./LICENSE)。
