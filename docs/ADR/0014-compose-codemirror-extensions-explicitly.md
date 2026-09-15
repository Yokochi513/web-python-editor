# 0014. CodeMirror 6 は `basicSetup` を使わず、拡張を明示的に構成する

## ステータス

採用（2026-09-15）

## コンテキスト

[ADR 0003](0003-use-codemirror6-as-editor.md) で CodeMirror 6 の採用は決めたが、どこまでの機能を組み込むかは未決定のまま残っていた（[基本設計 §9](../design.md)）。

判断材料になるものとならないものを先に切り分ける。

- **ならない — バンドルサイズ。** 拡張パッケージには Pyodide 一式（wasm と標準ライブラリ）を同梱する（[ADR 0004](0004-use-pyodide-as-python-runtime.md)）。CodeMirror の拡張を数個増減させても全体から見れば誤差であり、「軽いから削る」という理由は成立しない。
- **なる — 表示幅。** サイドパネルは 400px 前後で（[ADR 0006](0006-use-side-panel-as-editor-surface.md)）、ガターを 1 列足すだけでコード領域が削れる。パネルを重ねる UI も窮屈になる。
- **なる — 約束した体験。** [README](../../README.md) は「シンタックスハイライトや補完など、エディタとして使える最低限の体験」を目的に挙げている。補完を落とすことは目的の側を書き換えることになる。
- **なる — 既存の配色定義。** Figma には `syntax/keyword` 以下 6 色のトークンが既にある（[ADR 0008](0008-manage-screen-design-in-figma.md) / [ADR 0009](0009-use-light-theme-as-base.md)）。これを使う以上、`defaultHighlightStyle` ではなく自前の `HighlightStyle` が要る。

構成の選び方は 3 つ。

- **`basicSetup` をそのまま使う**: 最短だが中身は固定で、ガターを消費する折りたたみ、検索パネル、狭い画面では使い道のない矩形選択まで付いてくる。外すには結局中身を知る必要があり、そのまま使う利点が消える。
- **`minimalSetup` を使う**: 行番号も補完もブラケット補完も含まれない。README の約束にも、行番号込みで描かれた Figma の画面設計にも届かず、結局足すことになる。
- **拡張を明示的に並べる**: 何が入っているかがコードに現れ、幅の予算を自分で決められる。

## 決定

`basicSetup` / `minimalSetup` のいずれも使わず、**必要な拡張を明示的に並べて構成する**。

### 含めるもの

| 拡張 | 目的 |
| --- | --- |
| `lineNumbers` | 行番号ガター。Figma の全アートボードが行番号込みで描かれている |
| `python()` + 自前の `HighlightStyle` | 構文解析とハイライト。Figma の `syntax/*` トークン 6 色に対応づける |
| `history` + `historyKeymap` | undo / redo |
| `defaultKeymap` | 基本的なカーソル移動と編集 |
| `indentOnInput` | `else:` `elif:` などの入力時のデデント |
| `indentWithTab` + `indentUnit`（スペース 4） | Tab によるインデント |
| `closeBrackets` + `closeBracketsKeymap` / `bracketMatching` | 括弧の補完と対応表示 |
| `autocompletion` + `completionKeymap` + `globalCompletion` | キーワード・組み込み・ローカル変数の補完 |
| `drawSelection` / `dropCursor` / `highlightSpecialChars` | 選択とカーソルの描画 |

`python()` にはローカル変数の補完が含まれ、標準の組み込みとキーワードの補完は `globalCompletion` を明示的に足して得る。**いずれも静的な補完であり、実行中のオブジェクトを見た補完ではない。**

### 含めないもの

| 拡張 | 理由 |
| --- | --- |
| `foldGutter` / `codeFolding` | ガターをもう 1 列使う。思いつきを試す規模のコードに畳む対象がない |
| `search` + `searchKeymap` | 400px にパネルを重ねると窮屈。必要になった時点で足す |
| `highlightActiveLine` / `highlightActiveLineGutter` | 新しい配色トークンが要る（[ADR 0009](0009-use-light-theme-as-base.md) の定義範囲外） |
| `rectangularSelection` / `crosshairCursor` / `highlightSelectionMatches` | 狭い幅で使い所がなく、配色トークンも未定義 |

### 折り返しと Tab

- **行の折り返しは行わない**（`EditorView.lineWrapping` を入れない）。折り返すと行番号と表示行がずれる。Python は 1 行が長くなりにくく、横スクロールの頻度は低いと見込む。
- **Tab はエディタが取る**（`indentWithTab` を入れる）。Python ではインデントが構文であり、Tab でインデントできないことの損失が大きい。

## 影響

- **サイドパネル内のコードを検索する手段がなくなる。** ブラウザの検索バーはページ側を対象とするため、`search` を入れない限り代替はない。
- **Tab でフォーカスを移動できなくなる。** CodeMirror が `indentWithTab` を既定に含めていないのはこの理由による。逃げ道は Esc を押してから Tab。サイドパネルには編集面が 1 つしかなく、フォーカス移動の相手が実質ツールバーに限られるため、この代償を受け入れる。
- **長い行では横スクロールが発生する。** 出力領域側の traceback をどう扱うかは独立に判断してよい（[ADR 0011](0011-show-errors-inline-in-output-pane.md)）。
- 自前の `HighlightStyle` を持つため、Figma のトークンを変更した場合はエディタ側の対応表も直す必要がある。対応関係は 1 対 1 に保つ。
- ここで挙げた拡張を後から足すこと自体は難しくない。**ただし折りたたみと検索はガターやパネルの取り合いに直結するため、足す場合は画面設計（[ADR 0008](0008-manage-screen-design-in-figma.md)）と併せて新しい ADR で判断する。**
- 補完が静的である以上、実行中のオブジェクトに基づく補完を求める場合は Worker への問い合わせが必要になる。これは別の決定になる。
