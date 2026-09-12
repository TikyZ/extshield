'use strict';

const path = require('path');
const fs = require('fs');
const RULES = require('./rules');

/**
 * 递归收集 outDir 下所有 .js 文件。
 */
function collectJs(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    const st = fs.statSync(f);
    if (st.isDirectory()) {
      collectJs(f, acc);
    } else if (/\.js$/i.test(name)) {
      acc.push(f);
    }
  }
  return acc;
}

/**
 * 对单个文件跑全部规则,返回命中列表。
 */
/**
 * 递归收集 outDir 下所有 .html 文件(用于提取内联脚本)。
 */
function collectHtml(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    const st = fs.statSync(f);
    if (st.isDirectory()) {
      collectHtml(f, acc);
    } else if (/\.(html?|htm)$/i.test(name)) {
      acc.push(f);
    }
  }
  return acc;
}

/**
 * 提取 HTML 里的内联 <script>(不带 src 的)代码块。
 * 这些代码既不会被 harden 压缩,也不会被只扫 .js 的 collectJs 覆盖,
 * 是"源码裸奔 + 漏检红线"的双重盲区,所以必须单独提出来扫。
 */
function extractInlineScripts(dir) {
  const out = [];
  for (const html of collectHtml(dir)) {
    let content;
    try {
      content = fs.readFileSync(html, 'utf8');
    } catch {
      continue;
    }
    const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    let i = 0;
    while ((m = re.exec(content))) {
      const code = m[1] || '';
      if (!code.trim()) continue;
      i++;
      const lineOffset = content.slice(0, m.index).split('\n').length - 1;
      out.push({
        file: `${html}#inline-${i}`,
        realFile: html,
        inlineIndex: i,
        code,
        lineOffset,
      });
    }
  }
  return out;
}

/**
 * 对一段代码跑全部规则(纯逻辑,不关心来源)。
 * lineOffset 用于把内联脚本的行号换算回 HTML 里的真实行号。
 */
