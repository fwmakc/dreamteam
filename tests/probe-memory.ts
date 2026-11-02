/**
 * Проба памяти команды (src/memory.ts): бюджеты в словах, ленивая рефлексия,
 * сборка блока памяти для промпта, ротация общего лога и слияния.
 *  - clampWords: нормализация пробелов, обрезка с «…»;
 *  - load/save TeamMemory: roundtrip, битый JSON, кривые записи;
 *  - appendChatToLog: обрезка и ротация LOG_LIMIT; needsGlobalMerge по версиям;
 *  - needsReflection: порог от последнего обновления;
 *  - memoryBlock: пустая память — пустая строка; имена коллег из ростера;
 *  - reflectSessionMemory/mergeOtherChats/mergeShared: mock-провайдер —
 *    деградация без LLM; стаб-провайдер — разбор JSON, бюджеты, промпт.
 *
 * Герметично: временная папка, LLM — стаб поверх MockProvider.
 * Запуск: npm run probe:memory
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, LLMProvider, Session, TeamMemory } from '../src/types.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const root = mkdtempSync(join(tmpdir(), 'dt-memory-'));
process.env.DT_HOME = root; // memory.ts сам по себе дом не читает — но импорты src могут

const gleb: Agent = { id: 'gleb', name: 'Глеб', emoji: '🧠', color: 'cyan', prompt: '' };
const mira: Agent = { id: 'mira', name: 'Мира', emoji: '🎨', color: 'magenta', prompt: '' };

/** Стаб LLM: выдаёт заготовленный текст, запоминает полученный запрос. */
function stubLLM(reply: string): { provider: LLMProvider; requests: { system?: string; user: string }[] } {
  const requests: { system?: string; user: string }[] = [];
  const provider: LLMProvider = {
    id: 'stub',
    kind: 'stub',
    model: 'stub-1',
    async *stream(req) {
      requests.push({ system: req.system, user: String(req.messages[0]?.content ?? '') });
      yield reply;
    },
  };
  return { provider, requests };
}

// ── 1. clampWords: бюджет в словах ───────────────────────────────────────────
{
  const { clampWords } = await import('../src/memory.js');
  check('слова: короткое возвращается как есть', clampWords('раз два три', 5) === 'раз два три');
  check('слова: пробелы нормализуются', clampWords('  раз   два\nтри\t ', 5) === 'раз два три');
  check('слова: обрезка с многоточием', clampWords('раз два три', 2) === 'раз два…');
  check('слова: ровно по лимиту — без многоточия', clampWords('раз два', 2) === 'раз два');
  check('слова: пустое — пустое', clampWords('   ', 5) === '' && clampWords('', 1) === '');
}

// ── 2. load/save TeamMemory ─────────────────────────────────────────────────
{
  const memoryMod = await import('../src/memory.js');
  const file = join(root, 'memory.json');

  check('память: нет файла — пустая', JSON.stringify(memoryMod.loadTeamMemory(file)) === '{"log":[],"logVersion":0,"agents":{}}');

  const memory: TeamMemory = {
    log: [{ title: 'разговор', digest: 'итог' }],
    logVersion: 4,
    shared: 'общая заметка',
    agents: { gleb: { otherChats: 'виделись в другом разговоре', seenVersion: 3 } },
  };
  memoryMod.saveTeamMemory(file, memory);
  const back = memoryMod.loadTeamMemory(file);
  check('память: roundtrip цел', back.logVersion === 4 && back.shared === 'общая заметка' && back.log[0].title === 'разговор' && back.agents.gleb?.seenVersion === 3, JSON.stringify(back));

  writeFileSync(file, '{ битый');
  check('память: битый JSON — пустая', JSON.stringify(memoryMod.loadTeamMemory(file)) === '{"log":[],"logVersion":0,"agents":{}}');

  writeFileSync(file, JSON.stringify({
    log: [{ title: 'ок', digest: 'с дайджестом' }, { title: 'без дайджеста' }, null, 'мусор'],
    logVersion: 'не число',
    shared: 42,
    agents: 'не объект',
  }));
  const cleaned = memoryMod.loadTeamMemory(file);
  check('память: кривые поля вычищены', cleaned.log.length === 1 && cleaned.log[0].title === 'ок' && cleaned.logVersion === 0 && cleaned.shared === undefined && JSON.stringify(cleaned.agents) === '{}', JSON.stringify(cleaned));
}

