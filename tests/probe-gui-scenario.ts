/**
 * Сценарий руководителя через GUI-протокол (WS): ровно те сообщения, которые
 * шлёт браузерная оболочка — user_message, command, rpc-методы, export_session,
 * import_session. Девять шагов; после КАЖДОГО — проверка на диске, что действие
 * выполнилось реально (файлы изменились), а не только отклик сервера.
 *
 *  0. открыть проект          → project.json в доме, разговор создан
 *  1. новая сессия            → +файл в sessions/, приветствие менеджера внутри
 *  2. агент-юрист             → запись в agents/ с дефолтами
 *  3. позвать в сессию        → participants в файле сессии
 *  4. переименовать           → title на диске
 *  5. несколько сообщений     → messages растут, есть реплики юриса и менеджера
 *  6. экспорт сессии          → zip читается, внутри session.json с юристом
 *  7. удалить агента и сессию → agents/ и sessions/ обратно
 *  8. импорт                  → сессия вернулась «как новая», юрист влит по id
 *  9. снова удалить           → песочница в исходном состоянии
 *
 * Удаление агента здесь идёт rpc-методом (так делает кнопка ✕ в GUI); в TUI
 * этой команды нет — там путь через менеджера (LLM), см. probe-tui-scenario.
 * Герметично: временный DT_HOME, mock-провайдер, порт 0; проект открывается
 * rpc-ом, как это делает GUI.
 * Запуск: npm run probe:scenario-gui
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { loadTeam } from '../src/agents.js';
import { writeModels } from './models.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { WebSocket, type RawData } from 'ws';

let fails = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` — ${String(detail).slice(0, 250)}` : ''}`);
  }
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- герметичные слои ---
const base = mkdtempSync(join(tmpdir(), 'dt-gui-scn-'));
const home = join(base, 'home');
const proj = join(base, 'proj');
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true }); // project.open открывает существующую папку
process.env.DT_HOME = home;
process.chdir(base); // рабочая папка тулов — песочница
writeModels(home, { mock: { provider: 'mock' } });
// интерфейс — на исходном русском (скаффолд по умолчанию даёт ui:"en")
writeFileSync(join(home, 'settings.json'), JSON.stringify({ ui: 'ru', width: 100, model: { id: 'mock' } }, null, 2) + '\n');
process.on('exit', () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* Windows держит файлы — песочница во временной папке */ } });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const sessionsDir = join(home, 'projects', 'proj', 'sessions'); // переписка — в доме, в проекте
const agentsDir = join(home, 'agents'); // команда — в доме (agents/<id>.json)
const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const sessionFile = (id: string): string => join(sessionsDir, `${id}.json`);
const readSessions = (): any[] =>
  readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).map((f) => readJson(sessionFile(f.replace(/\.json$/, ''))));

/** Ждём изменения на диске: действие считается выполненным только по файлу. */
async function waitDisk(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (cond()) return; } catch { /* файл пишется — читаем снова */ }
    await wait(150);
  }
  let detail = '';
  try { detail = `sessions=${readSessions().map((s) => `${s.id}:${s.messages?.length ?? 0}msg`).join(', ')}`; } catch { /* не смогли — ладно */ }
  check(`диск: ${what}`, false, detail || 'так и не появилось');
}

// карманный WS-клиент: очередь событий + поиск по предикату (queue-first —
// устойчиво к гонке «state пришёл раньше, чем мы начали ждать»)
function makeClient(port: number): Promise<{
  send(obj: unknown): void;
  next<T = Record<string, unknown>>(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<T>;
  awaitState<T = any>(pred: (st: T) => boolean, ms?: number): Promise<T>;
  close(): void;
}> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const queue: Record<string, unknown>[] = [];
    const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: NodeJS.Timeout }[] = [];
    ws.on('error', (e) => rej(e));
    ws.on('message', (data: RawData) => {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(m); return; }
      queue.push(m);
    });
    ws.on('open', () => {
      const next = <T>(pred: (m: Record<string, unknown>) => boolean, ms = 30_000): Promise<T> => {
        const i = queue.findIndex(pred);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0] as T);
        return new Promise<T>((res2, rej2) => {
          const timer = setTimeout(() => rej2(new Error('событие не пришло')), ms);
          waiters.push({ pred, resolve: (m) => res2(m as T), timer });
        });
      };
      res({
        send: (obj: unknown) => ws.send(JSON.stringify(obj)),
        next,
        awaitState: <T>(pred: (st: T) => boolean, ms = 30_000): Promise<T> =>
          next<Record<string, unknown>>((m) => m.type === 'state' && pred(m.state as unknown as T), ms)
            .then((m) => m.state as unknown as T),
        close: () => ws.close(),
      });
    });
  });
}

