// pyodide-worker.js を本物の Pyodide で動かして確かめる。
//
// 入力待ちの経路は JSPI を要するため、`--experimental-wasm-jspi` を付けて走らせる
// （package.json の test スクリプト）。フラグが無いと run_sync が再開できず、
// stdin の往復が時間切れになる。
//
// 初期化に数秒かかるので、Worker は 1 度だけ起こして全テストで使い回す。

import test, { before } from "node:test";
import assert from "node:assert/strict";

import { startWorker } from "./helpers/worker-harness.js";

let worker;

before(async () => {
  worker = await startWorker();
}, { timeout: 120000 });

test("ready にペイロードを持たせない", () => {
  // 載せられる値（バージョン、初期化の所要時間）はいずれも測定用であり、
  // 製品のメッセージに誰も読まない欄を残すことになる（protocol.md）
  const ready = worker.received.find((m) => m.type === "ready");
  assert.deepEqual(Object.keys(ready), ["type"]);
});

test("run で stdout が逐次届き、done で終わる", async () => {
  worker.clear();
  worker.send({ type: "run", runId: "run-1", code: 'print("hello")\nprint(1 + 2)' });

  const done = await worker.waitFor((m) => m.type === "done" && m.runId === "run-1", "done");
  const stdout = worker.received.filter(worker.byType("stdout"));

  assert.deepEqual(stdout.map((m) => m.text), ["hello", "3"]);
  assert.ok(stdout.every((m) => m.runId === "run-1"), "stdout に runId が載る");
  assert.equal(done.runId, "run-1");
  assert.equal(worker.received.filter(worker.byType("error")).length, 0);
});

test("実行時エラーの traceback からユーザコード以外のフレームを落とす", async () => {
  worker.clear();
  worker.send({
    type: "run",
    runId: "run-2",
    code: [
      "# 半径から円の面積を求める",
      "import math",
      "",
      "def area(r):",
      "    return math.pi * r ** 2",
      "",
      "for r in range(0, 4):",
      "    print(area(r) / r)",
    ].join("\n"),
  });

  const error = await worker.waitFor((m) => m.type === "error" && m.runId === "run-2", "error");

  assert.equal(error.message, "ZeroDivisionError: division by zero", "message は要約行");
  assert.ok(error.traceback.startsWith("Traceback (most recent call last):"));
  assert.ok(error.traceback.includes('File "<exec>", line 8'), "ユーザコードの行を指す");

  const foreignFrames = error.traceback
    .split("\n")
    .filter((line) => line.includes('File "') && !line.includes('"<exec>"'));
  assert.deepEqual(foreignFrames, [], "<exec> 以外の File 行が残っていない");
});

test("実行中の run は受け付けず、その runId へ error を返す", async () => {
  // キューに積むと実行が終わった瞬間に次が勝手に走り出し、黙って捨てると
  // done も error も来ないまま UI が固まる（pyodide-worker.md）
  worker.clear();
  worker.send({ type: "run", runId: "run-3", code: "sum(range(4000000))" });
  worker.send({ type: "run", runId: "run-4", code: "print(1)" });

  const rejected = await worker.waitFor((m) => m.type === "error" && m.runId === "run-4", "run-4 の error");
  assert.ok(rejected.message.length > 0);

  await worker.waitFor((m) => m.type === "done" && m.runId === "run-3", "run-3 の done");
});

test("構文が正しければ diagnostics は空", async () => {
  worker.clear();
  worker.send({ type: "check", checkId: "check-1", code: 'print("ok")' });

  const result = await worker.waitFor((m) => m.type === "checkResult" && m.checkId === "check-1", "checkResult");
  assert.deepEqual(result.diagnostics, []);
});

test("構文エラーを 1 件、行・桁の形で返す", async () => {
  worker.clear();
  worker.send({
    type: "check",
    checkId: "check-2",
    code: "for r in range(1, 4):\n    print(r, area(r)",
  });

  const result = await worker.waitFor((m) => m.type === "checkResult" && m.checkId === "check-2", "checkResult");
  assert.equal(result.diagnostics.length, 1, "CPython は最初の構文エラーで解析を止める");

  const [diagnostic] = result.diagnostics;
  assert.deepEqual(
    Object.keys(diagnostic).sort(),
    ["column", "endColumn", "endLine", "line", "message"].sort(),
    "CodeMirror の語彙（from / to / severity）を含まない（ADR 0020）",
  );
  assert.equal(typeof diagnostic.line, "number");
  assert.equal(typeof diagnostic.column, "number");
  assert.equal(diagnostic.message, "'(' was never closed");
});

test("input() が stdin を送り、stdinResult で実行が再開する", async () => {
  worker.clear();
  worker.send({
    type: "run",
    runId: "run-5",
    code: 'name = input("なまえは? ")\nprint("hello", name)',
  });

  const stdin = await worker.waitFor(worker.byType("stdin"), "stdin");
  assert.equal(stdin.prompt, "なまえは? ", "プロンプトはペイロードで届く（print では流さない）");
  assert.equal(stdin.runId, "run-5");

  worker.send({ type: "stdinResult", runId: "run-5", text: "世界" });

  await worker.waitFor((m) => m.type === "done" && m.runId === "run-5", "done");
  assert.ok(worker.textOf("stdout").includes("hello 世界"));
});

test("text が null なら EOFError が上がる", async () => {
  // JS の null は Pyodide が jsnull へ写すため、Python 側は `is None` では
  // なく「1 行が返らなかったこと」で EOF を判定している（ADR 0021）
  worker.clear();
  worker.send({
    type: "run",
    runId: "run-6",
    code: ["try:", "    input()", "except EOFError as e:", '    print("EOFError:", e)'].join("\n"),
  });

  await worker.waitFor(worker.byType("stdin"), "stdin");
  worker.send({ type: "stdinResult", runId: "run-6", text: null });

  await worker.waitFor((m) => m.type === "done" && m.runId === "run-6", "done");
  assert.ok(
    worker.textOf("stdout").includes("EOF when reading a line"),
    "文言は CPython と同じにする",
  );
  assert.equal(worker.received.filter(worker.byType("error")).length, 0, "error ではなく done で終わる");
});

test("待機していないときの stdinResult と未知の type を黙って捨てる", async () => {
  // 入力を確定した直後に停止ボタンが押された経路などで正常に起こり得る
  worker.clear();
  worker.send({ type: "stdinResult", runId: "run-999", text: "x" });
  worker.send({ type: "stdinResult", runId: null, text: "y" });
  worker.send({ type: "そんなものはない", runId: "run-x" });

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(worker.received, [], "何も送り返さず、例外も出さない");
});
