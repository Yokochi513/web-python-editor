# 0027. Pyodide 一式は `vendor/` に置かず、ビルド時に `node_modules` から配る

## ステータス

採用（2026-09-19）

## コンテキスト

[ADR 0004](0004-use-pyodide-as-python-runtime.md) は Pyodide を CDN から読まず拡張に同梱すると決め、[ADR 0007](0007-use-esbuild-as-bundler.md) はその一式をバンドル対象から外して静的アセットとしてコピーすると決めた。[基本設計 §6](../design.md) はそのコピー元を `vendor/pyodide/`（「同梱する Pyodide 一式」）として置き、[§7](../design.md) はコピー対象に `vendor/pyodide/ 一式` を挙げていた。

`vendor/` の中身をどう用意するかは、どちらにも書かれていない。実際に骨組みを作る段になって、これが決まっていないとビルドが空の `dist/pyodide/` を出すことが分かった。

Pyodide は既に `package.json` の devDependencies にある（`pyodide` 314.0.7）。つまり `node_modules/pyodide/` に一式が揃っている。`vendor/` に置くとは、**同じ物をリポジトリにもう 1 部持つ**ということである。その重さは `pyodide.asm.wasm` 9.2MB、`python_stdlib.zip` 2.5MB を含めて約 13MB あり、しかもバイナリなので差分が効かない。バージョンを上げるたびに、履歴へ 13MB がもう 1 層積まれる。

一方で、`node_modules/pyodide/` をそのまま配るわけにもいかない。同梱には `console.html`、`*.d.ts`、`*.map`、`README.md` まで含まれており、**拡張のパッケージに実行時に使わないファイルが混ざる。** どちらの置き方を採っても、配るファイルを明示する必要がある。

## 決定

`vendor/` を置かない。ビルド時に `node_modules/pyodide/` から**必要なファイルだけを列挙して** `dist/pyodide/` へ直接コピーする。

| ファイル | 役割 |
| --- | --- |
| `pyodide.mjs` | Worker が `loadPyodide` を取る入口 |
| `pyodide.asm.mjs` | ランタイム本体の glue |
| `pyodide.asm.wasm` | ランタイム本体 |
| `python_stdlib.zip` | Python の標準ライブラリ |
| `pyodide-lock.json` | `loadPyodide` が読む同梱物の一覧 |

サードパーティの Python パッケージ（`*.whl`）は同梱しない（[ADR 0004](0004-use-pyodide-as-python-runtime.md)）ため、この 5 つで足りる。

`vendor/` を中継地点として残す案も採らない。`node_modules` から `vendor` へ、`vendor` から `dist` へと 13MB を 2 度コピーすることになるうえ、**配るファイルの列挙はどちらにせよ必要**で、その列挙を持てる場所は `build.js` である。中継地点は何も決めていない。

## 影響

- [基本設計 §6](../design.md) のディレクトリ構成から `vendor/` を外す。[§7](../design.md) のコピー対象を `vendor/pyodide/ 一式` から `node_modules/pyodide/` の 5 ファイルに書き換える。
- 配るファイルの一覧が `build.js` に載る。**Pyodide のバージョンを上げた際にファイル構成が変わると、ビルドは通るのに実行時に失敗する。** これを避けるため、コピー元が 1 つでも欠けていればビルドを失敗させる。`manifest.json` や html のように「無ければ飛ばす」扱いにはしない。
- Pyodide の更新は `npm update pyodide` だけで完結し、リポジトリへのコミットを伴わない。バージョンの記録は `package-lock.json` が持つ。
- クローン直後は `npm install` を済ませないとビルドが通らない。`node_modules` がビルドの入力になるため。
