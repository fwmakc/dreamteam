/**
 * Проверка хелперов провайдеров (src/providers/utils.ts) и контракта ключа
 * (checkKeySpec из src/providers/types.ts) — всё герметично, без сети:
 *  - sseData: SSE-поток байт → data-нагрузки; чанки рвут строки посередине,
 *    CRLF, мультибайтовый UTF-8 через границу чанка, не-data строки мимо;
 *  - openAiDeltaText: текст из delta-чанка OpenAI; [DONE], мусор и
 *    reasoning-поля — пусто;
 *  - normalizeAlternating: склейка одинаковых ролей, system мимо, служебные
 *    края (пустая история, assistant первым/последним);
 *  - splitSystem: system из запроса + из истории складываются;
 *  - withTimeout: внешний сигнал и таймаут совместимы (ручной AbortController),
 *    предаборт срабатывает сразу, причина сохраняется;
 *  - num, sleep — тривиальные;
 *  - checkKeySpec: число/булево/объект/строка/enum, текст ошибки с именем.
 * Запуск: npm run probe:sse
 */
import { checkKeySpec, ConfigurationError, type ModelKeySpec } from '../src/providers/types.js';
import {
  normalizeAlternating,
  num,
  openAiDeltaText,
  sleep,
  splitSystem,
  sseData,
  withTimeout,
} from '../src/providers/utils.js';
import type { LLMMessage, StreamRequest } from '../src/types.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Кормит sseData строками/буферами как асинхронный поток байт. */
async function* feed(parts: (Uint8Array | Buffer | string)[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === 'string' ? Buffer.from(p, 'utf8') : p;
}
async function drain(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of gen) out.push(s);
  return out;
}
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

// --- sseData ══════════════════════════════════════════════════════════════════
{
  const basic = await drain(sseData(feed([buf('data: {"a":1}\n\n'), buf('data: [DONE]\n\n')])));
  check('sse: две data-нагрузки', JSON.stringify(basic) === JSON.stringify(['{"a":1}', '[DONE]']), JSON.stringify(basic));

  const torn = await drain(sseData(feed(['data: при', buf('вет\n\n'), 'data: [DONE]\n\n'])));
  check('sse: строка разорвана чанками, utf-8 цел', JSON.stringify(torn) === JSON.stringify(['привет', '[DONE]']), JSON.stringify(torn));

  const crlf = await drain(sseData(feed([buf('data: x\r\ndata: y\r\n')])));
  check('sse: CRLF обрезается', JSON.stringify(crlf) === JSON.stringify(['x', 'y']), JSON.stringify(crlf));

  const mixed = await drain(sseData(feed([buf('event: delta\ndata: y\n: коммент\ndata: z\n')])));
  check('sse: не-data строки мимо', JSON.stringify(mixed) === JSON.stringify(['y', 'z']), JSON.stringify(mixed));

  const nodata = await drain(sseData(feed([buf('просто текст без data:\n')])));
  check('sse: поток без data — пусто', nodata.length === 0, JSON.stringify(nodata));
}

// --- openAiDeltaText ══════════════════════════════════════════════════════════
{
  check('delta: текст контента', openAiDeltaText('{"choices":[{"delta":{"content":"прив"}}]}') === 'прив');
  check('delta: [DONE] — пусто', openAiDeltaText('[DONE]') === '');
  check('delta: мусор — пусто', openAiDeltaText('{oops') === '');
  check('delta: пустая строка — пусто', openAiDeltaText('') === '');
  check('delta: без choices — пусто', openAiDeltaText('{"usage":{}}') === '');
  check(
    'delta: reasoning_content игнорируется',
    openAiDeltaText('{"choices":[{"delta":{"reasoning_content":"думаю"}}]}') === '',
  );
}

// --- normalizeAlternating ═════════════════════════════════════════════════════
{
  const merged = normalizeAlternating([
    { role: 'system', content: 'ты робот' },
    { role: 'user', content: 'раз' },
    { role: 'user', content: 'два' },
    { role: 'assistant', content: 'ответ' },
  ]);
  check(
    'alternating: склейка user+user, system мимо, хвост «Продолжай.»',
    JSON.stringify(merged) === JSON.stringify([{ role: 'user', content: 'раз\n\nдва' }, { role: 'assistant', content: 'ответ' }, { role: 'user', content: 'Продолжай.' }]),
    JSON.stringify(merged),
  );

  const empty = normalizeAlternating([]);
  check(
    'alternating: пустая — служебный вопрос',
    empty.length === 1 && empty[0].role === 'user' && empty[0].content === 'Ответь на сообщение.',
    JSON.stringify(empty),
  );

  const assistantFirst = normalizeAlternating([{ role: 'assistant', content: 'а' }]);
  check(
    'alternating: assistant первым — края с двух сторон',
    assistantFirst.length === 3
      && assistantFirst[0].role === 'user' && assistantFirst[0].content === '(начало беседы)'
      && assistantFirst[2].content === 'Продолжай.',
    JSON.stringify(assistantFirst),
  );

  const assistantLast = normalizeAlternating([{ role: 'user', content: 'у' }, { role: 'assistant', content: 'а' }]);
  check(
    'alternating: assistant последним — Продолжай.',
    assistantLast[2].role === 'user' && assistantLast[2].content === 'Продолжай.',
    JSON.stringify(assistantLast),
  );

  const source: LLMMessage[] = [{ role: 'user', content: 'оригинал' }];
  normalizeAlternating(source);
  check('alternating: вход не мутирует', source.length === 1 && source[0].content === 'оригинал');
}

