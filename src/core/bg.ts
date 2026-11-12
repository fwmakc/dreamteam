/**
 * Фоновые задачи (BgTask): долговременные процессы под супервизией приложения.
 *
 * Задачу ставит человек (/bg run, форма GUI) или агент блоком ```bg. Диспетчер
 * спавнит процесс через системный шелл, сам пишет его вывод в лог (cap —
 * дальше в памяти держится только хвост), следит за таймаутом и завершением.
 * О каждом финальном статусе ставится уведомление в очередь разговора-владельца;
 * serve доставляет его как реплику authorId 'bg' — модель видит её как обычное
 * сообщение истории и продолжает работу. Пока задача крутится, bgTick() раз
 * в checkMinutes ставит пинг: модель решает — ждать, заглянуть в лог (```bg
 * с телом «log <id>») или остановить («kill <id>»).
 *
 * Состояние — на диске проекта (bg.json + bglogs/), процессы — в памяти.
 * После рестарта приложения задачи со статусом running переусыновляются по
 * pid: живой процесс сторожится поллингом (exit-код честно помечается
 * «неизвестен»), мёртвый — помечается lost. С schedule-задачами (расписание)
 * bg не пересекается ни именами, ни хранилищем: там задачи — тексты по
 * интервалу, здесь — процессы под супервизией.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killTree } from '../actions.js';
import { PROJECT_DIR, SETTINGS_FILE, WORKSPACE } from '../paths.js';
import { loadSettings } from '../settings.js';

/** Статус фоновой задачи. */
export type BgStatus = 'running' | 'done' | 'failed' | 'timeout' | 'killed' | 'lost';

/** Фоновая задача: запись в bg.json проекта. */
export interface BgTask {
  id: string;
  /** Папка проекта-владельца (абсолютная): tick пишет bg.json даже другого активного проекта. */
  dir: string;
  /** Разговор-владелец: куда доставляется уведомление. */
  sessionId: string;
  /** Кто поставил: 'user' или id агента. */
  by: string;
  /** Короткое имя для списков и уведомлений; пусто — берётся первая строка команды. */
  title: string;
  command: string;
  status: BgStatus;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  /** Таймаут, мс; 0/undefined — без таймаута. */
  timeoutMs?: number;
  /** Период пингов, минут; 0 — пинги выключены. */
  checkMinutes: number;
  /** Процесс пережил перезапуск приложения: exit-события нет, живость — поллинг pid. */
  adopted?: boolean;
  lastCheckAt: number;
  /** Время последнего куска вывода — детекция «лог не растёт». */
  lastOutputAt: number;
  /** Сколько символов вывода пришло всего (включая обрезанные после cap). */
  logBytes: number;
  /** Лог превысил cap: в файле лежит хвост, головка обрезана. */
  truncated?: boolean;
  /** Финальное уведомление доставлено в разговор (персистится — без дублей после рестарта). */
  notified?: boolean;
  /** Причина failure/lost или пометка «код выхода неизвестен» у переусыновлённых. */
  error?: string;
}

/** Уведомление о событии задачи — текст для реплики authorId 'bg'. */
export interface BgNote {
  taskId: string;
  sessionId: string;
  text: string;
}

/** Cap лога в символах: дальше файл переписывается хвостом, счётчик продолжает расти. */
const LOG_CAP = 2_000_000;
/** Хвост лога в памяти (живой источник для bgLog, когда файл уже переписан). */
const RING_CAP = 256_000;
/** Сколько символов вывода уходит в финальное уведомление / пинг. */
const NOTE_TAIL = 1500;
const PING_TAIL = 800;
/** «Лог не растёт», если вывода не было дольше этого. */
const STALL_MS = 3 * 60_000;

// ── состояние модуля ─────────────────────────────────────────────────────────

/** Все известные задачи (все проекты, что видели в этой сессии приложения). */
const tasks = new Map<string, BgTask>();
/** Живые процессы: у переусыновлённых задач хендла нет. */
const procs = new Map<string, { child: ChildProcess; ring: string }>();
/** Задачи, которым мы сами sent kill: их close() помечается killed/timeout, а не done/failed. */
const killing = new Map<string, BgStatus>();
/** Очередь недоставленных финальных уведомлений. */
const queue: BgNote[] = [];

// ── хранилище ────────────────────────────────────────────────────────────────

/** bg.json проекта (пустая PROJECT_DIR — дом; бывает только в пробах). */
export function bgFile(dir: string = PROJECT_DIR): string {
  return join(dir || '.', 'bg.json');
}

