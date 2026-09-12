# WASM 下沉方案（内部开发记录）

> ⚠️ 这是一份**历史开发记录**,不是用户文档:记的是当时的现状与踩坑过程,部分结论
> 已被后续实现推翻（比如"自动下沉放后面单独做"、"不需要 AI"）。**功能现状一律以
> [README](./README.md) 为准。**

> 目标：先把「手动下沉」这条路做扎实、名副其实。自动下沉（AI 抽取）放后面单独做，本次不涉及。

---

## 一、现在什么情况

分两层看，这两层别混：

| 层 | 状态 | 说明 |
|---|---|---|
| **机制层**：编译 / 打包 / 注入 manifest | ✅ 已实现 | `server.js` 里 `compileCore`（自带 `core.ts` 时编译）、`copyTemplateWasm`（没有就用内置模板）、`patchManifestWasm`（注入 `web_accessible_resources`），并把 `wasm-loader.js` 拷进产物 |
| **价值层**：把"该保护的逻辑"沉进 WASM | ❌ 没做 | 工具**不分析**你的代码、**不挑选**逻辑。只能手动：你把逻辑写进 `core.ts`，它才编译你的东西 |

**现在的真实现象**：选了「WASM 下沉」但没自带 `core.ts` → 打包进去的是内置示例模板（里面是 `generateToken` / `verifyToken` / `fib` 三个占位函数），**不是你的任何逻辑**。

`harden.js` 全程不碰 WASM，只把 `.wasm` 当静态资源原样拷贝——所以自动下沉这件事现在**完全没有入口**。

---

## 二、手动版要做到什么效果

一句话：

> 用户把想保护的逻辑写进 `core.ts`，其余（编译、生成 loader、注入 manifest、报告）全自动，且**不会出现"以为沉了自己的、实际是 demo"这种误导**。

---

## 三、要改的清单

### 先做（P0）—— 让手动下沉真正可用

**1. 重写 `core.ts` 骨架，删掉 `fib` 这类废代码**
- 现在：`generateToken` / `verifyToken` / `fib`，其中 `fib`（斐波那契）纯占位、无意义。
- 改成：保留"令牌签发 / 校验"这类**真正适合下沉**的场景，补详细注释说明「这里放你最怕被抄的逻辑」，删掉 `fib`。

**2. loader 自动跟着 `core.ts` 走（不再手写三个导出）**
- 现在：`wasm-loader.js` 硬编码 `generateToken/verifyToken/fib`。用户改了 `core.ts` 的导出，loader 就断。
- 改成：在 `build.mjs` 编译后，从产物（`.wat` 或 wasm 导出表）读出导出函数名，**自动生成** `wasm-loader.js` 的包装函数。
- 好处：用户只管改 `core.ts`，不用碰 loader。

**3. 去掉"静默降级"，明确告知 WASM 来源**
- 现在：用户自带 `core.ts` 但编译失败 → 只 `console.warn`，然后**悄悄**回退到内置模板，用户完全不知情。
- 改成：把「WASM 来源」写进打包结果 / 合规报告，三选一显示：
  - `你的 core.ts（编译成功）`
  - `内置示例模板（未提供 core.ts）`
  - `编译失败，已回退示例模板`
- GUI 和 CLI 都要能看到。

### 再做（P1）—— 让反馈和合规更清楚

**4. 合规报告里加一行 WASM 状态**
- 改 `server.js` 的 report 结构，把「WASM 来源」带回去；`app.js` 在 GUI 第 4 步报告区渲染出来。

**5. 扩充 `src/rules.js` 合规规则**
- 现在 13 条。补几条和「WASM / 远程代码 / 字符串隐藏」相关的，例如：
  - 远程拉取 `.wasm`（违反随包发布原则，属红线）
  - 密集 unicode 转义（`\uXXXX` 串，常见字符串隐藏）
  - 大数字数组（疑似还原字符串的编码表）
- 这部分 AI 可以帮忙生成 / 补全正则。

### 收尾（P2）—— 稳健性和说明书

**6. loader 加错误处理**：`core.wasm` 缺失或被 CSP 拦时，现在会抛未捕获异常。改成 try/catch + 明确报错。

**7. 写清 MV3 Service Worker 的坑**：WASM 实例在 SW 里**跨事件不保留**，loader 的单例缓存只在**单次 SW 生命周期**内有效。要写进模板注释 / README，免得用户误以为缓存永久有效。

