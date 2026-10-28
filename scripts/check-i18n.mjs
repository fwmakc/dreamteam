/**
 * Проверка словарей i18n: каждый ключ вызова t()/tf()/tr() в коде должен
 * быть в en.ts и zh.ts (и наоборот — без лишних). Запуск: node scripts/check-i18n.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = [];
function walk(dir) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'gui-dist' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|vue|js)$/.test(n)) files.push(p);
  }
}
walk(join(root, 'src'));
walk(join(root, 'gui-src'));
walk(join(root, 'tests'));
// probe-i18n намеренно проверяет отсутствующий ключ — из harvest его исключаем
files.splice(files.findIndex((f) => f.includes('probe-i18n')), 1);

const raws = new Set();
const call = /(?:^|[^.\w])(?:t|tf|tr)\(\s*'((?:[^'\\\n]|\\.)*)'/g;
const ternary = /\btr\(\s*[^()?]*?\?\s*'([^']+)'\s*:\s*'([^']+)'/g;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(call)) raws.add(m[1]);
  for (const m of s.matchAll(ternary)) {
    raws.add(m[1]);
    raws.add(m[2]);
  }
}
// метки и подсказки полей схем карточек едут в GUI динамически (tr(f.label)) —
// собираем их из card-schema.ts отдельно
const schemaSrc = readFileSync(join(root, 'src', 'card-schema.ts'), 'utf8');
for (const m of schemaSrc.matchAll(/(?:label|placeholder): '((?:[^'\\\n]|\\.)*)'/g)) raws.add(m[1]);
const decode = (r) => JSON.parse('"' + r.replace(/(?<!\\)"/g, String.fromCharCode(92) + '"') + '"');

const { en } = await import(pathToFileURL(join(root, 'src', 'locales', 'en.ts')).href);
const { zh } = await import(pathToFileURL(join(root, 'src', 'locales', 'zh.ts')).href);

// ── guard грамматики: /xxx в ключе словаря — только известная команда ────────
// Имена — из манифеста операций (первый сегмент: /agent tool add → 'agent'),
// особые команды вне манифеста — явно; пути и не-команды ('/v1', 'Y/n') —
// белый список. Протёкший «Синтаксис: /team» отныне роняет проверку.
const opsSrc = readFileSync(join(root, 'src', 'core', 'operations.ts'), 'utf8');
// плюс не-команды: v1/n — пути и «Y/n» в примерах; api — хост в
// https://api.openai.com/v1; cyan — список цветов в подписи поля; lang —
// папка ~/.dreamteam/lang в подсказке визарда.
const known = new Set(['help', 'exit', 'quit', 'q', 'v1', 'n', 'api', 'cyan', 'lang']);
for (const m of opsSrc.matchAll(/\bname: '([a-z][a-z0-9.]*)'/g)) known.add(m[1].split('.')[0]);
const token = /\/([a-z][a-z0-9-]*)/g;

let bad = 0;
for (const [name, dict] of [['en', en], ['zh', zh]]) {
  const miss = [...raws].filter((r) => !(decode(r) in dict));
  const extra = Object.keys(dict).filter((k) => !raws.has(k) && !k.startsWith('  ') && !k.includes('\n'));
  const strangers = new Map();
  for (const k of Object.keys(dict)) {
    for (const m of k.matchAll(token)) {
      if (!known.has(m[1])) strangers.set(m[1], (strangers.get(m[1]) ?? 0) + 1);
    }
  }
  if (miss.length) {
    bad++;
    console.log(`${loc(name)}: нет ключей (${miss.length}):`);
    for (const k of miss) console.log('  ' + JSON.stringify(k));
  }
  if (strangers.size) {
    bad++;
    console.log(`${loc(name)}: неизвестные команды (${strangers.size}):`);
    for (const [tk, n] of [...strangers.entries()].sort()) console.log(`  /${tk} ×${n}`);
  }
  if (extra.length) {
    console.log(`${loc(name)}: возможно лишние (${extra.length}) — проверь вручную`);
  }
}
console.log(bad === 0 ? 'i18n: ок' : 'i18n: есть пропуски');
process.exit(bad === 0 ? 0 : 1);

function loc(l) {
  return l;
}
