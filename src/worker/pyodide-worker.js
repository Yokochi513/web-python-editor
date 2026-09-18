// Pyodide を載せる Web Worker。初期化とユーザコードの実行だけを受け持つ。
// 設計: docs/module_design/pyodide-worker.md
//
// DOM には触れない。UI との接点は postMessage に限る（基本設計 §4）。
// 停止はこの Worker を terminate() で破棄して行うため（基本設計 §3.3）、
// 破棄されて困るものをここに置いてはならない。

import { loadPyodide } from "../pyodide/pyodide.mjs";
import { UI_TO_WORKER, WORKER_TO_UI } from "../shared/protocol.js";

/** @type {import("../pyodide/pyodide.mjs").PyodideInterface | null} */
let pyodide = null;

/** 実行中の runId。stdout / stderr / stdin に載せる。 @type {string | null} */
let currentRunId = null;

/**
 * 入力待ちの askLine が持つ resolve。
 * 1 つの実行の中で input() が並行することはない（Python 側は run_sync で
 * 1 件ずつ直列に待つ）ため、Map ではなく単一の値で持つ。
 * @type {((text: string | null) => void) | null}
 */
let pendingStdin = null;

function post(type, payload) {
  self.postMessage({ type, ...payload });
}

// ---------------------------------------------------------------- 初期化

// builtins.input の差し替え（ADR 0016）。
//
// EOF の判定に `line is None` を使わない。**Pyodide は JS の null を Python の
// None ではなく jsnull へ写す**ため、`is None` が成立せず input() が sentinel
// をそのまま返す（実機で確認）。1 行が返らなかったことを EOF とみなす方が
// 変換の仕様に依存せずに済む（ADR 0021）。
// setStdin は使わない。あちらの読み取りフックは同期的に文字列を返す C レベルの
// もので、JSPI のスタックスイッチングの外側にある。Promise を返しても文字列と
// 解釈できず OSError になる。
//
// sys.stdout.flush() は print("名前: ", end="") のような改行を伴わない
// プロンプトを入力待ちの前に出し切るために要る。batched は行単位で呼ばれる
// ため、flush しないと問いかけが画面に出ないまま入力待ちになる。
//
// プロンプトは print で標準出力へ流さない。askLine に渡して stdin メッセージ
// のペイロードとして届け、UI が 1 回の受信で表示とキャレットの設置をまとめて
// 処理できるようにする。
const INSTALL_INPUT_PY = `
import builtins
import sys
from pyodide.ffi import run_sync
import js

def _input(prompt=""):
    sys.stdout.flush()
    line = run_sync(js.askLine(str(prompt)))
    if not isinstance(line, str):
        raise EOFError("EOF when reading a line")
    return line

builtins.input = _input
`;

// 構文チェック（ADR 0015）。SyntaxError の属性（lineno / offset / …）は
// JS 側へ投げると失われるため、例外を投げずに SyntaxError そのものを返す。
// JS は返った PyProxy から属性を読む。
//
// SyntaxError 以外は None を返して空の diagnostics に落とす。検査の失敗を
// 実行時エラーとして出力領域に出すことはしない（基本設計 §5.2）。
const INSTALL_CHECK_PY = `
def _check_syntax(code):
    try:
        compile(code, "<editor>", "exec")
    except SyntaxError as e:
        return e
    except Exception:
        return None
    return None
`;

function installInput(instance) {
  globalThis.askLine = askLine;
  instance.runPython(INSTALL_INPUT_PY);
}

function installCheck(instance) {
  instance.runPython(INSTALL_CHECK_PY);
}

