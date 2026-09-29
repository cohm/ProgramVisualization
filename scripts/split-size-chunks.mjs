#!/usr/bin/env node
// Sort the built client chunks into application code and study-plan data, so
// size-limit can budget them separately.
//
// Every JSON file under src/data becomes its own lazily loaded chunk, because
// useCourseModel.ts imports data by template literal. A viewer downloads only
// the chunks for what they open, but size-limit counted them all together with
// the app: 202 kB of code and 290 kB of data under one 500 kB limit. Adding a
// programme's cohort archive therefore looked like the app growing, and the
// master programmes would have broken the budget with no code change at all.
//
// Chunk names are content hashes, so they cannot be told apart by name. A
// chunk is classed as data only when it holds exactly one module whose body is
// `x.exports = <literal>`, AND running that module yields a value equal to the
// contents of a file in src/data. The second test is what makes the split
// trustworthy: nothing is called data because it looks like data.
//
// Output: .next/size-limit/app/*.js and .next/size-limit/data/*.js, copies of
// the chunks, which the two size-limit entries in package.json measure.
//
// Written against Turbopack's production chunk format, which CI and Vercel
// build with. Any other format finds no data chunks and fails loudly.

import { readdirSync, readFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const chunksDir = join(repoRoot, '.next/static/chunks');
const dataDir = join(repoRoot, 'src/data');
const outDir = join(repoRoot, '.next/size-limit');

const SINGLE_JSON_MODULE =
  /^\(globalThis\.TURBOPACK\|\|\(globalThis\.TURBOPACK=\[\]\)\)\.push\(\["object"==typeof document\?document\.currentScript:void 0,\d+,\(\w+,\w+,\w+\)=>\{\w+\.exports=(JSON\.parse\(|\[|\{)/;
const MODULE_HEADER = /,\d+,\(\w+,\w+,\w+\)=>\{/g;

function listFiles(dir, ext) {
  return readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(ext))
    .map((f) => join(dir, f));
}

// Canonical form of a JSON value, so key order does not matter.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// Run a single-module chunk and return what the module exports.
function exportsOf(source) {
  const pushed = [];
  const context = { globalThis: { TURBOPACK: { push: (x) => pushed.push(x) } }, document: undefined, JSON };
  context.globalThis.globalThis = context.globalThis;
  vm.runInNewContext(source.replace(/^\(globalThis\.TURBOPACK\|\|\(globalThis\.TURBOPACK=\[\]\)\)/, 'globalThis.TURBOPACK'), context, { timeout: 1000 });
  const entry = pushed[0];
  const factory = entry?.find?.((x) => typeof x === 'function');
  if (!factory) return undefined;
  const mod = { exports: undefined };
  // The module object is passed in every position, since the argument it
  // is bound to is a bundler detail.
  factory(mod, mod, mod);
  return mod.exports;
}

const dataFiles = new Map();
for (const f of listFiles(dataDir, '.json')) {
  dataFiles.set(canonical(JSON.parse(readFileSync(f, 'utf8'))), relative(repoRoot, f));
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'app'), { recursive: true });
mkdirSync(join(outDir, 'data'), { recursive: true });

const matched = new Set();
let app = 0;
let data = 0;
for (const chunk of listFiles(chunksDir, '.js')) {
  const source = readFileSync(chunk, 'utf8');
  let file;
  if (SINGLE_JSON_MODULE.test(source) && (source.match(MODULE_HEADER) ?? []).length === 1) {
    try {
      file = dataFiles.get(canonical(exportsOf(source)));
    } catch {
      file = undefined;
    }
  }
  const name = relative(chunksDir, chunk).replaceAll('/', '__');
  if (file) {
    matched.add(file);
    copyFileSync(chunk, join(outDir, 'data', name));
    data++;
  } else {
    copyFileSync(chunk, join(outDir, 'app', name));
    app++;
  }
}

if (data === 0) {
  console.error(`split-size-chunks: no study-plan data chunks found in ${relative(repoRoot, chunksDir)}.`);
  console.error('The build output is not in the format this script reads (Turbopack production chunks),');
  console.error('or the build has not been run. Measuring everything as app code would hide the split.');
  process.exit(1);
}

// Files never loaded by template literal are bundled into the app instead
// (programs.json, cohorts/index.json, ...), so some files have no chunk of their
// own. Listed so a change in what is split is visible in the CI log.
const unchunked = [...dataFiles.values()].filter((f) => !matched.has(f)).map((f) => basename(f)).sort();
console.log(`split-size-chunks: ${app} app chunks, ${data} data chunks (${matched.size} src/data files).`);
console.log(`  no chunk of their own: ${unchunked.join(', ') || '—'}`);