// --- splitSystem ══════════════════════════════════════════════════════════════
{
  const req: StreamRequest = {
    system: 'база',
    messages: [
      { role: 'system', content: 'надстройка' },
      { role: 'user', content: 'вопрос' },
    ],
  };
  const { system, messages } = splitSystem(req);
  check('splitSystem: система сложена через пустую строку', system === 'база\n\nнадстройка', String(system));
  check('splitSystem: история без system', JSON.stringify(messages) === JSON.stringify([{ role: 'user', content: 'вопрос' }]), JSON.stringify(messages));

  const bare = splitSystem({ messages: [{ role: 'user', content: 'привет' }] });
  check('splitSystem: без системы — undefined', bare.system === undefined && bare.messages.length === 1);
}

// --- withTimeout ══════════════════════════════════════════════════════════════
{
  const t30 = withTimeout(undefined, 30);
  check('timeout: сразу жив', !t30.aborted);
  await sleep(80);
  check('timeout: истёк — aborted', t30.aborted);

  const external = new AbortController();
  const combined = withTimeout(external.signal, 60_000);
  external.abort(new Error(' Esc'));
  check('timeout: внешний аборт гасит совмещённый', combined.aborted);
  check('timeout: причина внешнего сохранена', (combined.reason as Error)?.message === ' Esc');

  const pre = new AbortController();
  pre.abort();
  check('timeout: предаборт — сразу aborted', withTimeout(pre.signal, 60_000).aborted);

  // таймаут короче внешнего: совмещённый гаснет от таймера
  const slow = new AbortController();
  const t = withTimeout(slow.signal, 20);
  await sleep(60);
  check('timeout: таймер гасит, пока внешний жив', t.aborted && !slow.signal.aborted);
}

// --- num / sleep ══════════════════════════════════════════════════════════════
{
  check('num: число', num(5) === 5);
  check('num: NaN — undefined', num(Number.NaN) === undefined);
  check('num: Infinity — undefined', num(Number.POSITIVE_INFINITY) === undefined);
  check('num: строка — undefined', num('5') === undefined);
  check('num: null — undefined', num(null) === undefined);
  const t0 = Date.now();
  await sleep(25);
  check('sleep: ждёт не меньше', Date.now() - t0 >= 20, String(Date.now() - t0));
}

// --- checkKeySpec ═════════════════════════════════════════════════════════════
{
  const cases: Array<[string, ModelKeySpec, unknown, boolean]> = [
    ['число: цело', { type: 'number' }, 5, true],
    ['число: строка — ошибка', { type: 'number' }, '5', false],
    ['число: NaN — ошибка', { type: 'number' }, Number.NaN, false],
    ['булево: true', { type: 'boolean' }, true, true],
    ['булево: «true» строкой — ошибка', { type: 'boolean' }, 'true', false],
    ['объект: словарь', { type: 'object' }, { a: 1 }, true],
    ['объект: массив — ошибка', { type: 'object' }, [1], false],
    ['объект: null — ошибка', { type: 'object' }, null, false],
    ['строка: текст', { type: 'string' }, 'x', true],
    ['строка: число — ошибка', { type: 'string' }, 1, false],
    ['enum: из списка', { type: 'string', enum: ['enabled', 'disabled'] }, 'enabled', true],
    ['enum: мимо списка — ошибка', { type: 'string', enum: ['enabled'] }, 'nope', false],
  ];
  for (const [name, spec, value, ok] of cases) {
    const err = checkKeySpec('поле', spec, value);
    check(`keySpec: ${name}`, ok ? err === null : typeof err === 'string', String(err));
  }
  const enumErr = checkKeySpec('thinking', { type: 'string', enum: ['enabled'] }, 'nope');
  check('keySpec: ошибка enum называет варианты', (enumErr ?? '').includes('enabled'), enumErr ?? '');
  check('keySpec: ConfigurationError — Error', new ConfigurationError('x') instanceof Error);
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