async function init() {
  try {
    // dist/ での配置は build.js による（ADR 0027）。Worker は dist/worker/ に
    // 置かれるため、Pyodide 一式は 1 段上の dist/pyodide/ にある。
    const indexURL = new URL("../pyodide/", import.meta.url).href;
    const instance = await loadPyodide({ indexURL });

    // batched は行単位で呼ばれる。まとめず逐次送るのは、長時間の実行中に
    // 画面が無反応に見える状態を避けるため。raw（文字単位）へは切り替えない。
    // print("hello") だけで postMessage が 6 回になり、print を続けるコードで
    // UI スレッドがメッセージの処理で埋まる。
    instance.setStdout({
      batched: (text) => post(WORKER_TO_UI.STDOUT, { runId: currentRunId, text }),
    });
    instance.setStderr({
      batched: (text) => post(WORKER_TO_UI.STDERR, { runId: currentRunId, text }),
    });

    installInput(instance);
    installCheck(instance);

    // 暖機（ADR 0025）。loadPyodide の完了後、最初の runPythonAsync には
    // 追加のコストがかかる。差し替えを済ませた後に置くのは、済ませる前だと
    // 暖める経路が本番と違うものになるため。
    //
    // 暖機自体の失敗は initError にしない。Pyodide は既に使える状態にある。
    try {
      await instance.runPythonAsync("pass");
    } catch (err) {
      console.warn("暖機に失敗した。初期化は続行する", err);
    }

    pyodide = instance;
    post(WORKER_TO_UI.READY, {});
  } catch (err) {
    // 再試行はしない。UI は出力領域へインラインで表示して再試行の導線を出し
    // （ADR 0011）、再試行は Worker の作り直しとして UI が行う。失敗した
    // Worker がここで粘る必要がない。
    post(WORKER_TO_UI.INIT_ERROR, { message: String(err) });
  }
}

// ---------------------------------------------------------------- 受信

function handleMessage(event) {
  const data = event.data;

  // pyodide が null（初期化前・初期化失敗）でも run / check は届き得る。
  // UI は ready まで実行ボタンを無効にするが、その抑止は UI の内部事情で
  // あり、本モジュールが依存してよい前提ではない。
  //
  // 黙り込まないこと。done も error も来ないまま、UI が停止ボタンだけ有効な
  // 状態で固まる。
  if (pyodide === null) {
    if (data.type === UI_TO_WORKER.RUN) {
      post(WORKER_TO_UI.ERROR, {
        runId: data.runId,
        message: "Python の初期化が完了していません",
        traceback: "",
      });
    } else if (data.type === UI_TO_WORKER.CHECK) {
      post(WORKER_TO_UI.CHECK_RESULT, { checkId: data.checkId, diagnostics: [] });
    }
    return;
  }

  switch (data.type) {
    case UI_TO_WORKER.RUN:
      handleRun(data);
      break;
    case UI_TO_WORKER.STDIN_RESULT:
      handleStdinResult(data);
      break;
    case UI_TO_WORKER.CHECK:
      handleCheck(data);
      break;
    default:
      break;
  }
}

// 未確定の出力を出し切る。batched は改行のほか flush でも呼ばれる。
function flushStreams() {
  try {
    pyodide.runPython("import sys\nsys.stdout.flush()\nsys.stderr.flush()");
  } catch (err) {
    // 出し切れなくても、実行の結末を伝える方が優先される。
    console.warn("flush に失敗した", err);
  }
}

async function handleRun(payload) {
  const { runId, code } = payload;

  // 実行中の run は受け付けない。Pyodide はシングルスレッドで、並行して
  // 走らせることはそもそもできない。キューに積むと実行が終わった瞬間に次が
  // 勝手に走り出し、黙って捨てると UI が固まる。
  if (currentRunId !== null) {
    post(WORKER_TO_UI.ERROR, {
      runId,
      message: "前の実行がまだ終わっていません",
      traceback: "",
    });
    return;
  }

  currentRunId = runId;
  try {
    // runPythonAsync を通す。JSPI のスタックスイッチングはこの入口を通った
    // 実行でのみ有効になり、input() の同期化がこれに依存する（ADR 0012）。
    // 戻り値（最後の式の値）は使わない。
    await pyodide.runPythonAsync(code);
    flushStreams();
    post(WORKER_TO_UI.DONE, { runId });
  } catch (err) {
    // PythonError と JS 例外を区別しない。UI から見ればどちらも
    // 「実行が異常終了した」であり、表示のされ方も同じ（ADR 0011）。
    flushStreams();
    post(WORKER_TO_UI.ERROR, { runId, ...toErrorPayload(err) });
  } finally {
    currentRunId = null;
    pendingStdin = null;
  }
}

// 実行中・入力待ちの check も拒まない。JSPI で実行が中断している最中に
// compile() を呼べることは実機で確認済み。基本設計 §3.4 が実行中の検査を
// 抑止するのは下線を消さないための UI 側の都合であって、安全性のためではない。
function handleCheck(payload) {
  const { checkId, code } = payload;
  let checkSyntax = null;
  let err = null;
  try {
    checkSyntax = pyodide.globals.get("_check_syntax");
    err = checkSyntax(code);
    post(WORKER_TO_UI.CHECK_RESULT, {
      checkId,
      diagnostics: err ? toDiagnostics(err) : [],
    });
  } catch (e) {
    post(WORKER_TO_UI.CHECK_RESULT, { checkId, diagnostics: [] });
  } finally {
    err?.destroy?.();
    checkSyntax?.destroy?.();
  }
}

