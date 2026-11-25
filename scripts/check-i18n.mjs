/**
 * Проверка словарей i18n: ключи вызовов t()/tf()/tr(), литералы манифеста
 * операций (title:/help:), схем карточек (label/placeholder/desc, FIELD_TITLES,
 * плейсхолдеры, квоты) обязаны быть ключами во всех трёх словарях ru/en/zh —
 * и наоборот. Плюс гард формата ключа ^[A-Z0-9_]+$ и гард «/команда в
 * значении — только известная операция» (протёкший «Синтаксис: /team» роняет
 * проверку). Запуск: node scripts/check-i18n.mjs (ненулевой код — провал).
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

// манифест операций: title:/help: едут в рантайм через t(op.title) — литералы тоже ключи
const opsSrc = readFileSync(join(root, 'src', 'core', 'operations.ts'), 'utf8');
for (const m of opsSrc.matchAll(/\b(?:title|help):\s*'((?:[^'\\\n]|\\.)*)'/g)) raws.add(m[1]);

// схемы карточек: метки/подсказки/описания полей едут в GUI динамически (tr(f.label))
const schemaSrc = readFileSync(join(root, 'src', 'card-schema.ts'), 'utf8');
for (const m of schemaSrc.matchAll(/(?:label|placeholder|desc):\s*'((?:[^'\\\n]|\\.)*)'/g)) raws.add(m[1]);
// FIELD_TITLES — карта «поле → метка», значения становятся метками
const titlesBody = schemaSrc.match(/const FIELD_TITLES[^=]*= \{([\s\S]*?)\n\};/);
if (titlesBody) for (const m of titlesBody[1].matchAll(/: '((?:[^'\\\n]|\\.)*)'/g)) raws.add(m[1]);
// голые ключи-плейсхолдеры modelCardSchema (EMPTY_KEEP_UNCHANGED, REQUIRED…)
for (const m of schemaSrc.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) raws.add(m[1]);

// квоты: значения QUOTA_LABELS в двух картах (ui.ts и App.vue) — ключи словаря
for (const f of [join(root, 'src', 'ui.ts'), join(root, 'gui-src', 'App.vue')]) {
  const block = readFileSync(f, 'utf8').match(/const QUOTA_LABELS[^{]*\{[^}]*\}/);
  if (block) for (const m of block[0].matchAll(/'(QUOTA_[A-Z0-9]+)'/g)) raws.add(m[1]);
}

const { ru } = await import(pathToFileURL(join(root, 'src', 'locales', 'ru.ts')).href);
const { en } = await import(pathToFileURL(join(root, 'src', 'locales', 'en.ts')).href);
const { zh } = await import(pathToFileURL(join(root, 'src', 'locales', 'zh.ts')).href);

// ── guard грамматики: /xxx в значении словаря — только известная команда ─────
// Имена — из манифеста операций (первый сегмент: /agent tool add → 'agent'),
// особые команды вне манифеста — явно; пути и не-команды — белый список.
// плюс не-команды: v1/n — пути и «Y/n» в примерах; api — хост в
// https://api.openai.com/v1; cyan — список цветов в подписи поля; lang —
// папка ~/.dreamteam/lang в подсказке визарда; v4/paas/coding/anthropic —
// пути в адресах API (z.ai, anthropic); srv/data/report — путь-пример
// «/srv/data/report.pdf».
// Слипшиеся списки «model/vision/image» менюшек не считаются командами:
// токен — только слэш на границе слова (после пробела, «(» или «„«»).
const known = new Set(['help', 'exit', 'quit', 'q', 'v1', 'n', 'api', 'cyan', 'lang', 'v4', 'paas', 'coding', 'anthropic', 'srv', 'data', 'report']);
for (const m of opsSrc.matchAll(/\bname: '([a-z][a-z0-9.]*)'/g)) known.add(m[1].split('.')[0]);
const token = /(?:^|[\s(«])\/([a-z][a-z0-9-]*)/g;

const KEY_RE = /^[A-Z0-9_]+$/;
let bad = 0;
for (const [name, dict] of [['ru', ru], ['en', en], ['zh', zh]]) {
  const format = Object.keys(dict).filter((k) => !KEY_RE.test(k));
  if (format.length) {
    bad++;
    console.log(`${name}: ключи не в формате ^[A-Z0-9_]+$ (${format.length}):`);
    for (const k of format) console.log('  ' + JSON.stringify(k));
  }
  const miss = [...raws].filter((r) => !(r in dict));
  if (miss.length) {
    bad++;
    console.log(`${name}: нет ключей (${miss.length}):`);
    for (const k of miss) console.log('  ' + JSON.stringify(k));
  }
  const strangers = new Map();
  for (const v of Object.values(dict)) {
    for (const m of v.matchAll(token)) {
      if (!known.has(m[1])) strangers.set(m[1], (strangers.get(m[1]) ?? 0) + 1);
    }
  }
  if (strangers.size) {
    bad++;
    console.log(`${name}: неизвестные команды (${strangers.size}):`);
    for (const [tk, n] of [...strangers.entries()].sort()) console.log(`  /${tk} ×${n}`);
  }
  const extra = Object.keys(dict).filter((k) => !raws.has(k));
  if (extra.length) {
    console.log(`${name}: возможно лишние (${extra.length}) — проверь вручную`);
    for (const k of extra) console.log('  ' + k);
  }
}

// ── чётность: ключи en/zh обязаны совпадать с ru (исходник) ──────────────────
for (const [name, dict] of [['en', en], ['zh', zh]]) {
  const onlyRu = Object.keys(ru).filter((k) => !(k in dict));
  const onlyX = Object.keys(dict).filter((k) => !(k in ru));
  if (onlyRu.length || onlyX.length) {
    bad++;
    console.log(`${name}: рассинхрон ключей с ru (только в ru: ${onlyRu.length}, только в ${name}: ${onlyX.length}):`);
    for (const k of onlyRu) console.log(`  ru>${name}: ${k}`);
    for (const k of onlyX) console.log(`  ${name}>ru: ${k}`);
  }
}
console.log(bad === 0 ? 'i18n: ок' : 'i18n: есть пропуски');
process.exit(bad === 0 ? 0 : 1);
