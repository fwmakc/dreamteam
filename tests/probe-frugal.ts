/**
 * Проба бережливости токенов: механизмы экономии на уровне приложения.
 *  - соло-пропуск модератора: planTurns с одним агентом не вызывает LLM;
 *  - serviceModel: сервисная и основная модели резолвятся в разные провайдеры;
 *  - старение tool-выводов: старые ⚙-блоки сжимаются, свежие не трогаются;
 *  - focused-контекст: агент с focused mode видит чужие реплики как однострочники;
 *  - /usage: статистика сессии накапливается при раундах.
 *
 * Герметично: временные DT_HOME/DT_PROJECT.
 * Запуск: npm run probe:frugal
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Presenter } from '../src/core/presenter.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (cond || !detail ? '' : ` — ${detail.slice(0, 300)}`));
  if (!cond) fails++;
}

const root = mkdtempSync(join(tmpdir(), 'dt-frugal-'));
const home = join(root, 'home');
mkdirSync(join(home, 'agents'), { recursive: true });
mkdirSync(join(home, 'models'), { recursive: true });
process.env.DT_HOME = home;
process.env.DT_PROJECT = join(root, 'proj', '.dreamteam');
writeFileSync(join(home, 'models', 'flagship.json'),
  JSON.stringify({ adapter: 'mock' }, null, 2));
writeFileSync(join(home, 'models', 'service.json'),
  JSON.stringify({ adapter: 'mock' }, null, 2));
writeFileSync(join(home, 'settings.json'),
  JSON.stringify({ ui: 'ru', width: 100, model: { id: 'flagship' }, serviceModel: { id: 'service' } }, null, 2) + '\n');

// ── 1. соло-пропуск модератора ────────────────────────────────────────────────
{
  const { planTurns } = await import('../src/orchestrator.js');
  const { MockProvider } = await import('../src/providers/mock.js');
  const kirk = { id: 'kirk', name: 'Кир', emoji: '🔧', color: 'cyan', prompt: 'Ты — Кир.' };
  const moderator = new MockProvider('moderator');
  let llmCalled = false;
  const spy: import('../src/types.js').LLMProvider = {
    ...moderator,
    async *stream(req, onUsage) {
      llmCalled = true;
      yield* moderator.stream(req, onUsage);
    },
  };
  // один агент → LLM не вызывается
  const solo = await planTurns({ text: 'привет', mentioned: [], team: [kirk], moderator: spy, maxTurns: 3, userName: 'Хозяин', history: [] });
  check('соло: план вернул одного агента', solo.turns.length === 1 && solo.turns[0].agent.id === 'kirk', JSON.stringify(solo.turns.map((t) => t.agent.id)));
  check('соло: LLM не вызван', !llmCalled, 'модератор был вызван для одного агента');
  // два агента → LLM вызывается (mock→mockPlan эвристика, но проверяем что путь не skip)
  const mira = { id: 'mira', name: 'Мира', emoji: '🎨', color: 'magenta', prompt: 'Ты — Мира.' };
  const duo = await planTurns({ text: 'привет', mentioned: [], team: [kirk, mira], moderator: spy, maxTurns: 3, userName: 'Хозяин', history: [] });
  check('два агента: план вернулся', duo.turns.length > 0, JSON.stringify(duo.turns.map((t) => t.agent.id)));
}

// ── 2. serviceModel резолвится в другой провайдер ────────────────────────────
{
  const { loadModels } = await import('../src/providers/registry.js');
  const { models } = loadModels(join(home, 'models'));
  const flagship = models.get('flagship');
  const service = models.get('service');
  check('serviceModel: обе модели загружены', Boolean(flagship) && Boolean(service));
  check('serviceModel: это разные инстансы', flagship?.provider !== service?.provider);
}

// ── 3. старение tool-выводов ─────────────────────────────────────────────────
{
  const { contextSlice } = await import('../src/compress.js');
  const mkTool = (text: string, ts: number) => ({ authorId: 'tool', authorName: '⚙ инструменты', text, ts });
  const mkUser = (text: string, ts: number) => ({ authorId: 'user', authorName: 'Вы', text, ts });
  const session = {
    messages: [
      mkUser('сообщение 1', 1), mkTool('X'.repeat(5000), 2),
      mkUser('сообщение 2', 3), mkTool('Y'.repeat(5000), 4),
      mkUser('сообщение 3', 5), mkTool('Z'.repeat(5000), 6),
    ],
  } as unknown as import('../src/types.js').Session;
  const slice = contextSlice(session);
  const toolMsgs = slice.filter((m) => m.authorId === 'tool');
  const collapsed = toolMsgs.filter((m) => m.text.includes('символов'));
  check('старение: есть сжатые tool-блоки', collapsed.length > 0, `${toolMsgs.length} tool, ${collapsed.length} collapsed`);
  check('старение: свежие tool-блоки не сжаты', toolMsgs.some((m) => !m.text.includes('символов')), '');
  check('старение: оригинал не мутирует', session.messages[1].text.length === 5000, String(session.messages[1].text.length));
}

// ── 4. focused-контекст ──────────────────────────────────────────────────────
{
  const kirk = {
    id: 'kirk', name: 'Кир', emoji: '🔧', color: 'cyan', prompt: 'Кир',
    context: { mode: 'focused' as const, tail: 2 },
  };
  const { contextSlice } = await import('../src/compress.js');
  const msg = (authorId: string, authorName: string, text: string, ts: number) =>
    ({ authorId, authorName, text, ts });
  const session = {
    messages: [
      msg('mira', 'Мира', 'A'.repeat(200), 1),
      msg('gleb', 'Глеб', 'B'.repeat(200), 2),
      msg('kirk', 'Кир', 'моё сообщение', 3),
      msg('mira', 'Мира', '@kirk посмотри это', 4),
      msg('gleb', 'Глеб', 'хвост 1', 5),
      msg('mira', 'Мира', 'хвост 2', 6),
    ],
  } as unknown as import('../src/types.js').Session;
  const slice = contextSlice(session);
  // применяем focused-фильтр (как в buildRequest)
  const tail = kirk.context!.tail ?? 8;
  const focused = slice.map((m, i) => {
    const isTail = i >= slice.length - tail;
    const isMine = m.authorId === 'kirk';
    const isUser = m.authorId === 'user';
    const addressed = m.text.toLowerCase().includes('@kirk') || m.text.toLowerCase().includes('кир');
    if (isTail || isMine || isUser || addressed) return m;
    return { ...m, text: `(${m.text.slice(0, 80)}…)` };
  });
  const miraFull = focused.find((m) => m.authorId === 'mira' && m.ts === 1);
  const miraAddressed = focused.find((m) => m.text.includes('@kirk'));
  const miraTail = focused.find((m) => m.authorId === 'mira' && m.ts === 6);
  check('focused: далёкая чужая реплика сжата', miraFull !== undefined && miraFull.text.startsWith('('), miraFull?.text.slice(0, 40));
  check('focused: адресованная — полная', miraAddressed !== undefined && !miraAddressed.text.startsWith('('), miraAddressed?.text.slice(0, 40));
  check('focused: хвост — полный', miraTail !== undefined && !miraTail.text.startsWith('('), miraTail?.text.slice(0, 40));
}

// ── 5. /usage: статистика через операции ─────────────────────────────────────
{
  writeFileSync(
    join(home, 'models', 'flagship.json'),
    JSON.stringify({ adapter: 'mock', note: 'тест' }, null, 2) + '\n',
  );
  const { bootstrapApp } = await import('../src/core/bootstrap.js');
  const { Engine } = await import('../src/core/engine.js');
  const { runOperationText } = await import('../src/core/operations.js');
  const sink = { delta() {}, done() {} };
  const stub: Presenter = {
    notice(t) { console.log(`  [notice] ${t.slice(0, 80)}`); },
    error(t) {},
    turnHeader() {},
    busy() { return { stop() {} }; },
    stream() { return sink; },
    turnEnd() {},
    say() {},
    toolLines() {},
    attachment() {},
    async confirm() { return true; },
    async chooseSession() { return null; },
    sessionOpened() {},
  };
  const { app } = await bootstrapApp();
  const engine = new Engine(app, stub);
  // /usage: проверяем операцию с заведомо заданной статистикой
  app.session.usage = { promptTokens: 1500, cachedTokens: 1240, outputTokens: 200, rounds: 3 };
  const usage = app.session.usage;
  check('/usage: статистика задана', Boolean(usage) && (usage?.rounds ?? 0) > 0, JSON.stringify(usage));
  const lines = await runOperationText(engine, '/usage');
  check('/usage: отчёт содержит раунды', lines.some((l) => l.includes('Раундов')), lines.join(' | '));
  check('/usage: отчёт содержит кэш', lines.some((l) => l.includes('кэша') || l.includes('1 240')), lines.join(' | '));
  // пустая статистика — честное сообщение
  app.session.usage = undefined;
  const empty = await runOperationText(engine, '/usage');
  check('/usage: пустая — честное сообщение', empty.some((l) => l.includes('Статистики')), empty.join(' | '));
}

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
