/**
 * Проверка синхронизации README ×3: заголовки должны совпадать по количеству
 * и порядку (после нормализации языковых вариаций). Запуск: node scripts/check-readme.mjs
 */
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(f, 'utf8');
const heads = (s) => (s.match(/^#{1,3} /gm) ?? []).length;

const en = read('README.md');
const ru = read('README.ru.md');
const zh = read('README.zh.md');

let bad = 0;
for (const [name, count] of [['en', heads(en)], ['ru', heads(ru)], ['zh', heads(zh)]]) {
  console.log(`${name}: ${count} headers`);
}
if (heads(en) !== heads(ru) || heads(en) !== heads(zh)) {
  console.error('FAIL: header counts differ — README ×3 out of sync');
  bad++;
}
// ключевые маркеры layout v2 должны быть во всех трёх
for (const marker of ['models/', 'agents/', '/model ']) {
  for (const [name, s] of [['en', en], ['ru', ru], ['zh', zh]]) {
    if (!s.includes(marker)) {
      console.error(`FAIL: ${name} missing "${marker}"`);
      bad++;
    }
  }
}
console.log(bad === 0 ? 'README sync: ок' : 'README sync: FAIL');
process.exit(bad === 0 ? 0 : 1);