function bgLogsDir(dir: string = PROJECT_DIR): string {
  return join(dir || '.', 'bglogs');
}

function bgLogFile(id: string, dir: string = PROJECT_DIR): string {
  return join(bgLogsDir(dir), `${id}.log`);
}

/** Читает bg.json проекта; файла нет — []. Битые записи выбрасываются (как loadSchedule). */
export function loadBg(dir: string = PROJECT_DIR): BgTask[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(bgFile(dir), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is BgTask =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as BgTask).id === 'string' &&
      typeof (t as BgTask).command === 'string' &&
      typeof (t as BgTask).status === 'string',
  );
}

/** Пишет bg.json проекта: все задачи карты, принадлежащие этому dir. */
function saveBg(dir: string): void {
  const list = [...tasks.values()].filter((t) => t.dir === dir).sort((a, b) => a.startedAt - b.startedAt);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(bgFile(dir), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    // диск может быть недоступен: состояние в памяти живёт, next save повторит
  }
}

/** Всплески модуля видят только знакомые задачи: при первом обращении доливаем с диска. */
function ensureLoaded(dir: string = PROJECT_DIR): void {
  for (const t of loadBg(dir)) {
    if (!tasks.has(t.id)) tasks.set(t.id, t);
  }
}

// ── настройки-дефолты ────────────────────────────────────────────────────────

/** Дефолты новых задач из settings.json; файл не читается — безопасные значения. */
function defaultsFromSettings(): { checkMinutes: number; timeoutMs: number } {
  try {
    const ui = loadSettings(SETTINGS_FILE, 0);
    return { checkMinutes: ui.bgCheckMinutes, timeoutMs: ui.bgTimeoutMinutes * 60_000 };
  } catch {
    return { checkMinutes: 5, timeoutMs: 0 };
  }
}

/** «30» | «30m» | «600s» | «2h» → миллисекунды; без суффикса — минуты. */
export function parseBgDuration(s: string): number | undefined {
  const m = /^(\d+)\s*(h|m|s|м|ч|с)?$/.exec(s.trim().toLowerCase());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? 'm';
  const mult = unit === 'h' || unit === 'ч' ? 3_600_000 : unit === 's' || unit === 'с' ? 1000 : 60_000;
  return n * mult;
}

/** Тело блока ```bg или строки /bg run → опции + команда. */
export interface BgSpawnParsed {
  timeoutMs?: number;
  checkMinutes?: number;
  title?: string;
  command: string;
}

/**
 * Опции (timeout=/check=/title=) стоят в начале первой строки, команда —
 * за ними и в следующих строках. Неопознанный первый токен — вся строка
 * считается командой: `title=сборка npm run build` — title «сборка»,
 * а `npm run build key=1` — команда целиком.
 */
export function parseBgSpawn(body: string): BgSpawnParsed {
  const lines = body.split('\n');
  const words = lines[0]!.trim().split(/\s+/);
  const out: BgSpawnParsed = { command: '' };
  let i = 0;
  while (i < words.length) {
    const m = /^(timeout|check|title)=(.*)$/.exec(words[i]!);
    if (!m) break;
    let val = m[2]!;
    // title в кавычках держит пробелы: доклеиваем слова до закрывающей
    if (val.startsWith('"') && !val.endsWith('"')) {
      while (!val.endsWith('"') && i + 1 < words.length) val += ' ' + words[++i];
    }
    val = val.replace(/^"(.*)"$/, '$1');
    if (m[1] === 'timeout') out.timeoutMs = parseBgDuration(val);
    else if (m[1] === 'check') {
      const n = Number.parseInt(val, 10);
      if (Number.isFinite(n) && n >= 0) out.checkMinutes = n;
    } else if (m[1] === 'title' && val.trim()) out.title = val.trim();
    i++;
  }
  out.command = [words.slice(i).join(' '), ...lines.slice(1)].join('\n').trim();
  return out;
}

// ── запуск и супервизия ──────────────────────────────────────────────────────

export interface BgSpawnOpts {
  sessionId: string;
  by: string;
  command: string;
  title?: string;
  cwd?: string;
  /** Таймаут, мс; undefined — из настроек; 0 — без таймаута. */
  timeoutMs?: number;
  /** Период пингов, минут; undefined — из настроек; 0 — выключить. */
  checkMinutes?: number;
}

/**
 * Спавнит фоновый процесс и регистрирует задачу. Возврат мгновенный: дальнейшее
 * — на 'close'/'error' процесса и bgTick(). Процесс не detached: у живого
 * приложения есть его stdout; если приложение умрёт раньше процесса, задача
 * переусыновится при следующем старте (bgBoot).
 */
