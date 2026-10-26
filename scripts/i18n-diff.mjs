// Разовая сверка: русские ключи t()/tf()/tr() в коде против словаря en.ts.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'locales', 'gui-dist'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|vue)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [...walk('src'), ...walk('gui-src')];
const keys = new Set();
const re = /\b(?:t|tf|tr)\(\s*'((?:[^'\\]|\\.)*)'/g;
// поля манифеста операций: t(op.title)/t(op.help) в рантайме — литералы тоже ключи
const reField = /\b(?:title|help):\s*'((?:[^'\\]|\\.)*)'/g;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(s))) keys.add(m[1]);
  while ((m = reField.exec(s))) keys.add(m[1]);
}
const enSrc = readFileSync('src/locales/en.ts', 'utf8');
const enKeys = new Set([...enSrc.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1]));
const missing = [...keys].filter((k) => !enKeys.has(k)).sort();
const stale = [...enKeys].filter((k) => !keys.has(k)).sort();
// «мёртвый» = текста нет нигде в коде; иначе ключ жив, просто regex не взял
// (тернарник, динамический вызов) — такие не удалять.
const dead = [];
const aliveElsewhere = [];
for (const k of stale) {
  const needle = k.replace(/\\n/g, '\n');
  const found = files.some((f) => readFileSync(f, 'utf8').includes(needle));
  (found ? aliveElsewhere : dead).push(k);
}
console.log(`code keys: ${keys.size}, en keys: ${enKeys.size}`);
console.log(`=== MISSING (${missing.length}):`);
for (const k of missing) console.log(JSON.stringify(k));
console.log(`=== STALE-DEAD (${dead.length}):`);
for (const k of dead) console.log(JSON.stringify(k));
console.log(`=== STALE-LIVE-ELSEWHERE (${aliveElsewhere.length}) — не удалять:`);
for (const k of aliveElsewhere) console.log(JSON.stringify(k));
