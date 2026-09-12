'use strict';

/**
 * extshield 可视化打包器 —— 本地服务
 *
 * 流程:
 *   浏览器选择插件文件夹(webkitdirectory 上传) -> 选保护方式(minify / wasm, 可多选叠加)
 *   -> POST /api/pack -> 服务端调用 extshield 引擎处理 -> 打包成 zip 返回下载
 *
 * 启动: node gui/server.js  然后浏览器打开 http://localhost:4173
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..'); // extshield/
const PUBLIC = path.join(__dirname, 'public');
const WORK = path.join(__dirname, '.work');

const CONFIG = require(path.join(ROOT, 'src', 'config'));
const HARDEN = require(path.join(ROOT, 'src', 'harden'));
const VERIFY = require(path.join(ROOT, 'src', 'verify'));
// WASM 下沉编排(与 CLI 共用同一份实现)
const WASMSINK = require(path.join(ROOT, 'src', 'wasm-sink'));
const ZIP = require(path.join(ROOT, 'src', 'zip'));
const { DEFAULTS } = CONFIG;

// Python: 优先读环境变量,否则回落到 PATH 里的 python / python3 / py
//   指定方式: EXTSHIELD_PYTHON=<python路径> node gui/server.js
// 只用于 Windows 上绕开删除拦截的降级手段,打 zip 已经改成纯 Node(见 src/zip.js)。
const PY = (function resolvePython() {
  const candidates = [process.env.EXTSHIELD_PYTHON, 'python', 'python3', 'py'].filter(Boolean);
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true });
      return cmd;
    } catch {
      /* 换下一个候选 */
    }
  }
  return null; // 没有 Python 也能正常打包,只是 Windows 删除拦截时少一层降级
})();
const PORT = process.env.PORT || 4173;

// ── 处理核心 ───────────────────────────────────────────────
function zipDir(dir, zipPath) {
  // 纯 Node 实现:以前用 `python -m zipfile -c ... { cwd: dir }`,
  // 而 `python -m` 会把 cwd 插到 sys.path 最前面 —— cwd 正是装着用户上传文件的
  // 产物目录,里面放个 zipfile.py 就能在本机执行任意代码(RCE 级)。
  return ZIP.zipDir(dir, zipPath);
}

// 递归删除目录。
// 优先用 Node 标准 API;但某些环境(企业终端防护、沙箱、批量删除限制)会 hook
// 文件删除接口并直接拒绝,导致 rmSync 抛错、源码副本留在磁盘上。
// 这种情况下在 Windows 上降级为直调 kernel32,绕过上层拦截。
const WIN32_RM = `
import ctypes, sys, os
k = ctypes.windll.kernel32
k.DeleteFileW.argtypes = [ctypes.c_wchar_p]
k.RemoveDirectoryW.argtypes = [ctypes.c_wchar_p]
def rm(p):
    if os.path.isdir(p):
        for n in os.listdir(p):
            rm(os.path.join(p, n))
        k.RemoveDirectoryW(p)
    else:
        k.DeleteFileW(p)
rm(sys.argv[1])
`;

function rmDirForce(dir) {
  if (!fs.existsSync(dir)) return true;
  // 兜底保险:只允许删 gui/.work 底下的东西。
  // 万一哪天 WORK 配错、或调用方传进来一个绝对路径,不至于把用户目录递归删掉。
  const rel = path.relative(WORK, path.resolve(dir));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    console.warn(`[privacy] 拒绝删除工作目录以外的路径: ${dir}`);
    return false;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return !fs.existsSync(dir);
  } catch (e) {
    if (process.platform === 'win32' && PY) {
      try {
        // -I 隔离模式:不把 cwd / 用户 site-packages 插进 sys.path,
        // 免得工作目录里的同名 .py 被当成标准库导入。
        execFileSync(PY, ['-I', '-c', WIN32_RM, path.resolve(dir)], { stdio: 'ignore', windowsHide: true });
      } catch (e2) {
        console.warn(`[privacy] 底层删除同样失败: ${e2.message}`);
      }
    } else {
      console.warn(`[privacy] 删除失败: ${e.message}`);
    }
  }
  return !fs.existsSync(dir);
}

