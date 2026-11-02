/**
 * Схема карточек (card-schema.ts) — единый источник форм «Изменить» в GUI:
 *  - состав статики: agent/project/session, пути без дублей; карточка МОДЕЛИ —
 *    динамическая (modelCardSchema из контракта провайдера), сверяется ниже;
 *  - каждая метка и подсказка статики и всех модельных схем — ключ en и zh;
 *  - каждый path реально читается из живой карточки дома (агент, разговор,
 *    проект, модель) с согласованным типом (числа, строки, булевы, объекты);
 *  - stateSnapshot отдаёт схемы клиенту как есть (то, что ест GUI);
 *  - операции /agent get и /model get возвращают карточки JSON (их же просят
 *    rpc agent.get/model.get);
 *  - manager: workspace и vision/image в белом списке agent.update;
 *  - serve (WS): state несёт schemas, rpc agent.get/model.get отдают карточки
 *    (model.get ещё и схему, секреты замаскированы), чужой id — rpc_error.
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

// по карточке на каждый встроенный контракт: schema сверяется с живыми карточками
writeModels(home, {
  mock: { provider: 'mock' },
  glm: { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'glm-4.6', apiKey: 'sk-test', vision: true },
  claude: { provider: 'anthropic-compatible', apiKey: 'sk-ant-test' },
  giga: { provider: 'gigachat', clientId: 'cid', clientSecret: 'cs-secret' },
});
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');

// src-модули — строго после подмены слоёв: paths.ts вычисляет пути при загрузке
const paths = await import('../src/paths.js');
const { loadTeam } = await import('../src/agents.js');
const { updateTeamAgent } = await import('../src/manager.js');
const { CARD_SCHEMAS, modelCardSchema, maskModelCard } = await import('../src/card-schema.js');
const { contractOf } = await import('../src/providers/registry.js');

// ── состав схем ═══════════════════════════════════════════════════════════════
{
  const names = Object.keys(CARD_SCHEMAS).sort();
  check('состав статики: agent, project, session (модель — динамическая)', JSON.stringify(names) === JSON.stringify(['agent', 'project', 'session']), names.join(', '));
  check('agent: 10 полей', CARD_SCHEMAS.agent.fields.length === 10, String(CARD_SCHEMAS.agent.fields.length));
  const all = Object.values(CARD_SCHEMAS).flatMap((s) => s.fields.map((f) => `${s.entity}.${f.path}`));
  check('пути без дублей', new Set(all).size === all.length, all.join(', '));
  const labels = Object.values(CARD_SCHEMAS).flatMap((s) => s.fields.map((f) => f.label));
  const placeholders = Object.values(CARD_SCHEMAS).flatMap((s) => s.fields.map((f) => f.placeholder).filter((p): p is string => Boolean(p)));
  check('метки — ключи en и zh', labels.every((l) => l in en && l in zh), labels.filter((l) => !(l in en) || !(l in zh)).join(', '));
  check('подсказки — ключи en и zh', placeholders.every((l) => l in en && l in zh), placeholders.filter((l) => !(l in en) || !(l in zh)).join(', '));
  const color = CARD_SCHEMAS.agent.fields.find((f) => f.path === 'color');
  check('color: enum 8 цветов', color?.type === 'enum' && (color.values ?? []).length === 8, JSON.stringify(color));
}

// ── модельная схема = контракт провайдера (все встроенные) ═══════════════════
const PROVIDERS = ['openai-compatible', 'anthropic-compatible', 'zai-coding-plan', 'gigachat', 'mock'] as const;
{
  const missing: string[] = [];
  for (const provider of PROVIDERS) {
    const contract = contractOf(provider);
    if (!contract) { missing.push(provider); continue; }
    const schema = modelCardSchema(provider);
    const wantKeys = ['provider', ...Object.keys(contract.keys)];
    const gotKeys = schema.fields.map((f) => f.path);
    if (JSON.stringify(gotKeys) !== JSON.stringify(wantKeys)) missing.push(`${provider}: ${gotKeys.join('|')}`);
    for (const f of schema.fields) {
      if (!(f.label in en && f.label in zh)) missing.push(`${provider}.${f.path}: метка`);
      if (f.placeholder && !(f.placeholder in en && f.placeholder in zh)) missing.push(`${provider}.${f.path}: подсказка`);
      const spec = contract.keys[f.path];
      if (!spec) continue;
      const secret = f.path === 'apiKey' || f.path === 'clientSecret';
      const want = secret ? 'password' : spec.type === 'number' ? 'number' : spec.type === 'boolean' ? 'boolean' : spec.type === 'object' ? 'object' : spec.enum ? 'enum' : 'string';
      if (f.type !== want) missing.push(`${provider}.${f.path}: тип ${f.type}≠${want}`);
      if (spec.enum && JSON.stringify(f.values) !== JSON.stringify(spec.enum)) missing.push(`${provider}.${f.path}: enum`);
    }
  }
  check('modelCardSchema: поля каждого провайдера = его контракт', missing.length === 0, missing.join('; '));
  const openai = modelCardSchema('openai-compatible');
  const vision = openai.fields.find((f) => f.path === 'vision');
  check('модель: vision — булево поле контракта', vision?.type === 'boolean', JSON.stringify(vision));
  const cwin = openai.fields.find((f) => f.path === 'contextWindow');
  check('модель: contextWindow — числовое поле контракта', cwin?.type === 'number', JSON.stringify(cwin));
  const extra = openai.fields.find((f) => f.path === 'extra');
  check('модель: extra — object-поле контракта', extra?.type === 'object', JSON.stringify(extra));
  const thinking = openai.fields.find((f) => f.path === 'thinking');
  check('модель: thinking — enum из контракта', thinking?.type === 'enum' && (thinking.values ?? []).join(',') === 'enabled,disabled', JSON.stringify(thinking));
  const req = openai.fields.find((f) => f.path === 'baseUrl');
  check('модель: required — подсказка «обязательное поле»', req?.placeholder === 'обязательное поле', JSON.stringify(req));
  const secret = modelCardSchema('gigachat').fields.find((f) => f.path === 'clientSecret');
  check('модель: clientSecret — password «пусто — не менять»', secret?.type === 'password' && secret.placeholder === 'пусто — не менять', JSON.stringify(secret));
  const custom = modelCardSchema('мой-адаптер');
  check('модель: провайдер без контракта — универсальный набор', custom.fields.length === 5 && custom.fields.map((f) => f.path).join(',') === 'provider,model,baseUrl,apiKey,note', custom.fields.map((f) => f.path).join(','));
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
  if (spec.type === 'boolean') return typeof v === 'boolean';
  if (spec.type === 'object') return typeof v === 'object' && v !== null;
  // ссылка на модель: id строкой или объект-переопределение
  if (spec.type === 'model') return typeof v === 'string' || (typeof v === 'object' && v !== null);
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
    'агент: скаляры непусты (имя/эмодзи/цвет/промпт)',
    ['name', 'emoji', 'color', 'prompt'].every((p) => String(get(a, p) ?? '').length > 0),
  );

  const st = stateSnapshot(app, engine) as { schemas?: typeof CARD_SCHEMAS; project?: { path: string } | null };
  check('state: schemas уезжают клиенту без искажений', JSON.stringify(st.schemas) === JSON.stringify(CARD_SCHEMAS));
  check('state: project.path читается по схеме project', st.project?.path === p1 && typeOk(CARD_SCHEMAS.project.fields[0], st.project));

  const sessionCard = { title: app.session?.title };
  check('разговор: title читается по схеме session', typeOk(CARD_SCHEMAS.session.fields[0], sessionCard) && String(sessionCard.title ?? '').length > 0);

  const modelId = app.settings.model?.id ?? '';
  const slot = app.models.get(modelId);
  const modelCard = slot?.config ?? null;
  const mockSchema = modelCardSchema('mock');
  check('модель mock: config читается по динамической схеме', modelCard !== null && mockSchema.fields.every((s) => typeOk(s, modelCard)));
  check('модель: provider = mock из схемы', String(get(modelCard, 'provider')) === 'mock');
  const glmSlot = app.models.get('glm');
  const glmSchema = modelCardSchema('openai-compatible');
  check('модель glm: все поля контракта читаются с типом', glmSlot !== undefined && glmSchema.fields.every((s) => typeOk(s, glmSlot.config ?? {})));
  check('модель glm: vision в карточке — булево true', get(glmSlot?.config, 'vision') === true);
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

// ── операция /model get — карточка контракта, её же просит rpc model.get ═════
{
  const lines = await run('/model get glm');
  let card: Record<string, unknown> | null = null;
  try { card = JSON.parse(lines.join('\n')) as Record<string, unknown>; } catch { card = null; }
  const schema = modelCardSchema('openai-compatible');
  check('/model get: JSON карточки', card !== null && card.provider === 'openai-compatible', lines.join(' | ').slice(0, 120));
  check('/model get: поля схемы читаются из ответа', card !== null && schema.fields.every((s) => typeOk(s, card)));
  const miss = (await run('/model get нет-такой'))[0] ?? '';
  check('/model get: чужой id — подсказка /models', miss.includes('/models'), miss);
  const masked = maskModelCard({ apiKey: 'sk-1', clientSecret: 'cs-1', model: 'x' });
  check('maskModelCard: секреты пустыми строками', masked.apiKey === '' && masked.clientSecret === '' && masked.model === 'x');
}

// ── manager: workspace правится через белый список (его шлёт форма) ══════════
{
  const a = loadTeam(paths.AGENTS_DIR)[0];
  updateTeamAgent(paths.AGENTS_DIR, a.id, { workspace: 'отчёты' }, app.models);
  const raw = JSON.parse(readFileSync(join(paths.AGENTS_DIR, `${a.id}.json`), 'utf8')) as { workspace?: string };
  check('manager: workspace сохранился в карточке', raw.workspace === 'отчёты', JSON.stringify(raw.workspace));
  const again = loadTeam(paths.AGENTS_DIR).find((x) => x.id === a.id);
  check('manager: перечитанная карточка отдаёт workspace схеме', get(again, 'workspace') === 'отчёты');
  // vision/image — те же ссылки model.*, форма агента их шлёт
  updateTeamAgent(paths.AGENTS_DIR, a.id, { vision: 'glm', image: { id: 'glm' } }, app.models);
  const withRefs = JSON.parse(readFileSync(join(paths.AGENTS_DIR, `${a.id}.json`), 'utf8')) as { vision?: { id?: string }; image?: { id?: string } };
  check('manager: vision/image легли ссылками на модель', withRefs.vision?.id === 'glm' && withRefs.image?.id === 'glm', JSON.stringify({ vision: withRefs.vision, image: withRefs.image }));
  const again2 = loadTeam(paths.AGENTS_DIR).find((x) => x.id === a.id);
  check('manager: схема агента читает vision.id/image.id', get(again2, 'vision.id') === 'glm' && get(again2, 'image.id') === 'glm');
  let rejected = false;
  try {
    updateTeamAgent(paths.AGENTS_DIR, a.id, { vision: 'нет-такой' }, app.models);
  } catch {
    rejected = true;
  }
  const after = JSON.parse(readFileSync(join(paths.AGENTS_DIR, `${a.id}.json`), 'utf8')) as { vision?: { id?: string } };
  check('manager: чужой id модели отвергнут, ссылка цела', rejected && after.vision?.id === 'glm');
  updateTeamAgent(paths.AGENTS_DIR, a.id, { vision: '', image: '' }, app.models);
  const cleaned = loadTeam(paths.AGENTS_DIR).find((x) => x.id === a.id);
  check('manager: пустая строка убирает ссылку', get(cleaned, 'vision') === undefined && get(cleaned, 'image') === undefined);
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
  rpc(c, 'r3', 'model.get', { id: 'glm' });
  const mres = await c.next((m) => m.type === 'rpc_result' && m.id === 'r3');
  const mres2 = mres.result as { card?: Record<string, unknown>; schema?: { fields?: { path: string }[] } };
  check('ws: model.get — схема = контракт openai-compatible', JSON.stringify((mres2.schema?.fields ?? []).map((f) => f.path)) === JSON.stringify(['provider', ...Object.keys(contractOf('openai-compatible')?.keys ?? {})]), JSON.stringify(mres2.schema?.fields?.map((f) => f.path)));
  check('ws: model.get — apiKey замаскирован', mres2.card?.apiKey === '' && mres2.card?.model === 'glm-4.6' && get(mres2.card, 'vision') === true, JSON.stringify(mres2.card));
  rpc(c, 'r4', 'model.get', { id: 'нет-такой' });
  const merr = await c.next((m) => m.type === 'rpc_error' && m.id === 'r4');
  check('ws: model.get чужой id — rpc_error', String(merr.error).includes('нет'), String(merr.error));
  c.close();
}

rmSync(join(home, 'projects', 'alpha'), { recursive: true, force: true });
console.log(fails === 0 ? '\nпроба схем: всё ок' : `\nпроба схем: провалов ${fails}`);
rmTemp(base);
process.exit(fails === 0 ? 0 : 1);