export function spawnBg(opts: BgSpawnOpts): BgTask {
  if (!PROJECT_DIR) throw new Error('нет открытого проекта — фоновым задачам некуда писать bg.json');
  ensureLoaded();
  const d = defaultsFromSettings();
  const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const task: BgTask = {
    id,
    dir: PROJECT_DIR,
    sessionId: opts.sessionId,
    by: opts.by,
    title: (opts.title ?? '').trim() || opts.command.split('\n')[0]!.slice(0, 60),
    command: opts.command,
    status: 'running',
    startedAt: now,
    timeoutMs: opts.timeoutMs ?? d.timeoutMs,
    checkMinutes: Math.max(0, Math.floor(opts.checkMinutes ?? d.checkMinutes)),
    lastCheckAt: now,
    lastOutputAt: now,
    logBytes: 0,
  };
  tasks.set(id, task);

  let child: ChildProcess;
  try {
    child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd ?? (WORKSPACE || undefined),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    task.status = 'failed';
    task.endedAt = Date.now();
    task.error = `ошибка запуска: ${err instanceof Error ? err.message : err}`;
    saveBg(task.dir);
    return task;
  }
  task.pid = child.pid;
  const handle = { child, ring: '' };
  procs.set(id, handle);
  mkdirSync(bgLogsDir(task.dir), { recursive: true });
  writeFileSync(bgLogFile(id, task.dir), '', 'utf8');

  const collect = (chunk: Buffer | string): void => {
    const s = chunk.toString();
    task.logBytes += s.length;
    task.lastOutputAt = Date.now();
    handle.ring += s;
    if (handle.ring.length > RING_CAP) handle.ring = handle.ring.slice(-RING_CAP);
    if (!task.truncated) {
      try {
        appendFileSync(bgLogFile(id, task.dir), s, 'utf8');
      } catch {
        task.truncated = true; // файл недоступен — хвост всё равно живёт в памяти
      }
      if (task.logBytes > LOG_CAP) {
        task.truncated = true;
        rewriteTail(task, handle.ring);
      }
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  child.on('error', (err) => {
    procs.delete(id);
    finalize(task, 'failed', undefined, `ошибка запуска: ${err.message}`);
  });
  child.on('close', (code) => {
    procs.delete(id);
    if (task.truncated) rewriteTail(task, handle.ring);
    const forced = killing.get(id);
    killing.delete(id);
    if (forced === 'timeout') {
      finalize(task, 'timeout', code ?? undefined);
    } else if (forced === 'killed') {
      finalize(task, 'killed', code ?? undefined);
    } else {
      finalize(task, code === 0 ? 'done' : 'failed', code ?? undefined);
    }
  });

  saveBg(task.dir);
  return task;
}

/** Переписывает лог хвостом из памяти: головка сдалась cap'у. */
function rewriteTail(task: BgTask, ring: string): void {
  try {
    writeFileSync(bgLogFile(task.id, task.dir), `(головка вывода обрезана, показан хвост)\n${ring}`, 'utf8');
  } catch {
    // недоступный диск не роняет супервизию
  }
}

/**
 * Финализация — единственный путь из running. try/catch вокруг каждой смены:
 * гарантия того, что упавшая/убитая задача не останется running и уведомление
 * встанет в очередь.
 */
function finalize(task: BgTask, status: BgStatus, exitCode?: number, error?: string): void {
  try {
    if (task.status !== 'running') return;
    task.status = status;
    task.endedAt = Date.now();
    if (exitCode !== undefined) task.exitCode = exitCode;
    if (error) task.error = error;
    saveBg(task.dir);
    if (!task.notified) {
      queue.push({ taskId: task.id, sessionId: task.sessionId, text: finalNote(task) });
    }
  } catch {
    // даже падение записи не должно уйти наверх из обработчика процесса
  }
}

// ── тексты уведомлений ───────────────────────────────────────────────────────

export function formatBgDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}ч ${String(m).padStart(2, '0')}м`;
  if (m > 0) return `${m}м ${String(sec).padStart(2, '0')}с`;
  return `${sec}с`;
}

function statusWord(task: BgTask): string {
  switch (task.status) {
    case 'done':
      return `завершена (код ${task.exitCode ?? 0})`;
    case 'failed':
      return `завершилась с ошибкой (код ${task.exitCode ?? '?'})`;
    case 'timeout':
      return `превысила таймаут ${formatBgDuration(task.timeoutMs ?? 0)} и остановлена`;
    case 'killed':
      return 'остановлена вручную';
    case 'lost':
      return 'не найдена после перезапуска приложения';
    default:
      return task.status;
  }
}

function tailOf(task: BgTask, chars: number): string {
  const src = bgLog(task.id, Math.ceil(chars / 40));
  if (!src.trim()) return '(вывода нет)';
  const cut = src.length > chars ? src.slice(-chars) : src;
  const nl = cut.indexOf('\n');
  return (cut.length < src.length && nl > 0 ? cut.slice(nl + 1) : cut).trimEnd();
}

function finalNote(task: BgTask): string {
  const dur = formatBgDuration((task.endedAt ?? Date.now()) - task.startedAt);
  const extra = task.error ? `\n${task.error}` : '';
  return `[⚙ фоновая задача ${task.id} «${task.title}» — ${statusWord(task)}, ${dur}]${extra}\n\n${tailOf(task, NOTE_TAIL)}`;
}

function pingNote(task: BgTask): string {
  const mins = Math.round((Date.now() - task.startedAt) / 60_000);
  const stalled = Date.now() - task.lastOutputAt > STALL_MS;
  const stall = stalled ? `, лог не рос ${formatBgDuration(Date.now() - task.lastOutputAt)}` : '';
  return (
    `[⏱ фоновая задача ${task.id} «${task.title}» — идёт ${mins} мин${stall}]\n\n` +
    `${tailOf(task, PING_TAIL)}\n\n` +
    `Ждать дальше — просто подтверди. Остановить — блок \`\`\`bg с телом «kill ${task.id}». ` +
    `Подробнее — «log ${task.id}».`
  );
}

