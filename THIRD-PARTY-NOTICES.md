# 第三方依赖与许可声明 (Third-Party Notices)

本文件列出 **extshield** 所使用的第三方开源组件及其许可。extshield 自身的代码以 **MIT** 许可发布(见 [LICENSE](./LICENSE)),本文件覆盖的是它所依赖的第三方组件。

- 数据来源:`node_modules/` 中**实际安装**的依赖(与 `package-lock.json` 一致),许可与版权信息均取自各依赖包自带的 `package.json` / `LICENSE`,未做任何推测。
- 重新生成:`npm run notices`(脚本:`scripts/gen-notices.js`),依赖变动后请重新执行。

## 一、依赖总览

共 **16** 个组件:直接依赖 **4** 个,传递依赖 **12** 个。

| 许可 | 组件数 |
|---|---|
| Apache-2.0 | 3 |
| BSD-2-Clause | 1 |
| BSD-3-Clause | 1 |
| MIT | 11 |

> 全部为**宽松许可**(permissive),**不含 GPL / AGPL / LGPL 等传染性许可**,因此不影响本项目继续以 MIT 许可发布,也不影响你对本工具产出的扩展包自行授权。

## 二、直接依赖

| 组件 | 版本 | 许可 | 项目主页 |
|---|---|---|---|
| `acorn` | 8.17.0 | MIT | https://github.com/acornjs/acorn |
| `assemblyscript` | 0.28.19 | Apache-2.0 | https://github.com/AssemblyScript/assemblyscript |
| `esbuild` | 0.21.5 | MIT | https://github.com/evanw/esbuild |
| `terser` | 5.49.0 | BSD-2-Clause | https://github.com/terser/terser |

### 版权归属

- **acorn** — Copyright (C) 2012-2022 by various contributors (see AUTHORS)
- **assemblyscript** — 以 Apache-2.0 发布,LICENSE 中未列独立版权行;作者名单见 `node_modules/assemblyscript/NOTICE`
- **esbuild** — Copyright (c) 2020 Evan Wallace
- **terser** — Copyright 2012-2018 (c) Mihai Bazon <mihai.bazon@gmail.com>

## 三、传递依赖

| 组件 | 版本 | 许可 | 项目主页 |
|---|---|---|---|
| `@esbuild/win32-x64` | 0.21.5 | MIT | https://github.com/evanw/esbuild |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT | https://github.com/jridgewell/sourcemaps |
| `@jridgewell/resolve-uri` | 3.1.2 | MIT | https://github.com/jridgewell/resolve-uri |
| `@jridgewell/source-map` | 0.3.11 | MIT | https://github.com/jridgewell/sourcemaps |
| `@jridgewell/sourcemap-codec` | 1.5.5 | MIT | https://github.com/jridgewell/sourcemaps |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | https://github.com/jridgewell/sourcemaps |
| `binaryen` | 130.0.0-nightly.20260609 | Apache-2.0 | https://github.com/AssemblyScript/binaryen.js |
| `buffer-from` | 1.1.2 | MIT | https://github.com/LinusU/buffer-from |
| `commander` | 2.20.3 | MIT | https://github.com/tj/commander.js |
| `long` | 5.3.2 | Apache-2.0 | https://github.com/dcodeIO/long.js |
| `source-map` | 0.6.1 | BSD-3-Clause | http://github.com/mozilla/source-map |
| `source-map-support` | 0.5.21 | MIT | https://github.com/evanw/node-source-map-support |

## 四、AssemblyScript 的 NOTICE(启用 WASM 下沉时请阅读)

本工具的 WASM 下沉功能使用 **AssemblyScript**(Apache-2.0)把纯计算函数编译成 WebAssembly。**启用 `--wasm` 后,产出的 wasm 二进制中会内联 AssemblyScript 的运行时(runtime)**,因此按 Apache-2.0 第 4(d) 条,下列归属声明建议随产物一并保留:

> 完整原文见 `node_modules/assemblyscript/NOTICE`。摘要:
>
> AssemblyScript 的贡献者依据其 LICENSE(Apache-2.0)授权。其中**部分代码派生自以下第三方作品**:
>
> * TypeScript: https://github.com/Microsoft/TypeScript
>   Copyright (c) Microsoft Corporation
>   Apache License, Version 2.0 (https://opensource.org/licenses/Apache-2.0)
> * Binaryen: https://github.com/WebAssembly/binaryen
>   Copyright (c) WebAssembly Community Group participants
>   Apache License, Version 2.0 (https://opensource.org/licenses/Apache-2.0)
> * musl libc: http://www.musl-libc.org
>   Copyright (c) Rich Felker, et al.
>   The MIT License (https://opensource.org/licenses/MIT)
> * V8: https://developers.google.com/v8/
>   Copyright (c) the V8 project authors
>   The 3-Clause BSD License (https://opensource.org/licenses/BSD-3-Clause)
> * Arm Optimized Routines: https://github.com/ARM-software/optimized-routines
>   Copyright (c) Arm Limited
>   The MIT License (https://opensource.org/licenses/MIT)

## 五、分发时的义务边界

| 场景 | 需要做什么 |
|---|---|
| **通过 npm 安装本工具**(默认) | 无需额外动作。依赖由 npm 单独下载,**每个依赖包自带 `LICENSE`/`NOTICE`**,MIT/BSD「保留版权声明」的义务由依赖包自身满足;本文件用于可读性与审计。 |
| **把依赖打包进发布物**(离线包 / 单文件 / 免安装发行) | **必须**同时附带对应组件的许可全文:MIT、BSD-2/3-Clause 要求保留版权声明与许可文本;Apache-2.0 要求提供许可副本并保留 `NOTICE`。可用 `npx generate-license-file --input package.json --output THIRD-PARTY-NOTICES-full.txt` 生成含全文的版本。 |
| **本工具产出的扩展包** | 其中只包含你自己的代码、本工具生成的运行时、以及由你的 `core.ts`(或自动扫出的函数)编译出的 wasm,不含第三方源码;AssemblyScript 运行时的归属见第四节。 |

---

> 本文件由 `scripts/gen-notices.js` 自动生成,请勿手工编辑 —— 改依赖后重新执行 `npm run notices`。
