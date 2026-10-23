/**
 * Боевой дым: проверка на НАСТОЯЩЕМ LLM-провайдере (не mock). Запускается
 * руками — в герметичную probe-сюиту боевые запросы не включаем (деньги,
 * квоты, недетерминизм).
 *
 *   npm run smoke:live
 *
 * Требования:
 *  - в ~/.dreamteam/providers.json основной провайдер — настоящий
 *    (не «mock») и с ключом в карточке, например GLM (Z.ai, Coding Plan):
 *
 *      "glm": {
 *        "adapter": "openai-compatible",
 *        "baseUrl": "https://api.z.ai/api/coding/paas/v4",
 *        "model": "glm-4.6",
 *        "apiKey": "ваш_ключ"
 *      }
 *
 *    (обычный ключ z.ai без Coding Plan — baseUrl "https://api.z.ai/api/paas/v4")
 *
 * Дом берётся настоящий (ключи и провайдеры), проект — временная песочница:
 * ничего в реальном проекте не изменяется. Три проверки: живой ответ менеджера,
 * менеджер реально создаёт агента, агент с files реально пишет файл.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readFileSync as rf, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
process.env.DT_PROJECT = proj;
process.chdir(proj);

const providersPath = join(userHome, 'providers.json');
if (!existsSync(providersPath)) {
  console.log('Нет ~/.dreamteam/providers.json — боевой провайдер не настроен. См. шапку файла.');
  process.exit(2);
}
const providersFile = JSON.parse(readFileSync(providersPath, 'utf8')) as { default: string; providers: Record<string, { adapter: string; model?: string }> };
const def = providersFile.default;
const conf = providersFile.providers[def];
console.log(`Боевой провайдер: «${def}» (${conf?.adapter ?? '?'}, модель ${conf?.model ?? '?'}), дом ${userHome}`);
if (def === 'mock' || conf?.adapter === 'mock') {
  console.log('Основной провайдер — mock. Настройте настоящий (например GLM, см. шапку файла) и повторите.');
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

process.on('exit', () => { try { rmSync(proj, { recursive: true, force: true }); } catch { /* Windows держит файлы */ } });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const { MANAGER_ID } = await import('../src/manager.js');
import type { Presenter } from '../src/core/presenter.js';

const { app } = await bootstrapApp();
const engine = new Engine(app, stub as unknown as Presenter);
app.session.participants = [MANAGER_ID];
app.store.save(app.session);

const round = async (text: string, ms = 180_000): Promise<void> => {
  reply.text = '';
  await engine.handleMessage(text, AbortSignal.timeout(ms));
};

// ── 1. живой ответ менеджера ────────────────────────────────────────────────
await round('Смок-тест: ответь одной короткой фразой — ты кто и на какой модели работаешь?');
const stubReply = /заготовленный ответ mock-режима/i.test(reply.text);
check('1: менеджер ответил живьём (не заглушка, не пусто)', reply.text.trim().length > 10 && !stubReply, reply.text.slice(0, 160) || '(пусто)');

// ── 2. менеджер реально создаёт агента ─────────────────────────────────────
const agentsFile = join(proj, 'agents.json');
await round('Добавь в команду нового участника: id «smok_yurist», имя «Юрист», роль «право и договоры». Никого не звать в чат.');
const team: Array<{ id: string }> = existsSync(agentsFile) ? JSON.parse(rf(agentsFile, 'utf8')) : [];
check('2: менеджер создал агента smok_yurist (agents.json на диске)', team.some((a) => a.id === 'smok_yurist'), team.map((a) => a.id).join(', ') || 'файла нет');

// ── 3. агент с files реально пишет файл ────────────────────────────────────
if (team.some((a) => a.id === 'smok_yurist')) {
  // тула files нет по умолчанию — включаем конфигом (то же, что делает /grant)
  const cfg = JSON.parse(rf(agentsFile, 'utf8'));
  cfg.find((a: { id: string }) => a.id === 'smok_yurist').tools = { files: {} };
  writeFileSync(agentsFile, JSON.stringify(cfg, null, 2) + '\n');
  mkdirSync(join(proj, 'tools'), { recursive: true });
  app.session.participants = [MANAGER_ID, 'smok_yurist'];
  app.store.save(app.session);
  await round('Юрист, создай файл otchet-smoke.txt с одной строкой «smoke ok» и подтверди.');
  const created = join(proj, 'otchet-smoke.txt');
  check('3: юрист создал файл на диске через тул files', existsSync(created) && rf(created, 'utf8').includes('smoke ok'),
    existsSync(created) ? rf(created, 'utf8').slice(0, 80) : 'файла нет');
} else {
  check('3: агент с files пишет файл', false, 'пропущено: агент не создан на шаге 2');
}

console.log(fails === 0 ? '\nБоевой дым пройден' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
