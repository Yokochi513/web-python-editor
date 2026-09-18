# 0020. 構文チェックの診断は行・桁で送り、オフセットへの変換は UI 側で行う

## ステータス

採用（2026-09-15）

## コンテキスト

[ADR 0015](0015-check-syntax-before-run-in-worker.md) で構文チェックを Worker の `compile()` に置き、結果を `checkResult` で返すと決めた。[基本設計 §4](../design.md) は `diagnostics` を「最大 1 件」とだけ定め、**要素の形を定めていない**。

[pyodide-worker.md](../module_design/pyodide-worker.md) は CodeMirror の `Diagnostic`（`{ from, to, severity, message }`）をそのまま Worker から送る前提を置いていた。`SyntaxError` は行番号と桁で位置を示し、CodeMirror は文書先頭からのオフセットで位置を表すため、どこかで変換が要る。検査対象のコードは Worker も持っているため、Worker 側で変換を完結させられる。

しかしこの形は、**Worker が UI 側の描画ライブラリの型に合わせる**という依存の向きになる。[editor.md](../module_design/editor.md) は本モジュールの存在理由を「`EditorView` / `EditorState` / `Transaction` といった CodeMirror の語彙が漏れる範囲を本モジュールに閉じる」と書いており、Worker が `Diagnostic` を組み立てればこの境界は成り立たない。CodeMirror の語彙が `protocol.js` と Worker にまで漏れる。

実務上も UI 側に置く方が正しい。**変換に使うべき文書を持っているのは UI 側だけ**である。Worker が持つ `code` は検査を要求した時点のスナップショットにすぎず、結果が届くまでに編集は進んでいる。[editor.md](../module_design/editor.md) の `showDiagnostics` は既に「範囲が文書の外を指す場合は文書長へ丸める」責務を負っており、丸める相手は**現在の文書**である。

## 決定

`checkResult` の `diagnostics` は、**Python 側の語彙のまま**、行番号と桁で位置を表す。

| 欄 | 内容 |
| --- | --- |
| `line` | `SyntaxError.lineno`。1 始まり |
| `column` | `SyntaxError.offset`。1 始まり |
| `endLine` | `SyntaxError.end_lineno`。無い場合は `null` |
| `endColumn` | `SyntaxError.end_offset`。無い場合は `null` |
| `message` | `SyntaxError.msg` |

オフセット（`from` / `to`）への変換と `severity` の付与は `editor.js` が行う。**丸めと変換を同じ側に置く。**

`compile()` が通った場合は空配列を送る。要素が最大 1 件であることは変わらない（CPython は最初の構文エラーで解析を止めるため）。

## 影響

- [基本設計 §4](../design.md) の `checkResult` の説明に要素の形を加える。
- [基本設計 §3.4](../design.md) の手順 3-4 を「Worker が診断を返す」「UI が位置を変換してエディタ内に表示する」に分ける。
- [pyodide-worker.md](../module_design/pyodide-worker.md) の `toDiagnostics` は行頭オフセットの算出をやめ、`SyntaxError` の属性を写すだけになる。`code` 引数は不要になる。
- **下線の範囲（`to`）の決め方は `editor.js` の判断へ移る。** どこまで下線を引くかは表示の問題であり、Python 側に決める材料がない。
- `protocol.js` に CodeMirror の型が現れなくなる。[ADR 0003](0003-use-codemirror6-as-editor.md) を将来覆す場合、書き換えは `editor.js` に閉じる。
