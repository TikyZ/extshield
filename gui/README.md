# extshield 可视化打包器(GUI)

一个本地 Web 应用:选插件文件夹 → 选保护方式 → 选保存位置 → 一键合规打包。底层复用
`extshield` 引擎(激进压缩 / WASM 下沉)。

## 运行

```bash
cd extshield
node gui/server.js
# 浏览器打开 http://localhost:4173
```

## 使用步骤

1. **选择插件文件夹**:点选扩展根目录(需含 `manifest.json`)。前端会读出所有文件并就地解析 manifest 显示入口。
2. **选择保护方式**:
   - **激进压缩 (Minify)**:esbuild 去空白/改名/去注释/去 console;勾选"属性名也改名"会更激进(需谨慎,可能破坏外部 API 调用)。
   - **WASM 下沉**:把核心逻辑编译成 WebAssembly 二进制。把你的核心算法写成 `core.ts` 放进插件根目录即可现场编译(**优先级最高**);不写也行——工具会用 acorn 扫你的源码,自动挑出适合下沉的纯计算函数。wasm 以 base64 **内联进 JS**(同步实例化,调用点一行不用改),产物里**不会有** `core.wasm` / `wasm-loader.js`,也不需要 `web_accessible_resources`。工具会自动给 `manifest.json` 补上 `content_security_policy.extension_pages`(放行 `wasm-unsafe-eval`,只追加不覆盖你原有指令)。一个函数都挑不出时会如实报告"未下沉",**不会拿示例 wasm 充数**。详见 [../README.md](../README.md) 的「WASM 下沉」一节。
3. **开始打包**:点按钮后会先弹出系统「另存为」窗口,你选好保存位置和文件名,服务端才开始处理,并直接写入你选的位置。解压即是可上传商店的扩展目录。

   > 「另存为」用的是浏览器 File System Access API,仅 Chrome / Edge 等 Chromium 内核支持。
   > Firefox / Safari 会自动退回浏览器默认下载方式(可在浏览器设置里开启「下载前询问保存位置」)。
   > 在「另存为」窗口点取消,则不会打包。

4. **查看合规报告**:打包完成后页面第 4 步会自动展示扫描结果 —— 是否踩到 Chrome Web Store 审核红线(高危 / 中等 / 提示),并列出每个命中所在的文件、行号和代码片段。
   **报告只显示在页面上,不会写进 zip,也不落盘。**

## 隐私说明(重要)

- 你上传的扩展源码会被写入服务端工作目录 `gui/.work/<任务ID>/` 以便处理。
- **打包完成后该目录立即被删除**,不在磁盘留存;服务启动时也会清空一次 `gui/.work/`,兜底处理上次异常退出(强杀 / 断电)留下的残留。
- zip 在删除前已完整读入内存,所以清理不影响你拿到的产物。
- 整个流程只在本机 `127.0.0.1` 完成,不会把任何数据发往外部服务器。

## 合规保证

- 两种方式都只做 Chrome 政策允许的压缩 / WASM,**不做**字符串加密、控制流平坦化、
  `eval` 解密代码等被禁的混淆。
- 打包产物可用 `extshield verify --dir <解压目录>` 复检,确认零红线。

## 接口(供自动化 / CI 调用)

`POST /api/pack`,body(JSON):

```json
{
  "methods": ["minify"],
  "mangleProps": false,
  "files": [{ "path": "manifest.json", "data": "<base64>" }]
}
```

- `methods`:**数组**,可叠加,取值 `minify` / `wasm`,例如 `["minify", "wasm"]`。
- `mangleProps`:可选,布尔,是否额外用 terser 改属性名。
- `files`:文件列表,`path` 为相对扩展根目录的路径,`data` 为文件内容的 base64。

返回 `application/json`:

```json
{
  "filename": "extshield-minify-1757000000000.zip",
  "zip": "<zip 内容的 base64>",
  "report": {
    "passed": true,
    "noJs": false,
    "counts": { "high": 0, "medium": 0, "info": 0 },
    "fileCount": 3,
    "inlineCount": 1,
    "entries": 2,
    "hits": []
  }
}
```

> zip 之所以用 base64 内嵌在 JSON 里,是为了和合规报告一并回传。早期版本直接返回
> `application/zip` 二进制流,但那样前端拿不到任何扫描结果。
>
> `report.hits[]` 每项:`{ rule, name, severity, message, line, snippet, file }`。
