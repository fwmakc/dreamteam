// Отчёт по словарям i18n: TODO — значение en.ts/zh.ts совпадает с ru-значением
// (перевод не закрыт); STALE — ключи словарей, которых нет в коде (тот же
// harvest, что в check-i18n.mjs: вызовы t()/tf()/tr(), тернарники tr,
// title:/help: манифеста, поля схем карточек, квоты). Это отчёт, не проверка:
// exit 0 всегда. Запуск: node scripts/i18n-diff.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

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

const files = [...walk(join(root, 'src')), ...walk(join(root, 'gui-src'))];
const keys = new Set();
const re = /\b(?:t|tf|tr)\(\s*'((?:[^'\\]|\\.)*)'/g;
const tern = /\btr\(\s*[^()?]*?\?\s*'([^']+)'\s*:\s*'([^']+)'/g;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(re)) keys.add(m[1]);
  for (const m of s.matchAll(tern)) { keys.add(m[1]); keys.add(m[2]); }
}
// поля манифеста операций: t(op.title)/t(op.help) в рантайме — литералы тоже ключи
const opsSrc = readFileSync(join(root, 'src', 'core', 'operations.ts'), 'utf8');
for (const m of opsSrc.matchAll(/\b(?:title|help):\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
// схемы карточек: label/placeholder/desc, FIELD_TITLES, плейсхолдеры modelCardSchema
const schemaSrc = readFileSync(join(root, 'src', 'card-schema.ts'), 'utf8');
for (const m of schemaSrc.matchAll(/(?:label|placeholder|desc):\s*'((?:[^'\\\n]|\\.)*)'/g)) keys.add(m[1]);
const titlesBody = schemaSrc.match(/const FIELD_TITLES[^=]*= \{([\s\S]*?)\n\};/);
if (titlesBody) for (const m of titlesBody[1].matchAll(/: '((?:[^'\\\n]|\\.)*)'/g)) keys.add(m[1]);
for (const m of schemaSrc.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) keys.add(m[1]);
// квоты: значения QUOTA_LABELS в двух картах
for (const f of [join(root, 'src', 'ui.ts'), join(root, 'gui-src', 'App.vue')]) {
  const block = readFileSync(f, 'utf8').match(/const QUOTA_LABELS[^{]*\{[^}]*\}/);
  if (block) for (const m of block[0].matchAll(/'(QUOTA_[A-Z0-9]+)'/g)) keys.add(m[1]);
}

const { ru } = await import(pathToFileURL(join(root, 'src', 'locales', 'ru.ts')).href);
const { en } = await import(pathToFileURL(join(root, 'src', 'locales', 'en.ts')).href);
const { zh } = await import(pathToFileURL(join(root, 'src', 'locales', 'zh.ts')).href);

console.log(`code keys: ${keys.size}, ru: ${Object.keys(ru).length}, en: ${Object.keys(en).length}, zh: ${Object.keys(zh).length}`);

// TODO: значение локали == ru-значение — перевод не закрыт (Help-строки манифеста
// без перевода держат русское значение; совпадения-омонимы вида «Emoji» — норма)
for (const [name, dict] of [['en', en], ['zh', zh]]) {
  const todo = Object.entries(dict).filter(([k, v]) => v === ru[k]);
  console.log(`=== ${name} TODO (${todo.length}) — не переведено:`);
  for (const [k] of todo) console.log(`  ${k}: ${JSON.stringify(ru[k].slice(0, 80))}`);
}

// STALE: ключа нет в коде — кандидат на удаление (динамические вызовы уже
// собраны harvest'ом, сюда попадает только настоящее)
const stale = Object.keys(ru).filter((k) => !keys.has(k));
console.log(`=== STALE (${stale.length}) — нет в коде:`);
for (const k of stale) console.log('  ' + k);
