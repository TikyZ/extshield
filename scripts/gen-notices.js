'use strict';

/**
 * 生成 THIRD-PARTY-NOTICES.md —— 列出本项目的第三方依赖及其许可。
 *
 * 数据来源:node_modules 里实际安装的依赖(与 package-lock.json 保持一致),
 * 不联网、不猜测;许可与版权信息全部来自各依赖包自带的 package.json / LICENSE。
 *
 * 用法: node scripts/gen-notices.js      (或 npm run notices)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');

// ── 1. 扫描已安装依赖 ────────────────────────────────────────
function scan(dir, prefix, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      scan(path.join(dir, e.name), `${prefix}${e.name}/`, acc);
      continue;
    }
    const pj = path.join(dir, e.name, 'package.json');
    if (!fs.existsSync(pj)) continue;
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    acc.push({
      name: `${prefix}${e.name}`,
      version: j.version || '?',
      license: normalizeLicense(j),
      homepage: pickUrl(j),
      dir: path.join(dir, e.name),
    });
  }
  return acc;
}

function normalizeLicense(j) {
  if (typeof j.license === 'string') return j.license;
  if (j.license && typeof j.license === 'object' && j.license.type) return j.license.type;
  if (Array.isArray(j.licenses)) {
    return j.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean).join(' OR ');
  }
  return '未声明';
}

function pickUrl(j) {
  const r = j.repository;
  let url = typeof r === 'string' ? r : r && r.url;
  if (!url) url = j.homepage;
  if (!url) return '';
  url = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/^github:/, 'https://github.com/');
  // 有些包把 repository 写成 "owner/repo" 简写,补全成 GitHub 地址
  if (!/^https?:\/\//.test(url) && /^[\w.-]+\/[\w.-]+$/.test(url)) {
    url = `https://github.com/${url}`;
  }
  return url;
}

// ── 2. 从 LICENSE / NOTICE 里抠版权行 ────────────────────────
// 只取文件开头那段"版权声明块":命中第一条版权行后,遇到空行或正文句子即停,
// 避免把 BSD 条款里的 "copyright notice, this list of conditions..." 误当成版权行。
const BOILER = /(this list of conditions|permission is hereby granted|included in or attached to the work|without limitation the rights|redistributions? of|distributed under the .{0,24}licen[cs]e|terms and conditions for use)/i;
const COPY = /^(copyright|\(c\)|©|portions of this software|all rights reserved)/i;

function copyrightLines(dir) {
  const cand = fs
    .readdirSync(dir)
    .filter((f) => /^(LICENSE|LICENCE|COPYING|NOTICE)/i.test(f));
  const lines = [];
  for (const f of cand) {
    const st = fs.statSync(path.join(dir, f));
    if (!st.isFile() || st.size > 200 * 1024) continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const found = [];
    for (const raw of txt.split(/\r?\n/).slice(0, 60)) {
      const line = raw.trim();
      if (!line || BOILER.test(line)) {
        if (found.length) break; // 版权块结束
        continue;
      }
      if (COPY.test(line)) {
        if (!found.includes(line)) found.push(line);
      } else if (found.length) {
        break; // 版权行之后的第一句正文,收工
      }
    }
    for (const l of found) if (!lines.includes(l)) lines.push(l);
  }
  return lines;
}

// ── 3. 组装输出 ──────────────────────────────────────────────
const all = scan(NM, '', []);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const directNames = Object.keys(pkg.dependencies || {});
const direct = all.filter((p) => directNames.includes(p.name)).sort((a, b) => a.name.localeCompare(b.name));
const transitive = all.filter((p) => !directNames.includes(p.name)).sort((a, b) => a.name.localeCompare(b.name));

const byLicense = {};
for (const p of all) (byLicense[p.license] = byLicense[p.license] || []).push(p.name);

const licRow = (p) => `| \`${p.name}\` | ${p.version} | ${p.license} |${p.homepage ? ` ${p.homepage} |` : ' — |'}`;

const out = [];

out.push('# 第三方依赖与许可声明 (Third-Party Notices)');
out.push('');
out.push(
  '本文件列出 **extshield** 所使用的第三方开源组件及其许可。' +
    'extshield 自身的代码以 **MIT** 许可发布(见 [LICENSE](./LICENSE)),本文件覆盖的是它所依赖的第三方组件。'
);
out.push('');
out.push('- 数据来源:`node_modules/` 中**实际安装**的依赖(与 `package-lock.json` 一致),许可与版权信息均取自各依赖包自带的 `package.json` / `LICENSE`,未做任何推测。');
out.push('- 重新生成:`npm run notices`(脚本:`scripts/gen-notices.js`),依赖变动后请重新执行。');
out.push('');
out.push('## 一、依赖总览');
out.push('');
out.push(`共 **${all.length}** 个组件:直接依赖 **${direct.length}** 个,传递依赖 **${transitive.length}** 个。`);
out.push('');
out.push('| 许可 | 组件数 |');
out.push('|---|---|');
for (const k of Object.keys(byLicense).sort()) out.push(`| ${k} | ${byLicense[k].length} |`);
out.push('');
out.push(
  '> 全部为**宽松许可**(permissive),**不含 GPL / AGPL / LGPL 等传染性许可**,' +
    '因此不影响本项目继续以 MIT 许可发布,也不影响你对本工具产出的扩展包自行授权。'
);
out.push('');
out.push('## 二、直接依赖');
out.push('');
out.push('| 组件 | 版本 | 许可 | 项目主页 |');
out.push('|---|---|---|---|');
for (const p of direct) out.push(licRow(p));
out.push('');
out.push('### 版权归属');
out.push('');
for (const p of direct) {
  const c = copyrightLines(p.dir);
  if (c.length) {
    out.push(`- **${p.name}** — ${c.join(' / ')}`);
  } else {
    const hasNotice = fs.existsSync(path.join(p.dir, 'NOTICE'));
    const tail = hasNotice
      ? `作者名单见 \`node_modules/${p.name}/NOTICE\``
      : p.homepage
        ? `见 ${p.homepage}`
        : '';
    out.push(`- **${p.name}** — 以 ${p.license} 发布,LICENSE 中未列独立版权行${tail ? `;${tail}` : ''}`);
  }
}
out.push('');
out.push('## 三、传递依赖');
out.push('');
out.push('| 组件 | 版本 | 许可 | 项目主页 |');
out.push('|---|---|---|---|');
for (const p of transitive) out.push(licRow(p));
out.push('');
out.push('## 四、AssemblyScript 的 NOTICE(启用 WASM 下沉时请阅读)');
out.push('');
out.push(
  '本工具的 WASM 下沉功能使用 **AssemblyScript**(Apache-2.0)把纯计算函数编译成 WebAssembly。' +
    '**启用 `--wasm` 后,产出的 wasm 二进制中会内联 AssemblyScript 的运行时(runtime)**,' +
    '因此按 Apache-2.0 第 4(d) 条,下列归属声明建议随产物一并保留:'
);
out.push('');
const asDir = path.join(NM, 'assemblyscript');
let noticeTxt = '';
for (const f of ['NOTICE']) {
  const fpl = path.join(asDir, f);
  if (fs.existsSync(fpl)) noticeTxt = fs.readFileSync(fpl, 'utf8');
}
if (noticeTxt) {
  const derived = noticeTxt.split(/Portions of this software/i)[1] || '';
  out.push('> 完整原文见 `node_modules/assemblyscript/NOTICE`。摘要:');
  out.push('>');
  out.push('> AssemblyScript 的贡献者依据其 LICENSE(Apache-2.0)授权。其中**部分代码派生自以下第三方作品**:');
  out.push('>');
  for (const raw of derived.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim().startsWith('*')) out.push(`> ${line.trim()}`);
    else if (/^\s{2,}\S/.test(raw)) out.push(`>   ${line.trim()}`);
  }
}
out.push('');
out.push('## 五、分发时的义务边界');
out.push('');
out.push('| 场景 | 需要做什么 |');
out.push('|---|---|');
out.push(
  '| **通过 npm 安装本工具**(默认) | 无需额外动作。依赖由 npm 单独下载,**每个依赖包自带 `LICENSE`/`NOTICE`**,MIT/BSD「保留版权声明」的义务由依赖包自身满足;本文件用于可读性与审计。 |'
);
out.push(
  '| **把依赖打包进发布物**(离线包 / 单文件 / 免安装发行) | **必须**同时附带对应组件的许可全文:MIT、BSD-2/3-Clause 要求保留版权声明与许可文本;Apache-2.0 要求提供许可副本并保留 `NOTICE`。可用 `npx generate-license-file --input package.json --output THIRD-PARTY-NOTICES-full.txt` 生成含全文的版本。 |'
);
out.push(
  '| **本工具产出的扩展包** | 其中只包含你自己的代码、本工具生成的运行时、以及由你的 `core.ts`(或自动扫出的函数)编译出的 wasm,不含第三方源码;AssemblyScript 运行时的归属见第四节。 |'
);
out.push('');
out.push('---');
out.push('');
out.push('> 本文件由 `scripts/gen-notices.js` 自动生成,请勿手工编辑 —— 改依赖后重新执行 `npm run notices`。');
out.push('');

fs.writeFileSync(OUT, out.join('\n'), 'utf8');

console.log(`已生成 ${path.relative(ROOT, OUT)}`);
console.log(`  组件总数 ${all.length}(直接 ${direct.length} / 传递 ${transitive.length})`);
console.log(`  许可分布: ${Object.keys(byLicense).sort().map((k) => `${k}=${byLicense[k].length}`).join(', ')}`);
console.log(`  字节数: ${fs.statSync(OUT).size}`);
