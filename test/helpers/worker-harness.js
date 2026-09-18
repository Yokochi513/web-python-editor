// pyodide-worker.js を Node 上で動かすための足場。
//
// Worker の代わりに self を用意し、postMessage を受け取る。実行するのは
// **ビルド済みの dist/worker/pyodide-worker.js** で、Pyodide 一式が隣に
// 揃っているのがそこだけだからである。

import { cp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BUILT_WORKER = "dist/worker/pyodide-worker.js";
const NODE_WORKER = "dist/worker/_node-harness.mjs";

// ブラウザ向けの 1 行だけを Node 向けに置き換える。Pyodide の Node 側の
// ローダは file: URL を解決できず、実パスを要求する。
const BROWSER_INDEX_URL = 'const indexURL = new URL("../pyodide/", import.meta.url).href;';
const NODE_INDEX_URL = 'const indexURL = new URL("../pyodide/", import.meta.url).pathname.slice(1);';

/**
 * ビルド済みの Worker を Node で読める形に写す。
 *
 * **置き換える行が見つからなければ失敗させる。** 実装が変わったのに気付かず、
 * 別物を試し続ける状態を避ける。
 */
async function prepareWorkerModule() {
  if (!existsSync(BUILT_WORKER)) {
    throw new Error(`${BUILT_WORKER} が無い。先に npm run build を実行すること`);
  }

  const source = await readFile(BUILT_WORKER, "utf8");
  if (!source.includes(BROWSER_INDEX_URL)) {
    throw new Error(
      `${BUILT_WORKER} に indexURL の行が見つからない。実装が変わったなら worker-harness.js も直すこと`,
    );
  }

  await writeFile(NODE_WORKER, source.replace(BROWSER_INDEX_URL, NODE_INDEX_URL), "utf8");
  return NODE_WORKER;
}

export async function startWorker() {
  const received = [];
  const waiters = [];

  globalThis.self = {
    postMessage(message) {
      received.push(message);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(message)) {
          waiters[i].resolve(message);
          waiters.splice(i, 1);
        }
      }
    },
    onmessage: null,
  };

  /** 条件に合うメッセージを待つ。既に届いていればそれを返す。 */
  function waitFor(match, label, timeoutMs = 60000) {
    const hit = received.find(match);
    if (hit !== undefined) return Promise.resolve(hit);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} が届かない`)), timeoutMs);
      waiters.push({
        match,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  const modulePath = await prepareWorkerModule();
  await import(pathToFileURL(modulePath).href);

  const first = await waitFor((m) => m.type === "ready" || m.type === "initError", "ready");
  if (first.type !== "ready") throw new Error(`初期化に失敗した: ${first.message}`);

  return {
    /** UI から Worker へ送る */
    send: (data) => globalThis.self.onmessage({ data }),
    waitFor,
    byType: (type) => (m) => m.type === type,
    /** 受信済みのメッセージ。テストごとに clear() してから使う */
    received,
    clear: () => {
      received.length = 0;
    },
    textOf: (type) =>
      received
        .filter((m) => m.type === type)
        .map((m) => m.text)
        .join(""),
  };
}