// ── 3. appendChatToLog: ротация; needsGlobalMerge: версии ───────────────────
{
  const { appendChatToLog, needsGlobalMerge, LOG_LIMIT } = await import('../src/memory.js');
  const memory: TeamMemory = { log: [], logVersion: 0, agents: {} };

  const longTitle = 'очень длинный заголовок разговора про проект и сроки';
  const longDigest = 'слово '.repeat(130).trim();
  for (let i = 1; i <= LOG_LIMIT + 1; i++) appendChatToLog(memory, `${longTitle} ${i}`, longDigest);

  check('лог: ротация держит лимит', memory.log.length === LOG_LIMIT, String(memory.log.length));
  check('лог: старейший вытеснен', memory.log[0].title.endsWith('2') && !memory.log.some((e) => e.title.endsWith('1')), memory.log[0].title);
  check('лог: заголовок и дайджест обрезаны', memory.log[0].title.split(' ').length <= 12 && memory.log[0].digest.split(' ').length <= 100 && memory.log[0].digest.endsWith('…'), memory.log[0].digest);
  check('лог: версия росла с каждым влитием', memory.logVersion === LOG_LIMIT + 1, String(memory.logVersion));

  check('слияние: пустой лог — не пора', !needsGlobalMerge({ log: [], logVersion: 5, agents: {} }, 'gleb'));
  check('слияние: агент не видел лог — пора', needsGlobalMerge({ log: memory.log, logVersion: 5, agents: {} }, 'gleb'));
  check('слияние: видел старую версию — пора', needsGlobalMerge(memory, 'gleb'));
  const seen: TeamMemory = { log: memory.log, logVersion: 7, agents: { gleb: { seenVersion: 7 } } };
  check('слияние: видел свежую версию — не пора', !needsGlobalMerge(seen, 'gleb'));
}

// ── 4. needsReflection: порог от последнего обновления ──────────────────────
{
  const { needsReflection, REFLECT_THRESHOLD } = await import('../src/memory.js');
  const session = (messages: number, updated?: number): Session =>
    ({ messages: Array.from({ length: messages }, (_, i) => i), memories: updated === undefined ? undefined : { gleb: { updatedAtMsg: updated } } }) as unknown as Session;

  check('рефлексия: пустой разговор — не пора', !needsReflection(session(0), 'gleb'));
  check('рефлексия: до порога — не пора', !needsReflection(session(REFLECT_THRESHOLD - 1), 'gleb'));
  check('рефлексия: порог достигнут — пора', needsReflection(session(REFLECT_THRESHOLD), 'gleb'));
  check('рефлексия: считается от последнего обновления', !needsReflection(session(20, 10), 'gleb') && needsReflection(session(22, 10), 'gleb'));
}

// ── 5. memoryBlock: сборка для системного промпта ───────────────────────────
{
  const { memoryBlock } = await import('../src/memory.js');
  const empty: TeamMemory = { log: [], logVersion: 0, agents: {} };
  const bare = { messages: [] } as unknown as Session;

  check('блок: пустая память — пустая строка', memoryBlock(gleb, bare, [gleb, mira], empty, 'Хозяин') === '');

  const full = memoryBlock(
    gleb,
    {
      messages: [],
      memories: {
        gleb: {
          updatedAtMsg: 1,
          task: 'свести схему',
          towardUser: 'уважаю',
          ties: { mira: 'рисует макеты', ghost: 'запасной' },
        },
      },
    } as unknown as Session,
    [gleb, mira],
    { log: [], logVersion: 0, shared: 'храним проект в repo', agents: { gleb: { otherChats: 'в другом разговоре выбрали стек' } } },
    'Хозяин',
  );
  const lines = full.split('\n');
  check('блок: задача, отношение, общее, чужие разговоры', lines[0] === '- Задача в этом разговоре: свести схему' && lines[1] === '- Отношение к Хозяин: уважаю' && lines[3] === '- Из других разговоров: в другом разговоре выбрали стек' && lines[4] === '- Общее у команды: храним проект в repo', JSON.stringify(lines));
  check('блок: коллеги по именам ростера, безымянный — по id', lines[2] === '- Коллеги: Мира — рисует макеты; ghost — запасной', lines[2]);

  const emptyTies = memoryBlock(gleb, { messages: [], memories: { gleb: { updatedAtMsg: 1, ties: { mira: '', ghost: '  ' } } } } as unknown as Session, [gleb, mira], empty, 'Хозяин');
  check('блок: пустые связи не попадают в текст', emptyTies === '');
}

