// CodeMirror 6 の構成。エディタの生成、文書の取り出しと復元、構文チェック結果の
// 表示だけを受け持つ。
// 設計: docs/module_design/editor.md
//
// Worker とのやり取り・ボタンの活性・出力領域・保存はすべて main.js の担当。
// EditorView / EditorState / Transaction といった CodeMirror の語彙が漏れる範囲を
// 本モジュールに閉じる（ADR 0014）。

import { Annotation, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { linter, setDiagnostics } from "@codemirror/lint";
import { python } from "@codemirror/lang-python";
import { tags as t } from "@lezer/highlight";

/**
 * 復元によるトランザクションに付ける印。
 * これが付いた更新では onDocChanged を呼ばない（applyViewState 参照）。
 */
const restoreAnnotation = Annotation.define();

// 色は Figma の syntax/* トークンと 1 対 1 で対応させる（ADR 0009）。
//
// bool と null を syntax/number に寄せるのは、True / False / None が構文上の
// 要素ではなくリテラルだからである。keyword に寄せると、値であることが色から
// 読めなくなる。
export const pythonHighlightStyle = HighlightStyle.define([
  { tag: [t.variableName, t.propertyName, t.operator, t.punctuation], color: "#383a42" },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#a626a4" },
  { tag: [t.string, t.special(t.string)], color: "#50a14f" },
  { tag: [t.number, t.bool, t.null], color: "#986801" },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName))], color: "#4078f2" },
  { tag: [t.comment, t.lineComment], color: "#a0a1a7" },
]);

/**
 * 有効にする拡張を明示的に並べた配列を返す（ADR 0014）。basicSetup は使わない。
 * **この関数の中身が「どの機能を持つエディタか」の定義そのもの**になる。
 *
 * 含めないもの。折りたたみ（ガターをもう 1 列使う）、検索（狭い幅にパネルを
 * 重ねる）、現在行の強調と一致強調（配色トークンが未定義）、矩形選択。
 *
 * 行の折り返しも行わない。EditorView.lineWrapping を含めない。折り返すと行番号と
 * 表示行がずれるため、長い行は横スクロールで扱う。
 *
 * EditorState.readOnly / EditorView.editable は扱わない。実行中・入力待ちの間も
 * エディタは編集可能なままとする（ADR 0026）。状態によって切り替える経路を
 * 作らないため、本モジュールに実行状態が漏れてこない。
 */
export function buildExtensions(options = {}) {
  const extensions = [
    lineNumbers(),
    python(),
    syntaxHighlighting(pythonHighlightStyle),
    history(),
    keymap.of(historyKeymap),
    // closeBrackets の Backspace は defaultKeymap の deleteCharBackward より先に
    // 見せる必要がある。キーマップは先に置いたものが優先されるため、
    // closeBrackets() 本体とは離れてここに置く。
    keymap.of(closeBracketsKeymap),
    keymap.of(defaultKeymap),
    indentOnInput(),
    indentUnit.of("    "),
    keymap.of([indentWithTab]),
    closeBrackets(),
    bracketMatching(),
    // 補完のソースは python() が登録する localCompletionSource と globalCompletion に
    // 任せ、override は使わない（ADR 0018）。
    autocompletion(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    // 状態フィールドだけを入れる。source に null を渡すことで、linter() の周期的な
    // 呼び出しは起きない。検査の実体は Worker 側の compile() にあり、結果は
    // showDiagnostics から setDiagnostics で差し込む。lintGutter は伴わない。
    linter(null),
  ];

  if (options.onDocChanged) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        // 復元による変更では呼ばない。呼ぶと起動直後に保存と構文チェックが走り、
        // 何も編集していないのに検査結果が出る。
        if (update.transactions.some((tr) => tr.annotation(restoreAnnotation) !== undefined)) return;
        options.onDocChanged();
      }),
    );
  }

  return extensions;
}

/**
 * Pyodide の初期化を待たずに呼ぶ。エディタは初期化完了前から編集可能な状態で
 * 表示し、実行ボタンだけを無効にしておく（基本設計 §3.1）。
 *
 * デバウンスは行わない。保存と構文チェックが求める 500ms の待ちは main.js 側の
 * 関心事であり、本モジュールは「変わった」という事実だけを伝える。
 */
export function createEditor(options) {
  const state = EditorState.create({
    doc: options.doc ?? "",
    extensions: buildExtensions(options),
  });
  return new EditorView({ state, parent: options.parent });
}

export function getCode(view) {
  return view.state.doc.toString();
}