**8. `web_accessible_resources` 作用域**：现在是 `<all_urls>`，偏宽。加注释说明为什么需要它，或按最小需要收紧。

**9. UI 文案收实**：现在写「把核心逻辑编译成 WebAssembly 二进制」容易让人以为会自动沉他的代码。改成类似：
> 把你写进 `core.ts` 的核心逻辑编译成 WASM（不提供则使用示例模板）

---

## 四、要动哪些文件

| 文件 | 改什么 |
|---|---|
| `wasm-template/core/core.ts` | 重写骨架、删 `fib`、补注释 |
| `wasm-template/build.mjs` | 编译后解析导出表 → 自动生成 `wasm-loader.js` |
| `wasm-template/src/wasm-loader.js` | 改为生成产物；加 try/catch |
| `gui/server.js` | WASM 来源写进 report；编译失败不再静默回退 |
| `src/rules.js` | 补合规规则 |
| `gui/public/app.js` / `index.html` | 报告区显示 WASM 来源；UI 文案收实 |
| `README.md` / `gui/README.md` | 手动下沉契约说明 + MV3 生命周期坑 |

---

## 五、做完怎么验收

- [ ] 自带 `core.ts` → 产物 `core.wasm` 的导出确实是自己的函数（用 `.wat` 或导出表确认）
- [ ] 改了 `core.ts` 的导出 → loader 自动跟着变，**不用手改 loader**
- [ ] 不自带 `core.ts` → 报告明确写「使用内置示例模板」，不误导
- [ ] 自带但故意写错 → 明确报「编译失败，已回退」，不静默
- [ ] 新加的合规规则能命中，且不误报正常代码
- [ ] GUI 报告区能看到 WASM 来源那一行
- [ ] `npm run demo` / 实际打包端到端跑一遍全绿

---

## 六、自动下沉（原计划说要 LLM，实测不需要 —— 见第八节）

让工具自动分析扩展代码 → 挑出该保护的函数 → 生成 `core.ts` 脚手架 → 编译 → 把原 JS 里的调用点改写成 wasm 调用。

~~难点在**语义理解**（哪些函数值得沉）和**调用点改写**（依赖怎么处理），需要 LLM + AST 分析。~~

**已推翻**：实际做下来，靠 acorn AST + 一组明确规则就能挑出"值得沉"的函数
（纯数值运算、不碰浏览器 API、不碰字符串/数组/对象），**不需要 AI、不联网**。
代价是覆盖面窄一些（沉不了复杂函数），但换来了零成本和可预期。见第八节。

---

## 七、手动版 P0 已完成（2026-09-11）

**备份**：`E:\work\tools\extshield-backup-20260911-191145`（不含 `node_modules` / `.work`，`npm ci` 可还原依赖）

### 改动清单
| 文件 | 改动 |
|---|---|
| `wasm-template/core/core.ts` | 重写：删掉 `fib` 占位，保留令牌签发/校验，注释写清「这里放你最怕被抄的逻辑」+ 两个硬限制 |
| `src/wasm-loader-gen.js` | **新增**：按 `core.wasm` 真实导出自动生成 loader（用 Node 内置 `WebAssembly.Module.exports()`，不手工解析二进制） |
| `wasm-template/build.mjs` | 编译后自动生成 loader；改用 asc 的 JS API（动态 `import`） |
| `gui/server.js` | 记录 WASM 来源（`user-core` / `template` / `compile-failed`）并带回报告；loader 改到 harden **之后**生成；`compileCore` 改用动态 `import` |
| `gui/public/app.js` | 报告区显示 WASM 来源 |
| `src/harden.js` | `copyAssets` 跳过 `.ts` 源码 |

### 顺手挖出并修掉的 3 个真 bug
1. **`wasm-loader.js` 从来没进过最终包** —— server 在 `HARDEN.run()` **之前**写 loader，而 harden 开头会清空 outDir，把它一起删了。→ 改为 harden 之后生成。
2. **「用户自带 `core.ts`」这条分支从未跑通过** —— `compileCore` 用 `require('assemblyscript/asc')`，而该包的 exports **只定义了 `import` 条件、没有 `require`**，`require` 直接抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，每次都被 catch 后静默回退成示例模板。→ 改为动态 `import()`。
3. **用户源码 `core.ts` 会被打进产物** —— `copyAssets` 原样拷贝非 `.js` 文件，导致 `core.ts` 和 `core.wasm` 一起发出去，对方直接读 `.ts` 就行，**等于白下沉**。→ 跳过 `.ts`。