// ── интроспекция ─────────────────────────────────────────────────────────────

/** Задача по id (из карты; до обращения — доливается с диска активного проекта). */
export function bgGet(id: string): BgTask | undefined {
  ensureLoaded();
  return tasks.get(id);
}

/** Хвост лога: живой процесс — память, завершённый — файл. */
export function bgLog(id: string, lines = 40): string {
  ensureLoaded();
  const task = tasks.get(id);
  const handle = procs.get(id);
  let src: string;
  if (handle) {
    src = handle.ring;
  } else {
    try {
      src = readFileSync(bgLogFile(id, task?.dir ?? PROJECT_DIR), 'utf8');
    } catch {
      return '(лог недоступен)';
    }
  }
  const arr = src.split('\n');
  const tail = arr.slice(-lines).join('\n');
  return (arr.length > lines ? `…(показаны последние ${lines} из ${arr.length} строк)\n` : '') + tail;
}

/** Останавливает задачу: живому процессу — killTree, переусыновлённому — pid. */
export function bgKill(id: string): string {
  const task = bgGet(id);
  if (!task) return `нет фоновой задачи «${id}» — список: /bg`;
  if (task.status !== 'running') return `фоновая задача ${id} уже завершилась (${statusWord(task)})`;
  killing.set(id, 'killed');
  const handle = procs.get(id);
  if (handle) {
    killTree(handle.child);
  } else if (task.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/T', '/F', '/PID', String(task.pid)], { stdio: 'ignore' });
      } else {
        process.kill(task.pid, 'SIGKILL');
      }
    } catch {
      // pid умер между проверкой и kill — поллинг доразберётся
    }
  }
  // страховка: процесс мог не отреагировать на kill — через 10 с добиваем статусом
  const killer = setTimeout(() => {
    if (tasks.get(id)?.status === 'running') {
      killing.delete(id);
      finalize(task, 'killed', undefined, 'процесс не отреагировал на остановку — статус выставлен принудительно');
    }
  }, 10_000);
  killer.unref();
  return `⏹ останавливаю ${id} «${task.title}»`;
}

/** Удаляет завершённую задачу из bg.json и её лог. */
export function bgDelete(id: string): string {
  const task = bgGet(id);
  if (!task) return `нет фоновой задачи «${id}» — список: /bg`;
  if (task.status === 'running') return `${id} ещё выполняется — сначала /bg kill ${id}`;
  tasks.delete(id);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.taskId === id) queue.splice(i, 1);
  }
  saveBg(task.dir);
  try {
    rmSync(bgLogFile(id, task.dir), { force: true });
  } catch {
    // лог мог не создаться
  }
  return `✓ удалена ${id}`;
}

/** Публичный вид задачи для снапшота/GUI. */
export interface BgTaskInfo {
  id: string;
  sessionId: string;
  by: string;
  title: string;
  command: string;
  status: BgStatus;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  timeoutMs?: number;
  checkMinutes: number;
  logBytes: number;
  truncated?: boolean;
  notified?: boolean;
  error?: string;
  adopted?: boolean;
}

