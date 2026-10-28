/**
 * Схема карточек (card-schema.ts) — единый источник форм «Изменить» в GUI:
 *  - состав: 4 сущности (agent/model/session/project), пути без дублей;
 *  - каждая метка и подсказка схемы — ключ словарей en и zh;
 *  - каждый path реально читается из живой карточки дома (агент, разговор,
 *    проект, модель) с согласованным типом (числа — числа, строки — строки);
 *  - stateSnapshot отдаёт схемы клиенту как есть (то, что ест GUI);
 *  - операция /agent get возвращает карточку JSON (её же просит rpc agent.get);
 *  - manager: workspace в белом списке agent.update (форма его присылает);
 *  - serve (WS): state несёт schemas, rpc agent.get отдаёт карточку, чужой id —
 *    rpc_error (паритет TUI и GUI).
 * Герметично: временный DT_HOME, mock-провайдер, порт 0.
 * Запуск: npm run probe:schemas
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeModels } from './models.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import type { Presenter, SpeakerRef, TurnSink } from '../src/core/presenter.js';
import { en } from '../src/locales/en.js';
import { zh } from '../src/locales/zh.js';
import { rmTemp } from './rm-tmp.js';

let fails = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── песочница: дом во временной директории ───────────────────────────────────
const base = mkdtempSync(join(tmpdir(), 'dt-schemas-'));
const home = join(base, 'home');
const p1 = join(base, 'p1');
mkdirSync(home, { recursive: true });
mkdirSync(p1, { recursive: true });
process.env.DT_HOME = home;
process.chdir(base);

writeModels(home, { mock: { provider: 'mock' } });
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');

// src-модули — строго после подмены слоёв: paths.ts вычисляет пути при загрузке
const paths = await import('../src/paths.js');
const { loadTeam } = await import('../src/agents.js');
const { updateTeamAgent } = await import('../src/manager.js');
const { CARD_SCHEMAS } = await import('../src/card-schema.js');

// ── состав схем ═══════════════════════════════════════════════════════════════
{
  const names = Object.keys(CARD_SCHEMAS).sort();
  check('состав: agent, model, project, session', JSON.stringify(names) === JSON.stringify(['agent', 'model', 'project', 'session']), names.join(', '));
  check('agent: 11 полей', CARD_SCHEMAS.agent.fields.length === 11, String(CARD_SCHEMAS.agent.fields.length));
  const all = Object.values(CARD_SCHEMAS).flatMap((s) => s.fields.map((f) => `${s.entity}.${f.path}`));
  check('пути без дублей', new Set(all).size === all.length, all.join(', '));
  const labels = Object.values(CARD_SCHEMAS).flatMap((s) => s.fields.map((f) => f.label));
  const placeholders = Object.values(CARD_SCHEMAS).flatMap((s) => s.fields.map((f) => f.placeholder).filter((p): p is string => Boolean(p)));
  check('метки — ключи en и zh', labels.every((l) => l in en && l in zh), labels.filter((l) => !(l in en) || !(l in zh)).join(', '));
  check('подсказки — ключи en и zh', placeholders.every((l) => l in en && l in zh), placeholders.filter((l) => !(l in en) || !(l in zh)).join(', '));
  const color = CARD_SCHEMAS.agent.fields.find((f) => f.path === 'color');
  check('color: enum 8 цветов', color?.type === 'enum' && (color.values ?? []).length === 8, JSON.stringify(color));
  const key = CARD_SCHEMAS.model.fields.find((f) => f.path === 'apiKey');
  check('model.apiKey: password', key?.type === 'password', JSON.stringify(key));
}

// ── boot: приложение, проект, живые карточки ═════════════════════════════════
const sink: TurnSink = { delta() {}, done() {} };
const stub: Presenter = {
  notice() {},
  service() {},
  error() {},
  turnHeader(_agent: SpeakerRef) {},
  busy() { return { stop() {} }; },
  stream() { return sink; },
  turnEnd() {},
  say() {},
  toolLines() {},
  attachment() {},
  async confirm() { return false; },
  async chooseSession() { return null; },
  sessionOpened() {},
};

const { bootstrapApp } = await import('../src/core/bootstrap.js');
const { Engine } = await import('../src/core/engine.js');
const { runOperationText } = await import('../src/core/operations.js');
const { stateSnapshot } = await import('../src/serve.js');

const { app } = await bootstrapApp();
const engine = new Engine(app, stub);
const run = (line: string): Promise<string[]> => runOperationText(engine, line);

await run(`/project new alpha ${p1}`);
check('подготовка: проект открыт, разговор есть', paths.PROJECT_DIR === join(home, 'projects', 'alpha') && app.session !== null);

/** Прочитать путь «a.b» из объекта (та же семантика, что в форме GUI). */
function get(obj: unknown, path: string): unknown {
  let v: unknown = obj;
  for (const part of path.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

/** Поля схемы читаются из карточки с согласованным типом. */
function typeOk(spec: { path: string; type: string; values?: readonly string[] }, card: unknown): boolean {
  const v = get(card, spec.path);
  if (v === undefined) return true; // необязательное поле — форма покажет пусто
  if (spec.type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (spec.type === 'enum') return typeof v === 'string' && (spec.values ?? []).includes(v);
  return typeof v === 'string';
}

// ── каждый path читается из живой карточки ═══════════════════════════════════
{
  const team = loadTeam(paths.AGENTS_DIR);
  check('команда: стартовая непуста', team.length > 0);
  const a = team[0];
  const agentSpecs = CARD_SCHEMAS.agent.fields;
  check(`агент «${a.id}»: все пути схемы читаются с типом`, agentSpecs.every((s) => typeOk(s, a)), agentSpecs.filter((s) => !typeOk(s, a)).map((s) => s.path).join(', '));
  check(
    'агент: скаляры непусты (имя/эмодзи/цвет/роль/промпт)',
    ['name', 'emoji', 'color', 'role', 'prompt'].every((p) => String(get(a, p) ?? '').length > 0),
  );

  const st = stateSnapshot(app, engine) as { schemas?: typeof CARD_SCHEMAS; project?: { path: string } | null };
  check('state: schemas уезжают клиенту без искажений', JSON.stringify(st.schemas) === JSON.stringify(CARD_SCHEMAS));
  check('state: project.path читается по схеме project', st.project?.path === p1 && typeOk(CARD_SCHEMAS.project.fields[0], st.project));

  const sessionCard = { title: app.session?.title };
  check('разговор: title читается по схеме session', typeOk(CARD_SCHEMAS.session.fields[0], sessionCard) && String(sessionCard.title ?? '').length > 0);

  const modelId = app.settings.model?.id ?? '';
  const slot = app.models.get(modelId);
  const modelCard = slot?.config ?? null;
  check('модель: config читается по схеме model', modelCard !== null && CARD_SCHEMAS.model.fields.every((s) => typeOk(s, modelCard)));
  check('модель: provider = mock из схемы', String(get(modelCard, 'provider')) === 'mock');
}

// ── операция /agent get — та же карточка, что попросит GUI ═══════════════════
{
  const a = loadTeam(paths.AGENTS_DIR)[0];
  const lines = await run(`/agent get ${a.id}`);
  let card: Record<string, unknown> | null = null;
  try { card = JSON.parse(lines.join('\n')) as Record<string, unknown>; } catch { card = null; }
  check('/agent get: JSON карточки', card !== null && card.id === a.id && typeof card.name === 'string', lines.join(' | ').slice(0, 120));
  check('/agent get: поля схемы читаются из ответа', card !== null && CARD_SCHEMAS.agent.fields.every((s) => typeOk(s, card)));
  const miss = (await run('/agent get нет-такого'))[0] ?? '';
  check('/agent get: чужой id — подсказка /agents', miss.includes('/agents'), miss);
}

// ── manager: workspace правится через белый список (его шлёт форма) ══════════
{
  const a = loadTeam(paths.AGENTS_DIR)[0];
  updateTeamAgent(paths.AGENTS_DIR, a.id, { workspace: 'отчёты' }, app.models);
  const raw = JSON.parse(readFileSync(join(paths.AGENTS_DIR, `${a.id}.json`), 'utf8')) as { workspace?: string };
  check('manager: workspace сохранился в карточке', raw.workspace === 'отчёты', JSON.stringify(raw.workspace));
  const again = loadTeam(paths.AGENTS_DIR).find((x) => x.id === a.id);
  check('manager: перечитанная карточка отдаёт workspace схеме', get(again, 'workspace') === 'отчёты');
}

// ── serve (WS): schemas в state, rpc agent.get ═══════════════════════════════
type Client = {
  next(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  send(obj: unknown): void;
  close(): void;
};
function makeClient(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const queue: Record<string, unknown>[] = [];
    const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: NodeJS.Timeout }[] = [];
    ws.on('error', reject);
    ws.on('message', (data: RawData) => {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
        return;
      }
      queue.push(m);
    });
    ws.on('open', () =>
      resolve({
        next(pred, ms = 30_000) {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('событие не пришло')), ms);
            waiters.push({ pred, resolve: res, timer });
          });
        },
        send: (obj) => ws.send(JSON.stringify(obj)),
        close: () => ws.close(),
      }),
    );
  });
}
const rpc = (c: Client, id: string, method: string, args: Record<string, unknown> = {}): void =>
  c.send({ type: 'rpc', id, method, args });

