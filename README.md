# extshield — Harden Chrome extensions without breaking Web Store policy

<p>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg" />
</p>

🌐 **English** | [简体中文](https://github.com/TikyZ/extshield/blob/main/README.zh-CN.md)

> Raise the cost of reverse-engineering your extension — **without tripping Chrome Web Store review**.
>
> Aggressive minification (esbuild) + property mangling (terser) + WASM sinking + a pre-upload compliance scan, plus a local visual packer.

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Usage](#usage)
- [Config file](#config-file-extshieldconfigjs)
- [Visual packer (GUI)](#visual-packer-gui)
- [Project layout](#project-layout)
- [Development & tests](#development--tests)
- [CI example (GitHub Actions)](#ci-example-github-actions)
- [Privacy](#privacy)
- [How much protection](#how-much-protection)
- [Disclaimer](#disclaimer)
- [Third-party dependencies & licenses](#third-party-dependencies--licenses)
- [License](#license)

## What it does

The Chrome Web Store **explicitly bans obfuscation** but **allows minification**.

| Technique | Allowed | Notes |
|-----------|---------|-------|
| Stripping whitespace/comments, shortening identifiers, bundling | ✅ Yes | This is minification |
| Property-name mangling (terser) | ✅ Yes (with care) | More aggressive; can break cross-file calls |
| String encryption / control-flow flattening / `eval(decrypt(...))` | ❌ **Banned** | Treated as obfuscation — the review is rejected |

Only two compliant paths genuinely qualify as "code protection":

1. **Move the core logic to the server** — the code never reaches the client (the extension only sends requests and renders results), so no one can obtain it.
2. **Compile the critical computation into WASM** — the code does reach the client, but it is inherently hard to reverse, and it does not count as JS obfuscation.

The two differ in nature: one keeps the code out of reach, the other makes it hard to read.

This tool covers step 0: it squeezes your JS into "readable, but painful to read" using compliant techniques, and runs `verify` before upload to catch anything that smells like a red line — **so you never ship policy-violating code by accident**.

## Install

Requirements: **Node.js ≥ 18** (it uses newer APIs such as `fs.rmSync`; Windows / macOS / Linux are all supported).

```bash
npm install -g extshield
```

Or, from a clone:

```bash
cd extshield
npm install        # deps: esbuild / terser / acorn / assemblyscript
```

## Usage

> **Note:** the CLI prints its progress messages in Chinese. The GUI (see below) is available in **English and Chinese**, and defaults to English unless your browser language is Chinese.

### 1) Harden (`harden`)

```bash
# uses extshield.config.js from the current directory
node bin/extshield.js harden

# explicit directories / enable property mangling
node bin/extshield.js harden --src ./src --out ./dist --mangle-props
```

What it does:

- auto-detects entry points from `manifest.json` (background / content / popup / options);
- bundles and aggressively minifies with esbuild (whitespace, identifier renaming, tree-shaking, `console`/`debugger` removal, comment stripping);
- copies static assets — manifest, HTML, CSS, images;
- optionally renames property names with terser (`--mangle-props`).

### 2) Compliance scan (`verify`)

```bash
node bin/extshield.js verify --dir ./dist
node bin/extshield.js verify --dir ./dist --strict   # CI gate: medium risk also fails
```

It scans the output and reports **high / medium** risk patterns such as:
`eval()`, `new Function()`, string passed to `setTimeout`, `atob`/`btoa` decrypt chains,
`fromCharCode` decoding, long base64 string tables, `_0x` obfuscator identifiers, control-flow
flattening, `constructor.constructor` escapes, leftover `sourceMappingURL`, remote code loading, and more.

Exit codes: `0` for pass, `1` when high-risk items are present (or medium-risk items under `--strict`). Ready to drop into CI.

### 3) One-shot demo (`demo`)

```bash
node bin/extshield.js demo
```

Runs harden + verify against the bundled `sample/` extension to confirm the tool works.

Add `--wasm` to also see the WASM sinking in action:

```bash
node bin/extshield.js demo --wasm
```

### 4) WASM sinking (`--wasm`)

Compiles "pure computation" functions into WebAssembly. The output contains wasm bytecode, which
must be disassembled before it can be read — a noticeably higher bar than plain JS. This is allowed by
Chrome policy (it is a compilation artifact, not encryption), so it passes review.

While sinking, the tool also **erases the wasm function export names down to `f0` / `f1`**: otherwise the
artifact would literally contain `(export "isSimilarUrl" ...)`, handing a reverse engineer a ready-made
map of "which function is worth looking at". Erasing the names changes no behavior — runtime interfaces
such as `memory` and `__new` keep their names; only your own function names stop leaking.

```bash
# auto sinking: the tool scans your source and picks suitable functions
node bin/extshield.js harden --src ./src --out ./dist --wasm

# manual sinking: use your own core.ts (takes priority)
node bin/extshield.js harden --src ./src --out ./dist --wasm --wasm-core ./core.ts
```

How the two modes differ:

| | Auto sinking (default) | Manual sinking (`--wasm-core`) |
|---|---|---|
| What you do | Nothing | Write your own `core.ts` |
| Which functions | The tool scans for numeric-only, browser-API-free functions | You decide |
| Output shape | **wasm inlined into JS as base64, called synchronously** | **Also inlined** (no `core.wasm` / loader) |
| manifest changes | None | None (the tool adds the required CSP allowance — see below) |
| Call sites | No changes | No changes (same-named functions are replaced) |
| Good for | Quick wins / staying away from wasm | Keeping the core algorithm under your control |

> Manual sinking used to emit a standalone `core.wasm` plus a `wasm-loader.js` (requiring
> `web_accessible_resources`, and call sites had to become `await`). It is now **inlined exactly like auto
> sinking**: synchronous instantiation, no call-site changes, and no wasm file that can be downloaded
> directly from `chrome-extension://`.

### ⚠️ Inlined wasm requires a CSP allowance (read this)

This was hit in practice: the default MV3 extension-page CSP is `script-src 'self'`, and **compiling
WebAssembly counts as code evaluation**, so wasm inlined into a `popup` / service worker is blocked outright:

```
CompileError: WebAssembly.Module(): ... violates the following CSP directive: "script-src 'self'"
```

The tool now **adds this automatically** (appending only — your existing directives are preserved, and
repeated runs do not rewrite it):

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
}
```

Three hard constraints (verified against the official Chrome docs):

- `script-src` / `object-src` / `worker-src` allow **only** `self`, `none` and `wasm-unsafe-eval`.
  Writing `'unsafe-eval'` makes the extension **fail to install** — never add it for convenience.
- `'wasm-unsafe-eval'` allows wasm without allowing `eval`; the Chrome Web Store accepts it.
- Using an **isolated-world** `content script`? No CSP work needed — Chrome's default CSP for isolated
  worlds **already includes** `'wasm-unsafe-eval'` (`script-src 'self' 'wasm-unsafe-eval' ...`), so wasm runs
  fine. But a content script that explicitly sets `"world": "MAIN"` is injected into the page's main world,
  where **the page's own CSP applies** — strict sites will block wasm. The tool therefore **excludes only
  those files from sinking** and sinks isolated-world scripts as usual. (Scripts injected dynamically via
  `chrome.scripting.executeScript({world:'MAIN'})` are not in the manifest, so the tool cannot see them —
  avoid wasm there yourself.)

Reference: <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>

A few things worth knowing up front:

- **Auto sinking never modifies your source.** It copies the source to a temp directory, edits the copy, and
  packs from that copy — your project directory is untouched. Add `--keep-stage` to keep the copy for inspection.
- **Not every function can be sunk.** Functions that touch `chrome.*` / `document` / `fetch`, or that use
  strings, arrays or objects, are skipped — those cannot run inside wasm. When it skips a function, the tool
  prints the reason; it never silently ignores them.
- **When no function qualifies, the tool does not substitute a built-in sample wasm.** The report states how many
  functions were scanned and why none of them qualified, and the package contains no wasm. This is intended to
  avoid the misconception that "a package containing core.wasm is therefore protected".
- **It only helps extensions that have pure computation logic.** If your extension is mostly UI and DOM work
  (as most popup extensions are), possibly no function can be sunk — that is normal, and in that case only
  minification + the compliance scan are doing anything. Do not count on WASM.
- To sink more functions, split the "pure computation" parts into standalone functions, separate from DOM / storage code.

You can also enable it in the config file: `wasm: true` / `wasmCore: './core.ts'`.

## Config file `extshield.config.js`

Drop it in your project root and it is picked up automatically. Every field is optional — see
`templates/extshield.config.js`.

## How much protection

- ✅ **Reversible, but laborious**: after minification and renaming the logic is still there — identifiers
  become `a`/`b`/`c` and the structure is flattened. A reverse engineer needs extra time, but a determined
  one is not stopped 100%.
- 🧱 **Costlier, still reversible**: `--wasm` compiles pure-computation functions into wasm bytecode and
  erases the function export names (no more `(export "isSimilarUrl" ...)`, which reads like a signpost).
  As measured (disassembled with binaryen): wasm **is not encryption** — function bodies, constants and
  control flow can still be recovered, it is simply far more tedious to read than JS. The goal is raising
  cost, not sealing things off.
  Enable it on the CLI with `--wasm` (auto sinking by rules, or `--wasm-core` to supply your own `core.ts`);
  the GUI checkbox runs the same logic (the CLI and GUI share `src/wasm-sink.js`).
  `wasm-template/` also ships a **separate** AssemblyScript example with a build script and loader, for
  people who prefer the classic standalone `core.wasm` route; it is independent of the tool's inlining approach.
- 🚫 **Nothing is irreversible on the client**: code that must run on the client must be readable and
  analyzable. Encryption plus runtime decryption is obfuscation explicitly banned by MV3 — this tool
  **deliberately does not do it**.
- 🔒 **The only genuinely unreachable path**: keep the core algorithm **off the client** and compute it in a
  server API. The cost is server bills, mandatory connectivity, and sending user data off-device — so it fits
  **only logic that belongs on a server anyway** (license checks, cloud data, calls that need a secret). Purely
  front-end work such as reading the DOM or rewriting pages can never be moved. This is listed to draw the
  boundary, not to recommend it for every project.
- ❌ **Not provided**: string encryption, control-flow flattening, anti-debugging — all explicitly banned by
  policy, and **deliberately omitted** here, because they would get your listing rejected.

## CI example (GitHub Actions)

```yaml
- name: Harden and verify
  run: |
    npm ci
    node bin/extshield.js harden
    node bin/extshield.js verify --dir ./dist --strict
```

## Visual packer (GUI)

Prefer clicking to typing? Start a local web app from `gui/`: pick a folder → pick a mode → pick a save
location → pack it compliantly in one click, with the compliance report rendered on the page afterwards.

```bash
node gui/server.js   # then open http://localhost:4173
```

Both modes (minify / wasm) are available as buttons; see `gui/README.md` for details.

The interface is available in **English and Chinese**. It follows your browser language — Chinese browsers get
Chinese, everything else gets English — remembers your choice, and can be forced with
`http://localhost:4173/?lang=zh` (or `?lang=en`). Switch it any time with the `中文 / EN` control in the top-right
corner.

The server binds to `127.0.0.1` only and validates Host / Origin / `Sec-Fetch-Site`, blocking DNS rebinding
and cross-site requests.

## Project layout

```
extshield/
├── bin/extshield.js        CLI entry (harden / verify / demo)
├── src/
│   ├── harden.js           esbuild bundling + aggressive minify (+ optional terser property mangling)
│   ├── verify.js           scan() pure-function scanner + run() CLI wrapper (exit codes)
│   ├── rules.js            compliance rule set (high / medium / info)
│   ├── config.js           DEFAULTS + entry detection from manifest
│   ├── auto-sink.js        auto-sink engine (acorn AST scan → AssemblyScript)
│   ├── manual-sink.js      manual sink (compiles your core.ts, replaces same-named functions)
│   ├── wasm-sink.js        shared sinking orchestration for CLI / GUI (prepare / finalize)
│   ├── wasm-rename.js      erases wasm function export names (runtime interfaces preserved)
│   ├── zip.js              pure-Node zip (no external commands)
│   └── asc.js / runtime-gen.js / wasm-loader-gen.js   compiler & runtime generation
├── gui/                    local visual packer (server.js + public/, bilingual UI)
├── templates/              config file templates
├── wasm-template/          standalone AssemblyScript example (optional, see below)
├── sample/                 bundled sample extension (used by demo)
└── test/e2e-wasm.js        end-to-end regression (npm test)
```

> `wasm-template/` is a **standalone template** for people who want to write wasm themselves instead of
> using the tool's auto sinking: it produces a separate `core.wasm` + `wasm-loader.js` (requiring
> `web_accessible_resources`). It differs from this tool's **inlining** approach — use whichever fits.

## Development & tests

```bash
npm test            # end-to-end: auto sink / manual sink / string semantics / CSP / boundary safety
```

`test/e2e-wasm.js` actually starts the GUI packing service (on a random port), actually compiles a wasm
module, then extracts and actually runs the result to verify that "the sunk version matches the original JS
output" — rather than merely checking that files exist.

## Privacy

- **GUI mode**: the extension source you upload is written temporarily to `gui/.work/<task-id>/` for
  processing, and **deleted immediately after packing** — nothing is left on disk. On startup the service
  also wipes `gui/.work/` once, to clean up copies left behind by an abnormal exit (force-kill / power loss).
- **CLI mode**: it only reads and writes the `--src` / `--out` directories you specify. With `--wasm` it
  additionally creates one copy of your source in the system temp directory (sinking must edit files, and it
  never edits your project in place), which is removed when the run ends. Use `--keep-stage` to keep it.
- Neither mode talks to the network; your source is never sent to any external server.
- Tip: do not include `gui/.work/` in your backups or file-sync scope.

## Disclaimer

- This tool only performs minification and WASM sinking that Chrome Web Store policy **allows**; it ships
  **none** of the banned obfuscation techniques. Whether your listing passes review is ultimately decided by
  the Chrome Web Store, and this tool makes no guarantee about it.
- Minification and property mangling can **break** code that depends on original identifier or property
  names (cross-file calls, external APIs, message keys, …). Verify on a small scale first and re-check with `verify`.
- Keep your own version control and backups of the output. Any consequences of using this tool are the user's own.

## Third-party dependencies & licenses

This project itself is released under MIT. It uses 16 third-party components (4 direct, 12 transitive),
**all under permissive licenses (MIT / BSD-2-Clause / BSD-3-Clause / Apache-2.0) — no GPL / AGPL / LGPL or
other copyleft licenses** — so nothing prevents this project from staying MIT, and nothing restricts how you
license the extension packages you produce.

Versions, licenses and copyright holders for each component are in
[THIRD-PARTY-NOTICES.md](https://github.com/TikyZ/extshield/blob/main/THIRD-PARTY-NOTICES.md). That file is generated by `scripts/gen-notices.js`
directly from the installed dependencies (offline, no guesswork); run `npm run notices` to regenerate it
after dependency changes.

Three things worth noting:

- **Using it as an npm dependency only**: no extra action needed. Each dependency ships its own `LICENSE`,
  which satisfies its own "retain the copyright notice" obligation; the notices file exists for readability
  and auditing (often requested during corporate open-source license review).
- **If you bundle the dependencies into what you ship** (offline bundle / single file / portable release):
  you **must** include the full license text of each component, and Apache-2.0 components additionally need
  their `NOTICE` retained. The end of the notices file gives ready-to-use commands.
- **When `--wasm` is enabled**: the produced wasm binary inlines the AssemblyScript runtime (which derives
  from TypeScript / Binaryen / musl libc / V8 / Arm Optimized Routines). Per Apache-2.0, keep its attribution
  with your artifact — see section 4 of the notices file.

## License

MIT — see [LICENSE](https://github.com/TikyZ/extshield/blob/main/LICENSE).