function scanCode(code, file, rules, lineOffset = 0) {
  const hits = [];

  // 自动下沉会把 wasm 以 base64 内联,并用 atob + new WebAssembly.Module 同步实例化。
  // 这是本工具自己生成的合法产物,不该被"字符串隐藏"类规则误报,否则等于自己打自己脸。
  const inlineWasm =
    /\batob\s*\(/.test(code) && /new\s+WebAssembly\.(Module|Instance)/.test(code);

  // 白名单里还有 string-fromcharcode:我们的字符串胶水要用 String.fromCharCode
  // 把 wasm 内存里的 UTF-16 读回成字符串,命中这条规则纯属自己打自己脸。
  // 只在这三处都是"同一个 inlined wasm 运行时"的特征时才跳过,不放宽全局。
  const WHITELIST_FOR_INLINE_WASM = [
    'atob-decode',
    'long-base64-table',
    'string-fromcharcode',
  ];

  for (const rule of rules) {
    if (inlineWasm && WHITELIST_FOR_INLINE_WASM.includes(rule.id)) continue;
    const flags = rule.pattern.flags.includes('g')
      ? rule.pattern.flags
      : rule.pattern.flags + 'g';
    const re = new RegExp(rule.pattern.source, flags);
    let m;
    let count = 0;
    while ((m = re.exec(code))) {
      count++;
      if (count === 1) {
        const idx = m.index;
        const line = code.slice(0, idx).split('\n').length + lineOffset;
        const snippet = code.slice(idx, idx + 80).replace(/\s+/g, ' ');
        hits.push({
          rule: rule.id,
          name: rule.name,
          severity: rule.severity,
          message: rule.message,
          line,
          snippet,
          file,
        });
      }
      if (m.index === re.lastIndex) re.lastIndex++;
      if (count >= 20) break; // 同一文件同一规则最多报 20 次
    }
  }
  return hits;
}

/**
 * 扫描单个 .js 文件。
 */
function scanFile(file, rules) {
  const code = fs.readFileSync(file, 'utf8');
  return scanCode(code, file, rules, 0);
}

/**
 * 跑完整扫描并输出报告。
 */
function scan(outDir, opts = {}) {
  const strict = !!opts.strict;
  const files = collectJs(outDir);
  const inline = opts.includeInline === false ? [] : extractInlineScripts(outDir);

  const result = {
    outDir,
    strict,
    files,
    fileCount: files.length,
    inlineCount: inline.length,
    hits: [],
    bySev: { high: [], medium: [], info: [] },
    counts: { high: 0, medium: 0, info: 0 },
    failures: [],
    noJs: false,
    passed: true,
    exitCode: 0,
  };

  if (!files.length && !inline.length) {
    result.noJs = true;
    result.passed = false;
    result.exitCode = 2;
    result.error = `在 ${outDir} 没找到任何 .js 文件,请先 harden。`;
    return result;
  }

  for (const f of files) result.hits.push(...scanFile(f, RULES));
  for (const it of inline) {
    result.hits.push(...scanCode(it.code, it.file, RULES, it.lineOffset));
  }

  for (const h of result.hits) {
    if (result.bySev[h.severity]) result.bySev[h.severity].push(h);
  }
  result.counts = {
    high: result.bySev.high.length,
    medium: result.bySev.medium.length,
    info: result.bySev.info.length,
  };

  result.failures = result.bySev.high.slice();
  if (strict) result.failures.push(...result.bySev.medium);

  result.passed = result.failures.length === 0;
  result.exitCode = result.passed ? 0 : 1;
  return result;
}

/**
 * 跑完整扫描并输出报告。
 *
 * 注意:这里**不会**调用 process.exit —— 退出码交给调用方处理。
 * 否则被 GUI require 后,一次"没找到 js"就会把整个本地服务进程杀掉。
 */
function run(cfg, opts = {}) {
  const outDir = cfg.outDir;
  const result = scan(outDir, opts);

  if (result.noJs) {
    console.error(`[verify] ${result.error}`);
    return result;
  }

  console.log(`[verify] 扫描目录: ${outDir}`);
  console.log(
    `[verify] 扫描文件: ${result.fileCount} 个 js` +
      (result.inlineCount ? ` + ${result.inlineCount} 段内联脚本` : '') +
      '\n'
  );

  const allHits = result.hits;
  const bySev = result.bySev;

  // 输出
  const rel = (f) => path.relative(cfg.outDir, f) || f;
  for (const sev of ['high', 'medium', 'info']) {
    if (!bySev[sev].length) continue;
    const tag = sev === 'high' ? '❌ 高危' : sev === 'medium' ? '⚠️  中等' : 'ℹ️  提示';
    console.log(`${tag} (${bySev[sev].length}):`);
    for (const h of bySev[sev]) {
      console.log(`  • [${h.rule}] ${h.name}`);
      console.log(`    文件: ${rel(h.file)}${h.line ? ' (行 ' + h.line + ')' : ''}`);
      if (h.snippet) console.log(`    片段: ${h.snippet}${h.snippet.length >= 80 ? '…' : ''}`);
      console.log(`    说明: ${h.message}`);
    }
    console.log('');
  }

  console.log('────────────────────────────────────────');
  console.log(
    `总计: 高危 ${result.counts.high} / 中等 ${result.counts.medium} / 提示 ${result.counts.info}` +
      (result.inlineCount ? ` (含 ${result.inlineCount} 段内联脚本)` : '')
  );
  if (result.passed) {
    console.log('✅ 通过:未检测到会触发审核红线的混淆特征。可以打包上传。');
  } else {
    console.log(
      `❌ 不通过:发现 ${result.failures.length} 项需处理的风险` +
        (result.strict ? '(strict 模式含中等风险)' : '') +
        '。上传前请先消除高危项。'
    );
  }
  return result;
}

module.exports = {
  run,
  scan,
  collectJs,
  collectHtml,
  extractInlineScripts,
  scanFile,
  scanCode,
};
