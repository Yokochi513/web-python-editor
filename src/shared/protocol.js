// UI（main.js）と Pyodide Worker（pyodide-worker.js）が共用するメッセージ種別の定義。
// 設計: docs/module_design/protocol.md、基本設計 §4
//
// 本モジュールは定義の置き場であり、振る舞いを持たない。送受信は両者が行い、
// 生成関数・検証関数・識別子の採番はいずれもここに置かない（設計書参照）。
//
// type を両側にリテラルで直書きすると、綴りの食い違いが無言の不通になる。
// メッセージは届き onmessage も発火し、ただ誰も処理しない。例外も出ない。

/** UI → Worker のメッセージ種別 */
export const UI_TO_WORKER = Object.freeze({
  RUN: "run",
  STDIN_RESULT: "stdinResult",
  CHECK: "check",
});

/** Worker → UI のメッセージ種別 */
export const WORKER_TO_UI = Object.freeze({
  READY: "ready",
  STDOUT: "stdout",
  STDERR: "stderr",
  STDIN: "stdin",
  DONE: "done",
  ERROR: "error",
  INIT_ERROR: "initError",
  CHECK_RESULT: "checkResult",
});

// 停止要求の種別は無い。停止は worker.terminate() で行う（基本設計 §3.3）。
// ready にペイロードは持たせない。載せられる値（バージョン、初期化の所要時間）は
// いずれも測定用であり、製品のメッセージに誰も読まない欄を残すことになる。

// ---------------------------------------------------------------- ペイロード
//
// type の綴りは上の定数が守るが、欄名（runId / text / prompt 等）は両側の
// 直書きのままである。ここで 1 箇所に集める。JSDoc はコメントなので
// トランスパイルを挟まずそのまま通り（ADR 0007）、エディタの補完も効く。

/** @typedef {{ runId: string, code: string }} RunPayload */

/**
 * `text` は確定した 1 行で、改行を含まない。
 * EOF の場合は `null`（ADR 0021）。
 * @typedef {{ runId: string, text: string | null }} StdinResultPayload
 */

/** @typedef {{ checkId: string, code: string }} CheckPayload */

/**
 * stdout / stderr に共通。
 * @typedef {{ runId: string, text: string }} OutputPayload
 */

/**
 * `prompt` は `input(prompt)` に渡された文字列。既定は空文字。
 * @typedef {{ runId: string, prompt: string }} StdinPayload
 */

/** @typedef {{ runId: string }} DonePayload */

/**
 * `traceback` は JS 例外の場合に空文字となる。
 * @typedef {{ runId: string, message: string, traceback: string }} ErrorPayload
 */

/** @typedef {{ message: string }} InitErrorPayload */

/**
 * `diagnostics` は最大 1 件。
 * @typedef {{ checkId: string, diagnostics: SyntaxDiagnostic[] }} CheckResultPayload
 */

/**
 * 構文エラーの位置。いずれも `SyntaxError` の属性をそのまま写したもので、
 * CodeMirror の語彙（from / to / severity）を含まない（ADR 0020）。
 * オフセットへの変換は editor.js が行う。
 *
 * `line` は `lineno`、`column` は `offset` で、ともに 1 始まり。
 * `endLine` / `endColumn` は `end_lineno` / `end_offset` で、無い場合は `null`。
 * @typedef {{ line: number, column: number, endLine: number | null, endColumn: number | null, message: string }} SyntaxDiagnostic
 */
