/**
 * Проверка масок id сущностей (src/ids.ts): общая маска — цифра/буква в
 * начале, внутри дефис/подчёркивание/точка; точка не по краям и не двойная
 * (id живёт в именах файлов Windows). Ей подчиняются агенты, разговоры и
 * записи секретов проекта. Тулы и модели — строже: с буквы и минимум два
 * символа. Граничные случаи закрепляют фактическое поведение: сегмент после
 * точки может начинаться с дефиса/подчёркивания («a.-b» валиден), верхний
 * регистр и кириллица отвергаются везде.
 * Запуск: npm run probe:ids
 */
import { isAgentId, isModelId, isRecordId, isSessionId, isToolId } from '../src/ids.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ALNUM_GOOD = ['a', '1', 'a1', 'agent-1', 'a_b', 'qwen2.5-vl-7b', 'pdf.export', '20261027-143052', 'a.-b', 'a._b'];
const ALNUM_BAD = ['', 'A', 'A1', 'мир', '-a', '_a', '.a', 'a.', 'a..b', 'a b', 'a/b'];
const LETTER_GOOD = ['ab', 'trello', 'docs', 'a.b', 'a-b_c.d'];
const LETTER_BAD = ['', 'a', '1a', 'Ab', '.a', 'мир', 'a '];

/** Свертка маски со списками: всё «хорошее» принято, всё «плохое» отвергнуто. */
function sweep(name: string, mask: (id: string) => boolean, good: string[], bad: string[]): void {
  const wrong = [
    ...good.filter((s) => !mask(s)).map((s) => `«${s}» отвергнут`),
    ...bad.filter((s) => mask(s)).map((s) => `«${s}» принят`),
  ];
  check(name, wrong.length === 0, wrong.join(', '));
}

sweep('агент: общая маска', isAgentId, ALNUM_GOOD, ALNUM_BAD);
sweep('разговор: общая маска (штамп + суффикс)', isSessionId, ALNUM_GOOD, ALNUM_BAD);
sweep('запись секрета проекта: общая маска', isRecordId, ALNUM_GOOD, ALNUM_BAD);
sweep('тул: с буквы, ≥2 символов', isToolId, LETTER_GOOD, LETTER_BAD);
sweep('модель: с буквы, ≥2 символов', isModelId, LETTER_GOOD, LETTER_BAD);

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