/**
 * chrome.storage.local へ保存する対象をまとめて取り出す（ADR 0013）。
 *
 * 出力領域の内容は含めない。開き直した時点で Worker は作り直されており、前回の
 * 結果だけが残ると現在の出力と誤読される。本関数が出力領域を一切参照しない
 * ことでこれを担保する。
 *
 * caret は位置 1 点（head）で持ち、選択範囲は保存しない。範囲を復元すると、
 * 再開直後の打鍵が選択を置換する事故になる。
 */
export function getViewState(view) {
  return {
    code: getCode(view),
    caret: view.state.selection.main.head,
    scrollTop: view.scrollDOM.scrollTop,
  };
}

/**
 * 保存しておいた状態を復元する。パネルを開いた直後、Pyodide の初期化を待たずに
 * 呼ぶ（基本設計 §2.2）。
 *
 * caret が文書長を超える場合は例外とせず末尾へ丸める。複数ウィンドウで同時に
 * 開いた場合の後勝ち（ADR 0013）が正常な経路として存在するため、位置の食い違いは
 * 異常ではない。
 */
export function applyViewState(view, state) {
  const code = state.code ?? "";
  const caret = clamp(Number.isFinite(state.caret) ? state.caret : code.length, 0, code.length);

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: code },
    selection: { anchor: caret },
    annotations: restoreAnnotation.of(true),
  });

  if (Number.isFinite(state.scrollTop)) {
    view.scrollDOM.scrollTop = state.scrollTop;
  }
}

/**
 * Worker から届いた checkResult を下線とツールチップで表示する（ADR 0015）。
 *
 * 受け取るのは行・桁で表された診断であり、CodeMirror の Diagnostic への変換は
 * 本関数が行う（ADR 0020）。Worker に組み立てさせると依存の向きが逆になる。
 *
 * 空配列を渡すと表示中の下線が消える。検査を行わない間（初期化完了前、実行中、
 * 入力待ちの間）は本関数を呼ばないこと。呼んで消すと、直ったと読めてしまう。
 */
export function showDiagnostics(view, diagnostics) {
  view.dispatch(setDiagnostics(view.state, toCodeMirrorDiagnostics(view.state, diagnostics)));
}

/**
 * 入力待ちから戻る経路のためにある。キャレット位置は動かさない。
 *
 * 呼ぶ契機は実行の終了（done / error）と停止で、判断は main.js 側。入力の確定時に
 * 置かないのは、input() がループする場合にフォーカスが出力領域とエディタの間を
 * 往復するためである。
 */
export function focusEditor(view) {
  view.focus();
}

// ---------------------------------------------------------------- 内部

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lineAt(doc, lineNumber) {
  const n = Number.isFinite(lineNumber) ? lineNumber : 1;
  return doc.line(clamp(Math.trunc(n), 1, doc.lines));
}

// line / column は 1 始まりで、SyntaxError の lineno / offset をそのまま写した
// もの（基本設計 §4）。文書先頭からのオフセットへはここで変換する。
//
// 範囲は文書長へ丸めて渡し、例外にしない。検査要求を送ってから結果が届くまでの
// 間にコードが短くなっていると範囲外を指し得る。構文エラーの表示位置がずれる
// ことは、下線がまったく出ないことよりは軽い。
function toCodeMirrorDiagnostics(state, diagnostics) {
  const doc = state.doc;

  return diagnostics.map((diagnostic) => {
    const line = lineAt(doc, diagnostic.line);
    const column = Number.isFinite(diagnostic.column) ? diagnostic.column : 1;
    let from = clamp(line.from + column - 1, 0, doc.length);

    let to = null;
    if (Number.isFinite(diagnostic.endLine) && Number.isFinite(diagnostic.endColumn)) {
      const endLine = lineAt(doc, diagnostic.endLine);
      to = clamp(endLine.from + diagnostic.endColumn - 1, 0, doc.length);
    }

    // 行末まで引く。CPython の ^ が指す位置以降が疑わしいという実態に合う。
    // 該当トークンの末尾までに絞るには字句解析が要り、compile() だけで済ませる
    // という方針（ADR 0015）に反する。
    //
    // endColumn が from より手前を指すことは実際にある。CPython は
    // 「'(' was never closed」に対して end_offset に 0 を返す。
    if (to === null || to <= from) {
      to = line.to;
    }

    // ここまで来てなお幅 0 なら、from を 1 文字戻す。見えない下線を避けるための
    // 最後の手当てで、行末にエラー位置が来る「予期しない EOF」系で効く。
    if (to <= from) {
      from = clamp(from - 1, line.from, doc.length);
    }

    return { from, to: Math.max(to, from), severity: "error", message: diagnostic.message };
  });
}
