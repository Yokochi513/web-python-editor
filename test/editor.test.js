// editor.js を DOM 無しで確かめる。
//
// showDiagnostics と applyViewState が view から使うのは state と dispatch だけ
// なので、偽の view を渡せば公開 API のまま試せる。createEditor（EditorView の
// 生成）だけは DOM が要るため対象外。

import test from "node:test";
import assert from "node:assert/strict";

import { EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";

import {
  applyViewState,
  buildExtensions,
  getCode,
  getViewState,
  pythonHighlightStyle,
  showDiagnostics,
} from "../src/sidepanel/editor.js";

function makeView(doc) {
  const view = {
    state: EditorState.create({ doc, extensions: buildExtensions({}) }),
    dispatched: [],
    dispatch(spec) {
      view.dispatched.push(spec);
      view.state = view.state.update(spec).state;
    },
    scrollDOM: { scrollTop: 0 },
  };
  return view;
}

/** setDiagnostics が積んだ effect から Diagnostic の配列を取り出す */
function diagnosticsOf(spec) {
  for (const effect of [].concat(spec.effects ?? [])) {
    const value = effect.value;
    if (Array.isArray(value) && value.every((d) => typeof d?.from === "number")) return value;
  }
  return null;
}

test("拡張の組み合わせが妥当で、EditorState を作れる", () => {
  const state = EditorState.create({
    doc: "print(1)",
    extensions: buildExtensions({}),
  });
  assert.equal(state.doc.toString(), "print(1)");
});

test("インデント単位はスペース 4", () => {
  const state = EditorState.create({ extensions: buildExtensions({}) });
  assert.equal(state.facet(indentUnit), "    ");
});

test("onDocChanged を渡したときだけ updateListener が増える", () => {
  const without = buildExtensions({}).length;
  const withListener = buildExtensions({ onDocChanged: () => {} }).length;
  assert.equal(withListener, without + 1);
});

test("pythonHighlightStyle を公開する", () => {
  assert.notEqual(pythonHighlightStyle, undefined);
});

test("getCode は文書全体を返す", () => {
  assert.equal(getCode(makeView("a = 1\nb = 2")), "a = 1\nb = 2");
});

test("getViewState はコード・キャレット・スクロールの 3 つだけを返す", () => {
  // 出力領域を保存対象に入れない（ADR 0013）ことを欄の数で担保する
  const state = getViewState(makeView("x = 1"));
  assert.deepEqual(Object.keys(state), ["code", "caret", "scrollTop"]);
});

test("applyViewState が文書・キャレット・スクロールを復元する", () => {
  const view = makeView("old");
  applyViewState(view, { code: "new code", caret: 3, scrollTop: 42 });

  assert.equal(getCode(view), "new code");
  assert.equal(view.state.selection.main.head, 3);
  assert.equal(view.scrollDOM.scrollTop, 42);
});

test("applyViewState は復元の注釈を付ける", () => {
  // 注釈が無いと起動直後に保存と構文チェックが走り、何も編集していないのに
  // 検査結果が出る（editor.md）
  const view = makeView("old");
  applyViewState(view, { code: "new", caret: 0 });
  assert.notEqual(view.dispatched[0].annotations, undefined);
});

test("applyViewState は範囲外のキャレットを末尾へ丸める", () => {
  const view = makeView("old");
  applyViewState(view, { code: "abc", caret: 999 });
  assert.equal(view.state.selection.main.head, 3);
});

test("applyViewState は caret / scrollTop の省略を受け付ける", () => {
  const view = makeView("old");
  applyViewState(view, { code: "abc" });
  assert.equal(view.state.selection.main.head, 3, "省略時は末尾");
  assert.equal(view.scrollDOM.scrollTop, 0, "省略時は触らない");
});

test("showDiagnostics は行・桁をオフセットへ直す", () => {
  const view = makeView("x = 1\nprint(x");
  showDiagnostics(view, [
    { line: 2, column: 6, endLine: null, endColumn: null, message: "'(' was never closed" },
  ]);

  const [diagnostic] = diagnosticsOf(view.dispatched[0]);
  assert.equal(diagnostic.from, 11, "column は 1 始まり（行頭 6 + 桁 6 - 1）");
  assert.equal(diagnostic.to, 13, "endLine が無ければ行末まで");
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.message, "'(' was never closed");
});

test("showDiagnostics は endColumn が from より手前でも壊れない", () => {
  // CPython は「'(' was never closed」に対して end_offset に 0 を返す。
  // Worker が実際に返した値をそのまま使う。
  const view = makeView("for r in range(1, 4):\n    print(r, area(r)");
  showDiagnostics(view, [
    { line: 2, column: 10, endLine: 2, endColumn: 0, message: "'(' was never closed" },
  ]);

  const [diagnostic] = diagnosticsOf(view.dispatched[0]);
  assert.equal(diagnostic.from, 31, "from は動かさず column どおり");
  assert.equal(diagnostic.to, view.state.doc.length, "行末まで引く");
});

test("showDiagnostics は文書外の位置を丸める", () => {
  // 検査を送ってから結果が届くまでにコードが短くなっていると起こり得る
  const view = makeView("x = 1");
  showDiagnostics(view, [{ line: 99, column: 99, endLine: null, endColumn: null, message: "範囲外" }]);

  const [diagnostic] = diagnosticsOf(view.dispatched[0]);
  assert.ok(diagnostic.from <= diagnostic.to);
  assert.ok(diagnostic.to <= view.state.doc.length);
});

test("showDiagnostics は空の文書でも例外にしない", () => {
  const view = makeView("");
  showDiagnostics(view, [{ line: 1, column: 1, endLine: null, endColumn: null, message: "空" }]);

  const [diagnostic] = diagnosticsOf(view.dispatched[0]);
  assert.deepEqual([diagnostic.from, diagnostic.to], [0, 0]);
});

test("showDiagnostics は空配列で下線を消せる", () => {
  const view = makeView("x = 1");
  showDiagnostics(view, []);
  assert.deepEqual(diagnosticsOf(view.dispatched[0]), []);
});

test("CodeMirror の語彙が診断の入力側へ漏れていない", () => {
  // Worker が送るのは行・桁だけで、from / to / severity は editor.js が付ける
  // （ADR 0020）
  const view = makeView("x = 1");
  showDiagnostics(view, [{ line: 1, column: 1, endLine: null, endColumn: null, message: "m" }]);

  const [diagnostic] = diagnosticsOf(view.dispatched[0]);
  assert.deepEqual(Object.keys(diagnostic).sort(), ["from", "message", "severity", "to"]);
});
