# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.2] - 2026-09-13

### 新增

- **`extshield gui` 子命令**:安装后一条命令启动可视化打包器(默认 http://localhost:4173,
  可用 `--port` 指定端口),无需进入项目目录执行脚本。
- **安装前检查**:打包完成后检查这个包能不能顺利装进浏览器,报告三类硬伤 ——
  Manifest 版本(V2 已被 Chrome / Edge 停用,会被拒绝加载)、
  manifest 中引用但产物里不存在的文件(表现为图标缺失或页面空白)、
  会被浏览器拒绝加载的写法(如 MV3 的 CSP 误用 `unsafe-eval`)。
  CLI 与可视化界面都会展示。

### 修复

- **补齐 manifest 入口探测字段**:`browser_action` / `page_action` / `chrome_url_overrides` /
  `devtools_page` / `side_panel` / `sandbox` / `background.page` 声明的页面此前不会被收集,
  这些页面里的 `<script src>` 不进产物,导致打包报错。新标签页、侧边栏、DevTools 面板
  这几类扩展此前无法打包。

## [1.0.1] - 2026-09-13

### 新增

- **GUI 中英文双语**:可视化打包器右上角新增 `中文 / EN` 语言切换,选择会记住,
  默认跟随浏览器语言(中文浏览器显示中文,其余显示英文),也可用 `?lang=en` / `?lang=zh`
  直接指定。界面静态文案以英文为默认,避免首屏短暂显示另一种语言。CLI 输出保持中文不变。
- **WASM 下沉时抹掉函数导出名**:下沉后 wasm 里原本会原样保留
  `(export "isSimilarUrl" ...)`,等于给逆向者留了一套"哪个函数值钱"的路标。
  现在统一改名成 `f0` / `f1` / …,JS 侧调用点同步对齐。
  运行时接口(`memory`、`__new`、`__collect` 等)一律保留原名,功能不受影响。
  回归测试新增三条断言:wasm 字节里搜不到原函数名、函数导出只剩短名、运行时接口未被改名。

### 变更

- **文档与 npm 元数据双语化**:`README.md` 改为英文(npm 包页面默认展示的内容),
  新增中文版 `README.zh-CN.md`;两份文档顶部用 `🌐 English | 简体中文` 互链
  (npm 只渲染一个 README,故用绝对链接保证在包页面上可点)。
  `description` 改英文,`keywords` 扩充为覆盖
  chrome extension / minify / obfuscation / wasm / packager 等实际搜索词。
- **切换语言不再丢弃已出的结果**:语言切换前会把进度、打包结果与合规扫描报告
  按当前语言原地重绘,不再出现"切一次语言就得重新打包一次"才能再看报告的情况;
  页面本身不重载,已选文件夹与进行中的进度都保持不变。
- README「防范程度」一节据实改写:明确 wasm 下沉**不是加密、仍可反汇编**,
  只抬高成本;并说明"真正的不可逆(代码不下发客户端)"**只适用于本来就该在服务端的逻辑**,
  纯前端功能天生沉不下去。
- README「防范程度」一节据实改写:明确 wasm 下沉**不是加密、仍可反汇编**,
  只抬高成本;并说明"真正的不可逆(代码不下发客户端)"**只适用于本来就该在服务端的逻辑**,
  纯前端功能天生沉不下去。

### 修复

- **端到端测试不再在系统临时目录里留垃圾**:`npm test` 建的 10 个临时目录以前从不删除,
  反复跑会持续累积(实测攒到 250+ 个)。现在统一登记并在进程退出时清理;清理失败不会
  影响测试结论。

## [1.0.0] - 2026-09-12

首个公开版本。

### 新增

- **激进压缩(harden)**:esbuild 打包 + 去空白 / 标识符改名 / tree-shaking /
  去 `console`·`debugger` / 去注释;可选 terser 属性名改名(`--mangle-props`)。
- **合规扫描(verify)**:上传前识别 `eval`、`new Function`、字符串型 `setTimeout`、
  `atob/btoa` 解密链、`fromCharCode`、长 base64 字符串表、`_0x` 混淆变量名、
  控制流平坦化、`constructor.constructor` 逃逸、`sourceMappingURL` 残留、远程代码加载等;
  `--strict` 可把中等风险也判为不通过,直接接 CI。
- **WASM 下沉(`--wasm`)**:把纯计算函数编译成 WebAssembly,以 base64 **内联进 JS**
  同步实例化,调用点一行不用改。自动下沉用 acorn 扫 AST 挑函数;也可用
  `--wasm-core` 指定自己的 `core.ts`(优先级更高)。
- **CSP 自动放行**:下沉后自动给 `manifest.json` 追加
  `content_security_policy.extension_pages`(`script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`),
  只追加不覆盖,重复执行幂等。
- **可视化打包器(GUI)**:本地 Web 应用,选文件夹 → 选方式 → 选保存位置 → 一键打包,
  并在页面上给出合规扫描报告。
- **端到端回归测试** `npm test`:覆盖自动 / 手动下沉、下沉前后语义一致性、CSP 处理、
  标识符边界与路径安全。

### 安全

- 本地服务只监听 `127.0.0.1`,并校验 `Host` / `Origin` / `Sec-Fetch-Site`,
  防 DNS rebinding 与 CSRF。
- 上传文件做路径穿越校验(`path.relative`),拒绝 `../` 与绝对路径。
- zip 用纯 Node 实现,避免 `python -m zipfile` 把 cwd 插入 `sys.path` 导致的 RCE。
- 产物扫描敏感文件红线(`.env` / `credentials.json` / `*.pem` / `*.key` / `.wrangler` 等),
  命中即拒绝产出。
- GUI 工作目录 `gui/.work/` 用完即删,启动时兜底清理上次异常退出的残留。

### 说明

- 刻意**不提供**字符串加密、控制流平坦化、反调试等 Chrome Web Store 明令禁止的混淆手段。
- 检测规则、CSP 约束等事实均已核对 Chrome 官方文档。
