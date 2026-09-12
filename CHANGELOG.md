# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

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