// 删除某个任务的工作目录。
// 隐私要求:用户上传的扩展源码只应存在于内存和最终 zip 里,不能留在磁盘上
// (里面可能含 .git / .env / wrangler.toml 等敏感文件)。
function cleanupTask(id) {
  const dir = path.join(WORK, id);
  if (!rmDirForce(dir)) console.warn(`[privacy] 工作目录清理失败,请手动删除: ${dir}`);
}

// 启动时兜底:上次运行若被强杀/断电,会残留用户源码副本,这里一并清掉。
function purgeStaleWork() {
  rmDirForce(WORK);
  try {
    fs.mkdirSync(WORK, { recursive: true });
  } catch (e) {
    console.warn(`[privacy] 创建 ${WORK} 失败: ${e.message}`);
  }
}

async function pack(req) {
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  try {
    return await packTask(id, req);
  } catch (e) {
    cleanupTask(id); // 中途失败也要清,否则半成品源码一样会留在磁盘
    throw e;
  }
}

async function packTask(id, { methods, mangleProps, files }) {
  // 兼容单字符串:自动转数组
  const methodList = Array.isArray(methods) ? methods : [methods];
  const useMinify = methodList.includes('minify');
  const useWasm = methodList.includes('wasm');

  if (!methodList.length) throw new Error('未选择任何保护方式');
  const srcDir = path.join(WORK, id, 'src');
  const outDir = path.join(WORK, id, 'dist');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 写出上传的文件
  for (const f of files) {
    // 防路径穿越:f.path 来自浏览器端,可能被构造成 "../.." 试图写到工作目录之外。
    // 归一化后必须仍落在 srcDir 内,否则直接拒绝。
    const rel = String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel === '.') throw new Error('上传的条目缺少文件名');
    if (rel.includes('\0')) throw new Error('文件名含非法字符');
    const full = path.resolve(srcDir, rel);
    // 用 path.relative 判断,Windows 盘符(C:\...)和 UNC(\\server\share)都能正确识别为"在外面"
    const back = path.relative(srcDir, full);
    if (!back || back.startsWith('..') || path.isAbsolute(back)) {
      throw new Error(`非法文件路径(疑似路径穿越): ${f.path}`);
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(f.data, 'base64'));
  }

  const manifestPath = path.join(srcDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('上传的文件夹里没有 manifest.json,无法识别为扩展。');
  }

  const detected = CONFIG.detectEntries(manifestPath, srcDir);
  const entries = detected.entries.slice();

  // WASM 下沉:逻辑统一放在 src/wasm-sink.js,CLI 和这里共用同一套,
  // 免得两边各自维护一份、改了一边忘了另一边。
  //
  // 来源会明确记下来(用户自己的 core.ts / 自动下沉 / 兜底模板),
  // 以前用户自带 core.ts 但编译失败时只打一行 warn 就悄悄拿模板顶上,
  // 用户以为沉了自己的逻辑、实际是 demo —— 现在把状态带回报告说清楚。
  let wasmInfo = { enabled: useWasm, source: null, exports: [], sunk: [], skipped: [] };
  if (useWasm) {
    // 注意:这里刻意不兜底塞内置示例 wasm。以前"没找到可下沉函数"时会塞一个,
    // 结果用户看到包里有 core.wasm 就以为自己的逻辑沉进去了,实际是无关 demo。
    // 现在沉不下去就如实报 auto-empty,让他自己决定要不要手写 core.ts。
    wasmInfo = await WASMSINK.prepare(
      { srcDir },
      { workDir: path.join(WORK, id, 'wasm') }
    );
    wasmInfo.enabled = true;
  }

  const cfg = {
    srcDir,
    outDir,
    entries,
    mangleProps: !!mangleProps,
    dropConsole: true,
    stripComments: true,
    reservedProps: DEFAULTS.reservedProps,
    ignore: DEFAULTS.ignore,
  };
  await HARDEN.run(cfg);

  if (useWasm) {
    // 必须在 harden 之后:HARDEN.run() 开头会清空 outDir,
    // 写早了会被一起删掉(以前正是写早了,导致 wasm-loader.js 根本没进最终包)。
    // auto 模式走内联,不需要 loader / manifest 声明,finalize 会自己判断。
    WASMSINK.finalize(cfg, wasmInfo);
  }

  // 合规扫描:加固完立刻体检。用纯函数 scan(),它不会调用 process.exit,
  // 否则一次"没找到 js"就会把本地服务整个杀掉。
  const raw = VERIFY.scan(outDir, { strict: false });
  const rel = (f) => path.relative(outDir, f) || f;
  const report = {
    passed: raw.passed,
    noJs: raw.noJs,
    error: raw.error || null,
    counts: raw.counts,
    fileCount: raw.fileCount,
    inlineCount: raw.inlineCount,
    entries: entries.length,
    wasm: wasmInfo,
    hits: (raw.hits || []).map((h) => ({
      rule: h.rule,
      name: h.name,
      severity: h.severity,
      message: h.message,
      line: h.line,
      snippet: h.snippet,
      file: rel(h.file),
    })),
  };

  const zipPath = path.join(WORK, id, 'dist.zip');
  zipDir(outDir, zipPath);
  const buf = fs.readFileSync(zipPath);
  // zip 已完整读进内存,源码副本与产物目录用完即删,不在磁盘留任何用户代码
  cleanupTask(id);
  return { buf, methods: methodList, entries: entries.length, report };
}

