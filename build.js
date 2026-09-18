// esbuild のビルド定義（基本設計 §7 / ADR 0007）
//
// 役割は依存の解決・結合と静的アセットのコピーに限る。トランスパイルは行わない。
//
//   node build.js            1 回ビルドする
//   node build.js --watch    ソースの変更を監視して再ビルドする

import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const watch = process.argv.includes("--watch");

// バンドル対象。出力は dist/ 以下に src/ からの相対パスで並ぶ（outbase）。
// 配置は manifest.json が指すパスと一致していなければならない（基本設計 §8）。
const entryPoints = [
  "src/background/service-worker.js", // → dist/background/service-worker.js
  "src/sidepanel/main.js", // → dist/sidepanel/main.js（CodeMirror 6 がここで結合される）
  "src/worker/pyodide-worker.js", // → dist/worker/pyodide-worker.js
];

// コピー対象。[コピー元, コピー先]
const staticAssets = [
  ["manifest.json", "dist/manifest.json"],
  ["src/sidepanel/sidepanel.html", "dist/sidepanel/sidepanel.html"],
  ["src/sidepanel/style.css", "dist/sidepanel/style.css"],
];

// Pyodide 一式は node_modules から直接配る（ADR 0027）。
// node_modules/pyodide/ には console.html や *.d.ts も入っているため、
// 実行時に要るものだけを列挙する。
const pyodideAssets = [
  "pyodide.mjs", // Worker が loadPyodide を取る入口
  "pyodide.asm.mjs", // ランタイム本体の glue
  "pyodide.asm.wasm", // ランタイム本体
  "python_stdlib.zip", // Python の標準ライブラリ
  "pyodide-lock.json", // loadPyodide が読む同梱物の一覧
];

async function copyStaticAssets() {
  for (const [from, to] of staticAssets) {
    if (!existsSync(from)) {
      console.warn(`copy: ${from} が無いため飛ばす`);
      continue;
    }
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }

  // こちらは飛ばさない。欠けたままビルドが通ると、拡張を読み込んで
  // 実行するまで失敗に気付けない（ADR 0027）。
  await mkdir("dist/pyodide", { recursive: true });
  for (const name of pyodideAssets) {
    const from = `node_modules/pyodide/${name}`;
    if (!existsSync(from)) {
      throw new Error(
        `${from} が無い。npm install は済んでいるか、Pyodide の更新でファイル構成が変わっていないかを確かめること`,
      );
    }
    await cp(from, `dist/pyodide/${name}`);
  }
}

// esbuild の監視はバンドルのグラフに入っているファイルしか見ない。
// html / css / Pyodide 一式は再ビルドの完了ごとに配り直す。
const copyStaticAssetsPlugin = {
  name: "copy-static-assets",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      await copyStaticAssets();
    });
  },
};

const options = {
  entryPoints,
  outdir: "dist",
  outbase: "src",
  bundle: true,
  format: "esm",
  platform: "browser",

  // manifest.json の minimum_chrome_version と揃える（基本設計 §8）。
  // これは「この構文までは変換せずに通す」下限の宣言であって、
  // 変換を目的とした指定ではない（ADR 0007）。
  target: "chrome137",

  // Pyodide 一式はバンドルしない（ADR 0004 / ADR 0007）。
  // Worker は実行時に dist/pyodide/ から読む。コピー先のパスと一致させること。
  external: ["*/pyodide/pyodide.mjs", "*.wasm", "*.zip"],

  // 既定では日本語が \uXXXX へ落ちる。文言は UI にもログにも出るため、
  // 出力をそのまま読める形に保つ。出力は ESM で UTF-8 として解釈される。
  charset: "utf8",

  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  plugins: [copyStaticAssetsPlugin],
};

await rm("dist", { recursive: true, force: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watch 中。停止は Ctrl+C。拡張の再読み込みは手動で行う（HMR は使わない）");
} else {
  await build(options);
}