{
  const { startServe } = await import('../src/serve.js');
  const handle = await startServe({ port: 0 });
  const c = await makeClient(handle.port);
  const st = (await c.next((m) => m.type === 'state')).state as { schemas?: typeof CARD_SCHEMAS; team?: { id: string }[] };
  check('ws: state несёт schemas', JSON.stringify(st.schemas) === JSON.stringify(CARD_SCHEMAS));
  const id = st.team?.[0]?.id ?? '';
  rpc(c, 'r1', 'agent.get', { id });
  const res = await c.next((m) => m.type === 'rpc_result' && m.id === 'r1');
  const card = (res.result as { card?: { id?: string } }).card;
  check('ws: agent.get отдаёт карточку', card?.id === id, JSON.stringify(res.result).slice(0, 120));
  rpc(c, 'r2', 'agent.get', { id: 'нет-такого' });
  const err = await c.next((m) => m.type === 'rpc_error' && m.id === 'r2');
  check('ws: чужой id — rpc_error', String(err.error).includes('нет агента'), String(err.error));
  c.close();
}

rmSync(join(home, 'projects', 'alpha'), { recursive: true, force: true });
console.log(fails === 0 ? '\nпроба схем: всё ок' : `\nпроба схем: провалов ${fails}`);
rmTemp(base);
process.exit(fails === 0 ? 0 : 1);
