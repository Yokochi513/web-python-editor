// 配布用の ZIP を組み立てる（ADR 0032）。
//
//   node package.js
//
// dist/ の中身をそのまま ZIP にする。Chrome ウェブストアへ上げるのはこの 1 ファイル
// で、展開すると manifest.json が最上位に来る形にする（フォルダで包まない）。
//
// 圧縮に外部の依存を使わない。ZIP の構造は固定長のヘッダと中央ディレクトリだけ
// で、deflate と CRC32 は node:zlib が持っている（ADR 0032）。

import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

const DIST = "dist";
const OUT_DIR = "release";

/**
 * dist/ 以下のファイルを、ZIP に入れる順（パス順）で集める。
 *
 * 名前が `_` で始まるものは入れない。テストは Worker を Node で動かすために
 * dist/worker/ へ写しを置く（test/helpers/worker-harness.js）。npm test の直後に
 * 固めると、それが配布物に混ざる。実際に 1 度混ざった。
 */
async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith("_")) {
      console.warn(`skip: ${join(dir, entry.name)}（配布物に含めない）`);
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else files.push(path);
  }
  return files;
}

/** ZIP が使う MS-DOS 形式の日時。秒は 2 秒刻みでしか持てない。 */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function localHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // flags: 名前を UTF-8 とみなす
  header.writeUInt16LE(8, 8); // method: deflate
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.day, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed.length, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([header, entry.name]);
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0); // central directory header signature
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.day, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed.length, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30); // extra field length
  header.writeUInt16LE(0, 32); // file comment length
  header.writeUInt16LE(0, 34); // disk number start
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

function endOfCentralDirectory(count, size, offset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(count, 8); // entries on this disk
  end.writeUInt16LE(count, 10); // entries in total
  end.writeUInt32LE(size, 12); // size of the central directory
  end.writeUInt32LE(offset, 16); // offset of the central directory
  end.writeUInt16LE(0, 20); // comment length
  return end;
}

if (!existsSync(DIST)) {
  throw new Error(`${DIST} が無い。先に npm run build を実行すること`);
}

const manifest = JSON.parse(await readFile(join(DIST, "manifest.json"), "utf8"));
const files = await collectFiles(DIST);
const { time, day } = dosDateTime(new Date());

const parts = [];
const central = [];
const entries = [];
let offset = 0;
let totalSize = 0;

for (const path of files) {
  const content = await readFile(path);
  const entry = {
    // ZIP の区切りは常に / 。Windows の \ をそのまま入れると展開側で 1 つの
    // 名前として扱われ、階層が失われる。
    name: Buffer.from(relative(DIST, path).split("\\").join("/"), "utf8"),
    size: content.length,
    crc: crc32(content),
    compressed: deflateRawSync(content, { level: 9 }),
    time,
    day,
    offset,
  };

  totalSize += entry.size;
  entries.push(entry);

  const local = localHeader(entry);
  parts.push(local, entry.compressed);
  offset += local.length + entry.compressed.length;
  central.push(centralHeader(entry));
}

const centralBuffer = Buffer.concat(central);
const zip = Buffer.concat([
  ...parts,
  centralBuffer,
  endOfCentralDirectory(files.length, centralBuffer.length, offset),
]);

// 書いた ZIP を、仕様の位置から読み直して確かめる。
//
// 形式を自前で組み立てている以上、「作れた」ことは「読める」ことを意味しない。
// 実際、中央ディレクトリの位置を 2 バイトずれた欄へ書いていた不具合が、この
// 読み直しの無い状態では通り抜けていた。展開して 0 ファイルになるまで気付けない。
function verify(buffer, expected) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("ZIP の検証: 中央ディレクトリの終端が見つからない");

  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const start = buffer.readUInt32LE(eocd + 16);

  if (count !== expected.length) {
    throw new Error(`ZIP の検証: 件数が合わない（${count} ≠ ${expected.length}）`);
  }
  if (start + size !== eocd) {
    throw new Error(`ZIP の検証: 中央ディレクトリの位置と大きさが終端に届かない`);
  }

  let cursor = start;
  for (const entry of expected) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`ZIP の検証: ${entry.name} の中央ディレクトリの目印が無い`);
    }
    const localAt = buffer.readUInt32LE(cursor + 42);
    if (buffer.readUInt32LE(localAt) !== 0x04034b50) {
      throw new Error(`ZIP の検証: ${entry.name} のローカルヘッダの目印が無い`);
    }
    // 中身まで確かめる。ヘッダだけ合っていても、位置がずれていれば別の
    // バイト列を指している。
    const nameLen = buffer.readUInt16LE(localAt + 26);
    const extraLen = buffer.readUInt16LE(localAt + 28);
    const from = localAt + 30 + nameLen + extraLen;
    const stored = buffer.subarray(from, from + entry.compressed.length);
    if (crc32(inflateRawSync(stored)) !== entry.crc) {
      throw new Error(`ZIP の検証: ${entry.name} の中身が復元できない`);
    }
    cursor += 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
}

verify(zip, entries);

await mkdir(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `web-python-editor-${manifest.version}.zip`);
await writeFile(outPath, zip);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
console.log(outPath);
console.log(`  ${files.length} ファイル  ${mb(totalSize)} → ${mb(zip.length)}`);
console.log(`  manifest.json の version: ${manifest.version}`);