const { startServe } = await import('../src/serve.js');
const handle = await startServe({ port: 0 });
const client = await makeClient(handle.port);
let rpc = 0;
const rpcId = () => `c${++rpc}`;

try {
  // ── 0. открыть проект (старт приложения — без проекта) ──────────────────
  const st0 = await client.awaitState<{ sessions: unknown[]; project: unknown }>((s) => Array.isArray(s.sessions));
  check('старт: без проекта — разговоров нет, project пуст', st0.sessions.length === 0 && st0.project === null,
    JSON.stringify({ sessions: st0.sessions.length, project: st0.project }));
  client.send({ type: 'rpc', id: rpcId(), method: 'project.open', args: { path: proj } });
  await client.next((m) => (m.type === 'rpc_result' || m.type === 'rpc_error') && m.id === `c${rpc}`);
  const START_IDS = ['analyst', 'secretary', 'developer', 'designer', 'writer'];
  const stP = await client.awaitState<{ sessions: { id: string }[]; team: { id: string }[]; project: { id: string } | null }>(
    (s) => Array.isArray(s.sessions) && s.sessions.length === 1,
  );
  check('старт: проект открыт — пятёрка в команде, разговор создан',
    stP.team.length === 5 && START_IDS.every((id) => stP.team.some((a) => a.id === id)) && stP.project?.id === 'proj',
    JSON.stringify({ team: stP.team.map((a) => a.id), project: stP.project }));
  check('старт: файл сессии на диске', readSessions().length === 1);
  const firstId = stP.sessions[0].id; // исходный разговор — для возврата перед удалениями

  // ── 1. новая сессия ──────────────────────────────────────────────────────
  client.send({ type: 'rpc', id: rpcId(), method: 'session.new' });
  const r1 = await client.next<{ result: { text: string } }>((m) => m.type === 'rpc_result' && m.id === `c${rpc}`);
  check('1: session.new — rpc_result', Boolean(r1.result));
  const st1 = await client.awaitState<{ session: { id: string; messages: { authorId: string }[] }; sessions: unknown[] }>(
    (s) => s.sessions.length === 2,
  );
  check('1: state переключился на новый разговор', st1.session.messages.length >= 1);
  await waitDisk(() => readSessions().length === 2, 'второй файл сессии');
  await waitDisk(() => (readSessions().find((s) => s.id === st1.session.id)?.messages.length ?? 0) >= 1, 'приветствие записано');
  const fresh = readSessions().find((s) => s.id === st1.session.id);
  check('1: на диске новая сессия с приветствием менеджера',
    Boolean(fresh) && fresh.title === 'Новый разговор' && fresh.messages[0].authorId === 'manager',
    JSON.stringify(fresh?.messages?.[0] ?? null).slice(0, 120));

  // ── 2. агент-юрист ───────────────────────────────────────────────────────
  client.send({ type: 'rpc', id: rpcId(), method: 'agent.new', args: { id: 'yurist', name: 'Юрист', role: 'право и договоры' } });
  const r2 = await client.next<{ result: { text: string } }>((m) => m.type === 'rpc_result' && m.id === `c${rpc}`);
  check('2: agent.new — отчёт о добавлении', String(r2.result.text).includes('Юрист'));
  await waitDisk(() => { try { return loadTeam(agentsDir).some((a) => a.id === 'yurist'); } catch { return false; } }, 'юрист в agents/');
  const yurist = loadTeam(agentsDir).find((a) => a.id === 'yurist');
  check('2: юрист на диске с дефолтами (эмодзи/цвет/автопромпт)',
    yurist?.emoji === '🤖' && yurist?.color === 'white' && String(yurist?.prompt).startsWith('Ты — Юрист'),
    JSON.stringify(yurist).slice(0, 160));

  // ── 3. позвать в сессию ──────────────────────────────────────────────────
  client.send({ type: 'rpc', id: rpcId(), method: 'session.agent.add', args: { id: 'yurist' } });
  const r3 = await client.next<{ result: { text: string } }>((m) => m.type === 'rpc_result' && m.id === `c${rpc}`);
  check('3: session.agent.add — отчёт «присоединился»', String(r3.result.text).includes('присоединился'));
  await waitDisk(() => (readSessions().find((s) => s.id === st1.session.id)?.participants ?? []).includes('yurist'), 'юрист в participants');
  const parts = readSessions().find((s) => s.id === st1.session.id).participants;
  check('3: на диске participants = менеджер + юрист', parts.includes('yurist') && parts.includes('manager'), JSON.stringify(parts));

  // ── 4. переименовать ─────────────────────────────────────────────────────
  client.send({ type: 'command', text: '/session update title=Юридический вопрос' });
  await waitDisk(() => readSessions().find((s) => s.id === st1.session.id)?.title === 'Юридический вопрос', 'новое имя на диске');
  check('4: title на диске изменился', readSessions().find((s) => s.id === st1.session.id).title === 'Юридический вопрос');

  // ── 5. несколько сообщений ───────────────────────────────────────────────
  // сколько ответов участники дали к этому моменту — ждём ПРИРОСТ после каждого сообщения
  const repliesCount = (): number => {
    const s = readSessions().find((x) => x.id === st1.session.id);
    return (s?.messages ?? []).filter((m: any) => m.authorId !== 'user' && m.authorId !== '').length;
  };
  client.send({ type: 'user_message', text: 'Здравствуйте! Нужен договор аренды.' });
  const replies1 = repliesCount();
  await waitDisk(() => repliesCount() > replies1, 'ответ на первое сообщение');
  client.send({ type: 'user_message', text: 'Спасибо, ждём документы.' });
  const replies2 = repliesCount();
  await waitDisk(() => repliesCount() > replies2, 'ответ на второе сообщение');
  const msgs = readSessions().find((s) => s.id === st1.session.id).messages;
  check('5: обе реплики руководителя записаны', msgs.filter((m: any) => m.authorId === 'user').length === 2);
  check('5: на каждое сообщение пришёл ответ участника (на диске)', repliesCount() >= 2);
  check('5: у ответов есть текст (не пустышки)',
    msgs.filter((m: any) => m.authorId !== 'user' && m.authorId !== '').every((m: any) => String(m.text).length > 5));

  // ── 6. экспорт сессии ────────────────────────────────────────────────────
  client.send({ type: 'export_session', id: st1.session.id });
  const ex = await client.next<{ dataB64: string }>((m) => m.type === 'export_data');
  const zip = new AdmZip(Buffer.from(ex.dataB64, 'base64'));
  const names = zip.getEntries().map((e) => e.entryName);
  check('6: zip читается, внутри session.json и agents/', names.includes('session.json') && names.some((n) => n.startsWith('agents/')), names.join(', '));
  const exported = JSON.parse(zip.readAsText('session.json'));
  check('6: в архиве тот разговор (имя, юрист, сообщения)',
    exported.title === 'Юридический вопрос' &&
    (exported.participants ?? []).includes('yurist') &&
    exported.messages.length === msgs.length);
  const inZip = zip.getEntries().filter((e) => e.entryName.startsWith('agents/')).map((e) => JSON.parse(zip.readAsText(e)) as { id: string });
  check('6: в архиве только участники — юрист едет, чужие агенты нет',
    inZip.some((a) => a.id === 'yurist') && inZip.every((a) => (exported.participants ?? []).includes(a.id)),
    JSON.stringify(inZip.map((a) => a.id)));

  // кривой id — честная ошибка клиенту, сервер жив (catch на WS-обработчике)
  client.send({ type: 'export_session', id: 'нет-такого' });
  const err6 = await client.next<{ text: string }>((m) => m.type === 'error');
  check('6: кривой id — ошибка клиенту, сервер жив', String(err6.text).includes('не нашёл'), String(err6.text));

  // ── 7. удалить агента и сессию ───────────────────────────────────────────
  client.send({ type: 'rpc', id: rpcId(), method: 'session.open', args: { id: firstId } }); // уходим из удаляемого
  await client.next((m) => m.type === 'session_opened');
  client.send({ type: 'rpc', id: rpcId(), method: 'agent.delete', args: { id: 'yurist' } });
  const r7a = await client.next<{ result: { text: string } }>((m) => m.type === 'rpc_result' && m.id === `c${rpc}`);
  check('7: agent.delete — отчёт', String(r7a.result.text).toLowerCase().includes('юрист'));
  await waitDisk(() => { try { return !loadTeam(agentsDir).some((a) => a.id === 'yurist'); } catch { return false; } }, 'юрист удалён из agents/');
  check('7: юриста нет на диске', !loadTeam(agentsDir).some((a: any) => a.id === 'yurist'));
  const deletedId = st1.session.id;
  client.send({ type: 'rpc', id: rpcId(), method: 'session.delete', args: { id: deletedId } });
  const r7b = await client.next<{ result: { text: string } }>((m) => m.type === 'rpc_result' && m.id === `c${rpc}`);
  check('7: session.delete — разговор удалён', !String(r7b.result.text).includes('нельзя'));
  await waitDisk(() => readSessions().length === 1, 'файл сессии удалён');
  check('7: файл удалённого разговора исчез, остался исходный',
    readSessions().length === 1 && readSessions()[0].id !== deletedId);

  // ── 8. импорт ────────────────────────────────────────────────────────────
  client.send({ type: 'import_session', dataB64: ex.dataB64 });
  await client.next((m) => m.type === 'notice' && /импорт|влил|вернул|новый/i.test(String(m.text)));
  await waitDisk(() => readSessions().length === 2, 'сессия вернулась на диск');
  const restored = readSessions().find((s) => s.title === 'Юридический вопрос');
  check('8: разговор вернулся «как новый» (другой id, всё содержимое)',
    Boolean(restored) && restored.id !== deletedId && (restored.participants ?? []).includes('yurist'));
  await waitDisk(() => loadTeam(agentsDir).some((a: any) => a.id === 'yurist'), 'юрист влит из архива');
  check('8: юрист влит в команду по id (без дублей)',
    loadTeam(agentsDir).filter((a) => a.id === 'yurist').length === 1);

  // ── 9. снова удалить ─────────────────────────────────────────────────────
  client.send({ type: 'rpc', id: rpcId(), method: 'agent.delete', args: { id: 'yurist' } });
  await client.next<{ result: { text: string } }>((m) => m.type === 'rpc_result' && m.id === `c${rpc}`);
  await waitDisk(() => { try { return !loadTeam(agentsDir).some((a) => a.id === 'yurist'); } catch { return false; } }, 'юрист снова удалён');
  // текущим делаем исходный разговор, потом удаляем импортированный
  client.send({ type: 'rpc', id: rpcId(), method: 'session.open', args: { id: firstId } });
  await client.next((m) => m.type === 'session_opened');
  client.send({ type: 'rpc', id: rpcId(), method: 'session.delete', args: { id: restored.id } });
  const r9 = await client.next<{ result: { text: string } }>((m) => m.type === 'rpc_result' && m.id === `c${rpc}`);
  await waitDisk(() => readSessions().length === 1, 'импортированная сессия удалена');
  check('9: песочница в исходном состоянии (1 разговор, без юриста)',
    readSessions().length === 1 && !loadTeam(agentsDir).some((a: any) => a.id === 'yurist') &&
    readSessions()[0].id !== restored.id,
    String(r9.result?.text ?? ''));
} finally {
  client.close();
  await handle.close();
}

console.log(fails === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
