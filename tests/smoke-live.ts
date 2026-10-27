/**
 * Боевой дым: проверка на НАСТОЯЩЕМ LLM-провайдере (не mock). Запускается
 * руками — в герметичную probe-сюиту боевые запросы не включаем (деньги,
 * квоты, недетерминизм).
 *
 *   npm run smoke:live
 *
 * Требования:
 *  - в доме ~/.dreamteam/models/ есть боевая карточка модели — настоящий
 *    адаптер (не «mock») с ключом прямо в карточке, например GLM
 *    (Z.ai, Coding Plan), файл models/glm.json:
 *
 *      {
 *        "provider": "openai-compatible",
 *        "baseUrl": "https://api.z.ai/api/coding/paas/v4",
 *        "model": "glm-4.6",
 *        "apiKey": "ваш_ключ"
 *      }
 *
 *    (обычный ключ z.ai без Coding Plan — baseUrl "https://api.z.ai/api/paas/v4")
 *
 * Дом настоящий (ключи и провайдеры), рабочая папка и проект — песочница:
 * для рабочей папки в доме заводится свой проект (projects/<id>/), после
 * прогона он удаляется вместе с песочницей. Три проверки: живой ответ
 * менеджера, менеджер реально создаёт агента, агент с files пишет файл.
 */
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, readFileSync as rf, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

let fails = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` — ${String(detail).slice(0, 300)}` : ''}`);
  }
};

// дом НАСТОЯЩИЙ (ключи), проект — песочница
const userHome = resolve(process.env.DT_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dreamteam'));
process.env.DT_HOME = userHome;
const proj = mkdtempSync(join(tmpdir(), 'dt-live-'));
process.chdir(proj);

// боевая карточка: любой models/*.json с настоящим адаптером и ключом
const modelsDir = join(userHome, 'models');
const cards = (existsSync(modelsDir) ? readdirSync(modelsDir).filter((f) => f.endsWith('.json')) : [])
  .map((f) => {
    try { return JSON.parse(rf(join(modelsDir, f), 'utf8')) as { provider?: string; model?: string; apiKey?: string }; } catch { return null; }
  })
  .filter((c): c is { provider?: string; model?: string; apiKey?: string } => c !== null);
const conf = cards.find((c) => c.provider && c.provider !== 'mock' && c.apiKey);
console.log(`Боевая модель: ${conf ? `${conf.model ?? '?'} (${conf.provider})` : 'не найдена'}, дом ${userHome}`);
if (!conf) {
  console.log('В ~/.dreamteam/models/ нет карточки настоящего провайдера с ключом. См. шапку файла.');
  process.exit(2);
}

const notices: string[] = [];
const errors: string[] = [];
const reply: { text: string } = { text: '' };
const sink = { delta() {}, done() {} };
const stub = {
  notice(text: string) { notices.push(text); },
  error(text: string) { errors.push(text); },
  turnHeader(_a: unknown) {},
  busy(_l: string) { return { stop() {} }; },
  stream(_l: string) { return sink; },
  turnEnd(full: string) { reply.text += full; },
  say(text: string) { reply.text += text; },
  toolLines(_r: string[]) {},
  attachment(_t: string, _d: string) {},
  async confirm() { return true; },
  async chooseSession() { return null; },
  sessionOpened() {},
};

process.on('exit', () => {
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* Windows держит файлы */ }
  try { rmSync(join(userHome, 'projects', basename(proj)), { recursive: true, force: true }); } catch { /* уже чисто */ }
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const { MANAGER_ID } = await import('../src/manager.js');
import type { Presenter } from '../src/core/presenter.js';

const { app } = await bootstrapApp();
const engine = new Engine(app, stub as unknown as Presenter);
// песочница как проект: путь не зарегистрирован — switchProject сам заведёт
// проект в доме (projects/<id>/, id = имя песочницы) и откроет его
engine.switchProject(proj);
app.session!.participants = [MANAGER_ID];
app.store!.save(app.session!);

const round = async (text: string, ms = 180_000): Promise<void> => {
  reply.text = '';
  await engine.handleMessage(text, AbortSignal.timeout(ms));
};

// ── 1. живой ответ менеджера ────────────────────────────────────────────────
await round('Смок-тест: ответь одной короткой фразой — ты кто и на какой модели работаешь?');
const stubReply = /заготовленный ответ mock-режима/i.test(reply.text);
check('1: менеджер ответил живьём (не заглушка, не пусто)', reply.text.trim().length > 10 && !stubReply, reply.text.slice(0, 160) || '(пусто)');

// ── 2. менеджер реально создаёт агента ─────────────────────────────────────
// команда живёт в доме: agents/<id>.json, по файлу на участника
const agentsDir = join(userHome, 'agents');
const yuristFile = join(agentsDir, 'smok_yurist.json');
await round('Добавь в команду нового участника: id «smok_yurist», имя «Юрист», роль «право и договоры». Никого не звать в чат.');
check('2: менеджер создал агента smok_yurist (карточка в доме)', existsSync(yuristFile),
  existsSync(agentsDir) ? readdirSync(agentsDir).join(', ') : 'папки agents нет');

// ── 3. агент с files реально пишет файл ────────────────────────────────────
if (existsSync(yuristFile)) {
  // тула files нет по умолчанию — включаем в карточке (то же, что делает /grant)
  const card = JSON.parse(rf(yuristFile, 'utf8')) as Record<string, unknown>;
  card.tools = { files: {} };
  writeFileSync(yuristFile, JSON.stringify(card, null, 2) + '\n');
  app.session!.participants = [MANAGER_ID, 'smok_yurist'];
  app.store!.save(app.session!);
  await round('Юрист, создай файл otchet-smoke.txt с одной строкой «smoke ok» и подтверди.');
  const created = join(proj, 'otchet-smoke.txt');
  check('3: юрист создал файл на диске через тул files', existsSync(created) && rf(created, 'utf8').includes('smoke ok'),
    existsSync(created) ? rf(created, 'utf8').slice(0, 80) : 'файла нет');
} else {
  check('3: агент с files пишет файл', false, 'пропущено: агент не создан на шаге 2');
}

console.log(fails === 0 ? '\nБоевой дым пройден' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