// ── 6. reflectSessionMemory: mock и стаб LLM ────────────────────────────────
{
  const { reflectSessionMemory } = await import('../src/memory.js');
  const { MockProvider } = await import('../src/providers/mock.js');
  const mock = new MockProvider('mock');
  const dialog = [
    { authorId: 'user', authorName: 'Вы', text: 'привет', ts: 1 },
    { authorId: 'gleb', authorName: 'Глеб', text: 'приветствую', ts: 2 },
  ];

  const base = { task: 'была задача', towardUser: 'было отношение', ties: { mira: 'коллега' }, updatedAtMsg: 1 };
  const degraded = await reflectSessionMemory(gleb, base, dialog, 'Хозяин', [gleb, mira], mock);
  check('рефлексия: mock — память не тронута', degraded.task === 'была задача' && degraded.towardUser === 'было отношение' && degraded.ties?.mira === 'коллега', JSON.stringify(degraded));

  const json = JSON.stringify({
    task: 'новая задача ' + 'слово '.repeat(40).trim(), // > 30 слов — обрежется
    towardUser: '  ',
    ties: { mira: 'связь ' + 'слово '.repeat(25).trim(), kirk: 42, ghost: '  ' },
  });
  const { provider, requests } = stubLLM(`преамбула ${json} хвост`);
  const reflected = await reflectSessionMemory(gleb, base, dialog, 'Хозяин', [gleb, mira], provider);
  const taskWords = (reflected.task ?? '').replace('…', '').split(' ').length;
  check('рефлексия: JSON вытащен из текста, задача в бюджете', taskWords <= 30 && (reflected.task ?? '').endsWith('…'), reflected.task);
  check('рефлексия: пустое поле — откат к старому', reflected.towardUser === 'было отношение', reflected.towardUser);
  const tieWords = (reflected.ties?.mira ?? '').replace('…', '').split(' ').length;
  check('рефлексия: связи в бюджете, мусор отфильтрован', tieWords <= 20 && reflected.ties?.kirk === undefined && reflected.ties?.ghost === undefined, JSON.stringify(reflected.ties));
  check('рефлексия: в промпте ростер, память и диалог', requests[0] !== undefined
    && (requests[0].user.includes('Участники команды') && requests[0].user.includes('gleb — Глеб')
      && requests[0].user.includes('была задача')
      && requests[0].user.includes('Хозяин: привет') && requests[0].user.includes('Глеб: приветствую')), requests[0]?.user.slice(0, 200));

  const noJson = stubLLM('совсем не JSON');
  await reflectSessionMemory(gleb, base, dialog, 'Хозяин', [gleb, mira], noJson.provider)
    .then(() => check('рефлексия: без JSON — ошибка', false, 'не бросил'))
    .catch((e: unknown) => check('рефлексия: без JSON — ошибка', e instanceof Error && e.message.includes('нет JSON'), String(e)));
}

// ── 7. mergeOtherChats / mergeShared ────────────────────────────────────────
{
  const { mergeOtherChats, mergeShared } = await import('../src/memory.js');
  const { MockProvider } = await import('../src/providers/mock.js');
  const mock = new MockProvider('mock');

  const degraded = await mergeOtherChats('старое воспоминание', ['итог один', 'итог два'], mock);
  check('чужие: mock — склейка с бюджетом', degraded === `старое воспоминание итог один итог два`, degraded);
  const fromScratch = await mergeOtherChats(undefined, [], mock);
  check('чужие: mock без данных — пусто', fromScratch === '', fromScratch);

  const longEntry = 'слово '.repeat(70).trim();
  const merged = await mergeOtherChats(undefined, [longEntry], mock);
  check('чужие: бюджет 60 слов', merged.split(' ').length <= 61 && merged.endsWith('…'), merged.slice(0, 80));

  const { provider, requests } = stubLLM('мусор {"otherChats": " свежие новости "} мусор');
  const viaLLM = await mergeOtherChats('старое', ['итог'], provider);
  check('чужие: LLM — вытащено и очищено', viaLLM === 'свежие новости', viaLLM);
  check('чужие: в промпте текущее и итоги', requests[0]?.user.includes('Текущие воспоминания') && requests[0]?.user.includes('- итог'), requests[0]?.user);

  const noJson = stubLLM('бессвязно');
  await mergeOtherChats('старое', ['итог'], noJson.provider)
    .then(() => check('чужие: без JSON — ошибка', false, 'не бросил'))
    .catch((e: unknown) => check('чужие: без JSON — ошибка', e instanceof Error && e.message.includes('нет JSON'), String(e)));

  const sharedMock = await mergeShared(undefined, 'Проект', 'выбрали стек', mock);
  check('общее: mock — заголовок с дайджестом', sharedMock === '«Проект»: выбрали стек', sharedMock);
  const viaSharedLLM = await mergeShared('старое общее', 'Проект', 'выбрали стек', stubLLM('{"shared":"новое общее"}').provider);
  check('общее: LLM — вытащено', viaSharedLLM === 'новое общее', viaSharedLLM);
  const noShared = stubLLM('пусто');
  await mergeShared('старое', 'Проект', 'дайджест', noShared.provider)
    .then(() => check('общее: без JSON — ошибка', false, 'не бросил'))
    .catch((e: unknown) => check('общее: без JSON — ошибка', e instanceof Error && e.message.includes('нет JSON'), String(e)));
}

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