### 验证结果（实测，非推断）
- **模板路径**：报告 `source=template`，导出 `generateToken, verifyToken`，zip 含 `core.wasm` + `wasm-loader.js` ✅
- **用户 core.ts 路径**：报告 `source=user-core`，导出 `addOne, mulTwo`，产物 loader 自动跟着变成 `addOne, mulTwo`，且 `core.ts` **已不在 zip 中** ✅
- **CLI `demo` 回归全绿**：压缩 62%/55%/43%，verify 高危/中等/提示均为 0 ✅
- `.work` 打包后为空（隐私未破）✅

### 待办（下一轮）
- P1：扩充 `src/rules.js`（远程拉 `.wasm`、unicode 转义、大数字数组等）
- P2：UI 文案收实（不再暗示"自动下沉"）；README 补手动下沉契约 + MV3 SW 生命周期坑
- **新发现**：CLI 完全没有 WASM 模式（`bin/extshield.js` 只有 harden/verify/demo，`harden.js` 也不碰 WASM）—— **WASM 下沉目前是 GUI 独占**，CLI/CI 用户用不了。→ **已在第八节补完**

---

## 八、自动下沉 + CLI 支持已完成（2026-09-11）

### 新增文件
| 文件 | 作用 |
|---|---|
| `src/auto-sink.js` | 自动下沉引擎：`findCandidates`（acorn 扫 AST 挑函数）/ `toAssemblyScript`（生成 core.ts）/ `compile` / `rewriteWithInlineWasm`（内联 base64 改调用点） |
| `src/wasm-sink.js` | **CLI 与 GUI 共用的编排层**：`prepare`（harden 前）/ `finalize`（harden 后）/ `stageSource`（源码副本）/ `patchManifest` |
| `test/e2e-wasm.js` | 端到端回归（自动 + 手动两条路），`npm test` 可跑 |

### 关键设计

**为什么自动下沉用「内联 base64 + 同步实例化」**
常规 wasm 加载是 `fetch` + `await` 的。拿它去替换原来的同步函数，所有调用点
都得改成 `await`，一改就崩。改成把 wasm 以 base64 内联进 JS，用
`new WebAssembly.Module()` / `Instance()` 同步实例化，替换就是无缝的，
**调用点一行都不用动**。副作用是：不需要 `core.wasm` 文件、不需要
`web_accessible_resources`、不需要 fetch loader。

**为什么 CLI 必须先复制源码再下沉**
自动下沉是"就地重写 .js"。CLI 的 `--src` 就是用户自己的工程目录，直接改等于
把人家源码改了。所以 CLI 一律先复制一份到系统临时目录，在副本上改、从副本打包，
原始目录一行不动（已实测验证）。 `--keep-stage` 可保留副本供检查。

**来源优先级**：`user-core`（你的 core.ts）> `auto`（规则分析）。
**没有第三档兜底** —— 见下面的 bug 6。

### 又挖出并修掉的 2 个真 bug
4. **CLI 的 `--wasm` 开关会让 asc 崩溃** —— `assemblyscript` 的 asc 内部会
   **直接扫 `process.argv`** 找它自己的 `--wasm <path>`（用于加载自定义
   AssemblyScript 模块），跟我们传给 `asc.main()` 的 argv **无关**。
   而 extshield CLI 的开关恰好也叫 `--wasm`，asc 于是把 `--wasm` 后面那个参数
   （不存在 → 字符串 `"undefined"`）当模块路径去 `import`，报
   `Cannot find module '<cwd>/undefined'`。
   → 调用 asc 期间把 `process.argv` 收成前两项，跑完还原（写在 `auto-sink.js` 的 `compile()` 里）。
5. **`acorn` / `assemblyscript` 没写进 `dependencies`** —— 自动下沉运行时必需，
   但只在 `node_modules` 里存在（acorn 还是传递依赖），别人 `npm i extshield`
   会直接 `Cannot find module 'acorn'`。→ 已补进 `dependencies`。

### 验证结果（实测，非推断）
- `npm run demo:wasm`：报告 `source=auto`，下沉 `clamp01` 1 个函数，
  4 个不可沉的函数逐个给出原因（成员访问 / console / document）✅
- 产物校验：`atob` + `WebAssembly` 内联存在 ✅；原 `if (v<0)` 实现已消失 ✅；
  **原始 `sample/background.js` 未被改动** ✅；产物无 `core.wasm` / `core.ts` ✅