function handleStdinResult(payload) {
  if (pendingStdin === null) return;
  if (payload.runId !== currentRunId) return;

  // 空にしてから resolve を呼ぶ。resolve から同期的に次の input() へ進む経路が
  // あり得るため、順序を逆にすると次の askLine が入れた resolve を消す。
  const resolve = pendingStdin;
  pendingStdin = null;
  resolve(payload.text);
}

// Python 側は run_sync でこの Promise を待つ（ADR 0016）。
// reject の経路は持たせない。入力待ちの中断は停止ボタンによる Worker の破棄で
// のみ起こり、その場合この Promise ごと消える。reject する相手が残らない。
function askLine(prompt) {
  post(WORKER_TO_UI.STDIN, { runId: currentRunId, prompt });
  return new Promise((resolve) => {
    pendingStdin = resolve;
  });
}

// ---------------------------------------------------------------- 変換

// ユーザコードは runPythonAsync 経由で走るため、traceback には
// /lib/python*.zip/_pyodide/_base.py のようなフレームが混ざる。input() 由来の
// 例外には _input と run_sync のフレームも入る。そのまま見せると、ユーザは
// 自分の書いていないファイルの行を読むことになる。
//
// 基準は 1 つ。File "..." 行のうちファイル名が <exec> でないものを、続く
// ソース行ごと落とす。<exec> は runPythonAsync がユーザコードに付ける名前。
function stripInternalFrames(traceback) {
  const lines = traceback.split("\n");
  const kept = [];
  let keptFrames = 0;
  let droppedFrames = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*File "([^"]*)"/.exec(lines[i]);
    if (match === null) {
      kept.push(lines[i]);
      continue;
    }
    if (match[1] === "<exec>") {
      keptFrames += 1;
      kept.push(lines[i]);
      continue;
    }
    droppedFrames += 1;
    // ソース行とキャレット行は File 行より深く字下げされている。次の File 行
    // か、字下げの浅い行（末尾の要約行）に当たるまで一緒に落とす。
    while (i + 1 < lines.length && /^\s{4,}/.test(lines[i + 1]) && !/^\s*File "/.test(lines[i + 1])) {
      i += 1;
    }
  }

  // すべてのフレームが落ちる場合は削らない。削った結果が要約行だけになると、
  // 原因を追う手がかりがゼロになる。ユーザコードの外だけで起きた例外が該当する。
  if (keptFrames === 0 && droppedFrames > 0) return traceback;
  return kept.join("\n");
}

function summaryLine(traceback) {
  const lines = traceback.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 0 ? lines[lines.length - 1].trim() : "";
}

// 変換に失敗し得る入力を受けても必ず値を返す。エラーの整形でエラーを出すと、
// 元の失敗がユーザに届かなくなる。
function toErrorPayload(err) {
  // PythonError は message に traceback 本体を持ち、type に例外クラス名を持つ。
  const isPythonError =
    err !== null && typeof err === "object" && typeof err.type === "string" && typeof err.message === "string";

  if (!isPythonError) return { message: String(err), traceback: "" };

  const traceback = stripInternalFrames(err.message).trimEnd();
  return { message: summaryLine(traceback) || String(err.type), traceback };
}

// 位置は行番号と桁のまま送る（ADR 0020）。オフセットへの変換と、下線をどこまで
// 引くかの判断は editor.js が行う。本関数が見た code は検査を要求した時点の
// スナップショットにすぎず、結果が届くまでに編集は進んでいる。
function toDiagnostics(err) {
  // lineno や offset が欠けている SyntaxError があり得る。位置が分からない
  // ことは、エラーを伝えないことの理由にならない。
  const line = Number.isFinite(err.lineno) ? err.lineno : 1;
  const column = Number.isFinite(err.offset) ? err.offset : 1;
  const endLine = Number.isFinite(err.end_lineno) ? err.end_lineno : null;
  const endColumn = Number.isFinite(err.end_offset) ? err.end_offset : null;
  const message = typeof err.msg === "string" ? err.msg : "SyntaxError";

  return [{ line, column, endLine, endColumn, message }];
}

// ---------------------------------------------------------------- 起動

self.onmessage = handleMessage;

// 初期化は UI からの指示を待たずに自動で始める（基本設計 §3.1 の手順 3）。
init();