export function bgInfo(task: BgTask): BgTaskInfo {
  return {
    id: task.id,
    sessionId: task.sessionId,
    by: task.by,
    title: task.title,
    command: task.command,
    status: task.status,
    pid: task.pid,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    exitCode: task.exitCode,
    timeoutMs: task.timeoutMs,
    checkMinutes: task.checkMinutes,
    logBytes: task.logBytes,
    truncated: task.truncated,
    notified: task.notified,
    error: task.error,
    adopted: task.adopted,
  };
}

/** Задачи проекта для списков: свежие сверху. */
export function bgList(dir: string = PROJECT_DIR): BgTask[] {
  ensureLoaded(dir);
  return [...tasks.values()].filter((t) => t.dir === (dir || PROJECT_DIR)).sort((a, b) => b.startedAt - a.startedAt);
}

// ── сторож: таймауты, пинги, переусыновлённые ────────────────────────────────

/**
 * Раз в минуту из serve (в TUI — чаще, проверка идёт по Date.now() и потому
 * идемпотентна). Возвращает пинги для доставки; финальные уведомления стекают
 * в очередь и забираются bgDrain().
 */
export function bgTick(): BgNote[] {
  const pings: BgNote[] = [];
  const now = Date.now();
  for (const task of [...tasks.values()]) {
    if (task.status !== 'running') continue;
    // таймаут: kill + финализация по close (страховка добивания — внутри bgKill)
    if (task.timeoutMs && task.timeoutMs > 0 && now - task.startedAt > task.timeoutMs) {
      killing.set(task.id, 'timeout');
      const handle = procs.get(task.id);
      if (handle) {
        killTree(handle.child);
      } else {
        // переусыновлённая: exit-события нет, финализируем сами
        killing.delete(task.id);
        finalize(task, 'timeout', undefined, 'остановлена по таймауту после перезапуска приложения');
      }
      continue;
    }
    // переусыновлённые: pid — единственный сигнал жизни
    if (task.adopted && task.pid) {
      let alive = true;
      try {
        process.kill(task.pid, 0);
      } catch (e) {
        alive = (e as NodeJS.ErrnoException)?.code === 'EPERM';
      }
      if (!alive) {
        finalize(task, 'done', undefined, 'код выхода неизвестен: процесс пережил перезапуск приложения и завершился сам');
      }
      continue;
    }
    // пинг: модель раз в checkMinutes смотрит на задачу
    if (task.checkMinutes > 0 && now - task.lastCheckAt >= task.checkMinutes * 60_000) {
      task.lastCheckAt = now;
      saveBg(task.dir);
      pings.push({ taskId: task.id, sessionId: task.sessionId, text: pingNote(task) });
    }
  }
  return pings;
}

/**
 * Достаёт из очереди финальные уведомления для разговора (undefined — все) и
 * помечает их доставленными (персистится). Пинги сюда не попадают: пропущенный
 * пинг безвреден, следующий придёт через checkMinutes.
 */
export function bgDrain(sessionId?: string): BgNote[] {
  const out: BgNote[] = [];
  for (let i = queue.length - 1; i >= 0; i--) {
    const n = queue[i]!;
    if (sessionId !== undefined && n.sessionId !== sessionId) continue;
    out.push(n);
    queue.splice(i, 1);
    const task = tasks.get(n.taskId);
    if (task && !task.notified) {
      task.notified = true;
      saveBg(task.dir);
    }
  }
  return out.reverse();
}

/**
 * Старт приложения / открытие проекта: доливает задачи с диска, переусыновляет
 * running-задачи по pid и возвращает в очередь недоставленные финальные
 * уведомления (задачи, завершившиеся, пока приложения не было). Очередь не
 * опустошает: уведомления чужих разговоров дождутся открытия своей сессии.
 */
export function bgBoot(dir: string = PROJECT_DIR): void {
  if (!dir) return;
  ensureLoaded(dir);
  for (const task of [...tasks.values()]) {
    if (task.dir !== dir) continue;
    if (task.status !== 'running' && !task.notified) {
      queue.push({ taskId: task.id, sessionId: task.sessionId, text: finalNote(task) });
      continue;
    }
    if (task.status !== 'running') continue;
    let alive = false;
    if (task.pid) {
      try {
        process.kill(task.pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException)?.code === 'EPERM';
      }
    }
    if (alive) {
      task.adopted = true;
      saveBg(task.dir);
    } else {
      finalize(task, 'lost', undefined, 'процесс не найден: приложение было перезапущено');
    }
  }
}