- 语义校验：抽出内联 wasm 实跑，`clamp01` 在 -5 / -0.0001 / 0 / 0.25 / 1 / 9 / NaN
  上与原生 JS **完全一致** ✅
- 手动路径 `--wasm-core`：报告 `source=user-core`，导出 `scoreOf`，
  产物含 `core.wasm` + `wasm-loader.js`，manifest 自动补
  `web_accessible_resources`，`scoreOf(4,6)=18` 正确 ✅
- `npm test`（GUI 链路）13 项断言全绿 ✅

### 又挖出并修掉的 1 个 bug（用户拿真实插件打包时暴露）
6. **兜底塞示例 wasm 制造了"已下沉"的假象** —— 用真实插件 `site-nav-pannel-pp`
   打包（87 个函数，0 个可沉），产物里却有 `core.wasm` + `wasm-loader.js`，
   用户据此以为自己的核心逻辑已经进了 wasm。实际那是内置示例
   （`generateToken`/`verifyToken`，162 字节），跟他的代码毫无关系，
   而且 `wasm-loader.js` **没有任何地方引用**（死代码）。
   → 移除 template 兜底：沉不下去就报 `auto-empty`，并带上"扫了多少个、
   为什么没看上"。CLI 与 GUI 一致。报告文案同步改成说人话。

### 真实插件实测结论（site-nav-pannel-pp，2026-09-11）
- 87 个函数 → **0 个可下沉**：61 个碰 `chrome.*`/`document`、13 个用了字符串常量、
  5 个用了对象/数组/箭头函数、4 个 async、3 个参数带默认值、1 个引用模块级变量。
- 判定是**对的**，不是漏判：这个插件的价值在 UI/交互，唯一像"算法"的
  `mergeLWW`（LWW 冲突合并）核心就一句 `localTime >= remoteTime`，
  沉进 wasm 也保护不了什么。
- 所以对这个插件：**WASM 下沉收益接近 0，真正生效的是压缩 + 合规扫描**
  （popup.js -46% / test.js -47% / locale.js -21%，verify 0 高危 0 中等）。

### 第 7 个 bug（同一轮，spike 时撞到）
`compile()` 的 argv 清理写的是 `[argv[0], argv[1]]`。**`node -e "..."` / REPL 下
`process.argv` 只有 1 项**，于是把 `undefined` 塞进 argv，asc 一用就崩
（`Cannot read properties of undefined (reading 'replace')`）。
→ 改成 `realArgv.slice(0,2).filter(a => typeof a === 'string')`。

### 🔬 可行性 spike：字符串型核心逻辑能不能沉？（**结论：能**）

真实插件里真正像"算法"的是 `normalizeUrl`（URL 归一化）和 `isSimilarUrl`
（URL 相似度/去重），**都是字符串逻辑** —— 这正是当前引擎（只认数值）挑不出来的原因。

已实测验证（不是推断）：
- 用 AssemblyScript 重写这两个函数 → **编译通过**（`--runtime minimal`
  + `--exportRuntime`，13.4KB，导出 `normalizeUrl / isSimilarUrl / __new / memory`）
- 需要 `env.abort` 导入；字符串跨边界用 `__new(len<<1, 1)` 写入 + 读 UTF-16 头长度读回
- **与原 JS 输出 100% 一致**（空串 / HTTPS 大写 / www 前缀 / 带 query / 中文域名 /
  尾部空格 等 9 个用例 + 6 组相似度对比）
- 原型文件：`E:\work\extend\_spike\core_str.ts` / `rt.wasm`（待用户决定是否保留或接进工具）

**要不要给自动下沉加字符串支持 = 待用户拍板**（方向类决策）。
代价：字符串 ABI（lower/lift glue）+ 调用点改写 + 新的出错面；
收益：能覆盖这类"字符串算法"，但仍是"提高顺手抄的门槛"，挡不住决心逆向的人。

### 待办（下一轮）
- P1：扩充 `src/rules.js`（远程拉 `.wasm`、unicode 转义、大数字数组等）
- P2：README 补"手动下沉契约" + MV3 Service Worker 生命周期坑
      （SW 被回收后 wasm 实例要重新实例化，这是正常现象）
- 自动下沉覆盖面：目前只认 `FunctionDeclaration`，且参数/返回值统一按 `f64`。
  可考虑支持 `const f = (a,b) => ...` 形式、以及整形特化（现在整数运算走 f64 有精度上限）
- ~~开源协议还没定~~ **已定：MIT**（见仓库根 `LICENSE`），可以推 GitHub 了
