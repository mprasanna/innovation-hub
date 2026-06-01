#!/usr/bin/env node
/**
 * preflight.js — catch the two failure modes that ship blank pages:
 *   1. Stray quadruple-brace JSX bugs:  style={{{{ ... }}}}
 *   2. Babel/JSX syntax errors in inline <script type="text/babel"> blocks and .jsx files
 *   3. Referenced-but-missing assets (.jsx / .js / .css that 404 on deploy)
 *
 * Usage:
 *   node preflight.js                 # scan current dir
 *   node preflight.js ./innovation-hub
 *   node preflight.js . --base=/innovation-hub   # how absolute "/innovation-hub/x" maps to disk
 *
 * Exit code: 0 = clean, 1 = errors found (use in CI / pre-commit / pre-deploy).
 *
 * Babel compile-checking is optional. If @babel/standalone is installed it runs;
 * if not, the script still performs the (dependency-free) brace + missing-asset
 * checks, which catch the highest-impact bugs. To enable compile-checking:
 *     npm i -D @babel/standalone @babel/preset-react
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || '.');
const baseArg = (args.find(a => a.startsWith('--base=')) || '').split('=')[1] || '';
const BASE = baseArg.replace(/^\/|\/$/g, ''); // e.g. "innovation-hub"

// Optional Babel
let babel = null;
try { babel = require('@babel/standalone'); } catch (_) {}

const C = { red:'\x1b[31m', yel:'\x1b[33m', grn:'\x1b[32m', dim:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
let errors = 0, warns = 0, scanned = 0;

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p, acc) : acc.push(p);
  }
  return acc;
}

const lineAt = (s, i) => s.slice(0, i).split('\n').length;

function compile(code, offsetLine) {
  if (!babel) return null;
  try { babel.transform(code, { presets: ['react'], filename: 'x.jsx' }); return null; }
  catch (e) {
    const m = /\((\d+):(\d+)\)/.exec(e.message);
    const ln = m ? (+m[1] + (offsetLine || 0)) : '?';
    return { msg: e.message.split('\n')[0], line: ln };
  }
}

const allFiles = walk(ROOT);
const present = new Set(allFiles.map(f => path.relative(ROOT, f).split(path.sep).join('/')));
const byBasename = new Map();
for (const p of present) {
  const b = p.split('/').pop();
  if (!byBasename.has(b)) byBasename.set(b, []);
  byBasename.get(b).push(p);
}

function resolveAsset(url, htmlRel) {
  // strip query/hash
  url = url.replace(/[?#].*$/, '');
  const flat = url.split('/').pop();
  const candidates = [];
  if (url.startsWith('/')) {
    let u = url.replace(/^\//, '');
    if (BASE && u.startsWith(BASE + '/')) u = u.slice(BASE.length + 1);
    candidates.push(u);
  } else {
    candidates.push(path.posix.normalize(path.posix.join(path.posix.dirname(htmlRel), url)));
  }
  candidates.push(url.replace(/^\//, ''));
  for (const c of candidates) if (present.has(c)) return true;
  // last-resort: same basename anywhere under root
  return byBasename.has(flat);
}

function report(file, list) {
  if (!list.length) return;
  console.log(`\n${C.b}■ ${file}${C.x}`);
  for (const it of list) {
    const tag = it.level === 'warn' ? `${C.yel}⚠${C.x}` : `${C.red}✗${C.x}`;
    console.log(`  ${tag} ${it.text}`);
    it.level === 'warn' ? warns++ : errors++;
  }
}

// Real bug signature: a JSX attribute given a quadruple-open brace, e.g. style={{{{ ... }}}}
// Keyed on `={{{{` so it does NOT false-positive on minified JS, where runs of `}}}}` are valid.
const BRACE = /=\s*\{\{\{\{/g;

for (const f of allFiles) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const ext = path.extname(f);

  if (ext === '.html') {
    scanned++;
    const src = fs.readFileSync(f, 'utf8');
    const issues = [];

    // 1. stray quadruple braces
    let m;
    while ((m = BRACE.exec(src))) issues.push({ level:'err', text:`JSX quadruple-brace bug ('${m[0].trim()}') at line ${lineAt(src, m.index)}` });

    // 2. compile inline text/babel blocks (skip ones with src=, those are external files)
    const reInline = /<script[^>]*type=["']text\/babel["'](?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let b, n = 0;
    while ((b = reInline.exec(src))) {
      n++;
      const off = lineAt(src, b.index) - 1;
      const r = compile(b[1], off);
      if (r) issues.push({ level:'err', text:`inline babel block #${n}: ${r.msg} (line ~${r.line})` });
    }

    // 3. referenced assets present?
    const reRef = /(?:src|href)=["']([^"']+)["']/g;
    let r;
    while ((r = reRef.exec(src))) {
      const u = r[1];
      if (/^(https?:|data:|mailto:|#|\/\/)/.test(u)) continue;
      if (!/\.(jsx?|mjs|css)$/.test(u)) continue;
      if (!resolveAsset(u, rel)) issues.push({ level:'err', text:`references missing asset: ${u}` });
    }
    report(rel, issues);
  }

  else if (/\.(jsx|mjs)$/.test(ext) || (ext === '.js' && babel)) {
    scanned++;
    const src = fs.readFileSync(f, 'utf8');
    const issues = [];
    let m;
    while ((m = BRACE.exec(src))) issues.push({ level:'err', text:`JSX quadruple-brace bug at line ${lineAt(src, m.index)}` });
    const r = compile(src, 0);
    if (r) issues.push({ level:'err', text:`${r.msg} (line ~${r.line})` });
    report(rel, issues);
  }
}

console.log(`\n${'='.repeat(52)}`);
if (!babel) console.log(`${C.yel}note:${C.x} @babel/standalone not installed — compile-checking skipped (brace + missing-asset checks still ran). Run: npm i -D @babel/standalone @babel/preset-react`);
const color = errors ? C.red : (warns ? C.yel : C.grn);
console.log(`${color}${C.b}RESULT: ${errors} error(s), ${warns} warning(s)${C.x} across ${scanned} file(s) scanned.`);
process.exit(errors ? 1 : 0);