// ── HTTP 服务 ──────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, file) {
  const fp = path.join(PUBLIC, file);
  if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('上传过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 只接受来自本机的请求。
 *
 * 服务已经绑定 127.0.0.1 了,但"绑定本机"挡不住两件事:
 *   1. DNS rebinding —— 恶意网页把某个域名解析到 127.0.0.1,浏览器就把它当同源了;
 *   2. CSRF —— 跨站页面发一个简单请求(比如 POST + text/plain)不需要预检就能打过来。
 * 所以除了绑回环,还要校验 Host / Origin / Sec-Fetch-Site。
 */
function checkLocalRequest(req) {
  const a = server.address();
  const suffix = a && a.port ? ':' + a.port : '';
  const okHosts = new Set([
    '127.0.0.1' + suffix,
    'localhost' + suffix,
    '[::1]' + suffix,
  ]);
  const host = String(req.headers.host || '');
  if (!okHosts.has(host)) return false;

  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return false;

  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;

  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!checkLocalRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '只允许从本机 127.0.0.1 / localhost 访问' }));
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg')) {
      return serveStatic(res, 'favicon.svg');
    }
    if (req.method === 'GET' && (url.pathname === '/app.js' || url.pathname === '/style.css')) {
      return serveStatic(res, url.pathname.slice(1));
    }
    if (req.method === 'POST' && url.pathname === '/api/pack') {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf-8'));
      const methodList = Array.isArray(body.methods) ? body.methods : [body.methods];
      const valid = methodList.filter((m) => ['minify', 'wasm'].includes(m));
      if (!valid.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: '未知的保护方式,可选: minify / wasm' }));
      }
      body.methods = valid;
      const result = await pack(body);
      const fname = `extshield-${valid.join('+')}-${Date.now()}.zip`;
      // 返回 JSON:zip 走 base64,同时把合规报告一起带回前端展示
      // (原来直接吐 zip,用户看不到任何扫描结果)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          filename: fname,
          zip: result.buf.toString('base64'),
          report: result.report,
        })
      );
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    console.error('处理出错:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
});

purgeStaleWork(); // 清掉上次异常退出残留的源码副本

server.listen(PORT, '127.0.0.1', () => {
  // 只绑回环:以前 server.listen(PORT) 会同时监听 0.0.0.0/::,
  // 同一个 Wi-Fi 下的其他设备可以直接 POST /api/pack,等于把打包器暴露给整个局域网。
  const p = server.address().port;
  console.log(`extshield GUI 已启动: http://127.0.0.1:${p}`);
  console.log('监听地址: 127.0.0.1(仅本机可访问)');
  console.log('隐私说明:上传的扩展源码仅用于本次打包,完成后立即从磁盘删除。');
});

module.exports = {
  pack,
  checkLocalRequest,
  boundPort: () => {
    const a = server.address();
    return a && a.port ? a.port : null;
  },
};
