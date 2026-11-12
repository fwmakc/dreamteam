/**
 * Тул «bg»: долговременные команды в фоне (```bg, тело — команда).
 *
 * Команда уходит под супервизию приложения и мгновенно отвечает «✅ Запущено:
 * id=…»: агент продолжает работу, а о завершении (успех/ошибка/таймаут/стоп)
 * приложение само поставит служебное сообщение в разговор — модель увидит его
 * в истории следующего раунда. Пока задача крутится, раз в check минут
 * приходит напоминание «задача ещё идёт» с хвостом лога — модель решает,
 * ждать дальше, заглянуть в лог или остановить задачу.
 *
 * Тело блока — команда; перед командой допускаются опции:
 *   timeout=30m — остановить задачу, живущую дольше получаса (30/30m/600s/2h);
 *   check=5     — период напоминаний в минутах (0 — выключить);
 *   title=…     — короткое имя для списков и уведомлений (одно слово, можно в кавычках).
 *
 * Интроспекция — телом блока: «list», «log bg-… [строк]», «kill bg-…».
 * id у задач вида bg-…, поэтому «kill bg-xyz» не спутается с фоновой командой.
 *
 * check() — как у shell: правила карточки (allow/deny) работают commandCheck'ем
 * и вытесняют дефолт целиком; без правил — дефолтная политика из default.json:
 * read-only команды текут молча, остальное — вопрос человеку (в авто-режиме и
 * в цели — решается само). Интроспекция своих задач — всегда молча.
 */
import { bgGet, bgInfo, bgKill, bgList, bgLog, formatBgDuration, parseBgSpawn, spawnBg } from '../../core/bg.js';
import {
  checkCardKeys,
  commandCheck,
  defaultCommandCheck,
  parseCommandRules,
  toolDefaults,
  type BuiltinDeps,
  type Tool,
  type ToolConfig,
  type ToolRunContext,
} from '../../tools-api.js';

/** Read-only списки фоновым командам — те же, что у shell (свой default.json). */
const SAFE_LISTS = toolDefaults('bg');
checkCardKeys(SAFE_LISTS, 'bg default.json', 'allow', 'allowWin32');
const pickSafe = (key: 'allow' | 'allowWin32'): Set<string> => {
  const list = SAFE_LISTS[key];
  if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !s.trim())) {
    throw new Error(`src/tools/bg/default.json: "${key}" — массив непустых строк`);
  }
  return new Set((list as string[]).map((s) => s.trim()));
};
const BG_SAFE = process.platform === 'win32' ? pickSafe('allowWin32') : pickSafe('allow');

const STATUS_EMOJI: Record<string, string> = {
  running: '⏳',
  done: '✅',
  failed: '❌',
  timeout: '⏱',
  killed: '⛔',
  lost: '❓',
};

/** Интроспекция? («list», «log bg-…», «kill bg-…») — тело-команда фоном не путается. */
function introspection(body: string): { op: 'list' } | { op: 'log' | 'kill'; id: string; arg?: string } | null {
  const t = body.trim();
  if (t === 'list') return { op: 'list' };
  const m = /^(log|kill)\s+(bg-[\w-]+)(?:\s+(\d+))?\s*$/.exec(t);
  if (m) return { op: m[1] as 'log' | 'kill', id: m[2]!, arg: m[3] };
  return null;
}

function taskLine(t: ReturnType<typeof bgInfo>): string {
  const dur = formatBgDuration((t.endedAt ?? Date.now()) - t.startedAt);
  const extra: string[] = [];
  if (t.timeoutMs) extra.push(`таймаут ${formatBgDuration(t.timeoutMs)}`);
  extra.push(t.checkMinutes > 0 ? `пинг ${t.checkMinutes}м` : 'без пингов');
  if (t.status === 'running' && t.pid) extra.push(`pid ${t.pid}`);
  if (t.error) extra.push(t.error);
  return `${STATUS_EMOJI[t.status] ?? '·'} ${t.id} «${t.title}» — ${t.status === 'running' ? 'идёт' : dur} (${extra.join(', ')})`;
}

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'bg', 'allow', 'deny');
  const hasRules = config.allow !== undefined || config.deny !== undefined;
  const rules = hasRules ? parseCommandRules(config, 'bg') : undefined;
  return {
    desc:
      'Фоновые задачи (```bg, тело — команда): команда уходит под супервизию приложения и мгновенно ' +
      'возвращает «✅ Запущено: id=…»; о завершении (успех/ошибка/таймаут/остановка) придёт служебное ' +
      'сообщение в разговор. Опции перед командой: timeout=30m, check=5 (минут между напоминаниями ' +
      '«идёт», 0 — выкл), title=… Интроспекция телом блока: list, log <id> [строк], kill <id>. ' +
      'Запуск — по тем же правилам, что у shell (read-only — молча, остальное — спросить), ' +
      'интроспекция своих задач — всегда молча.',
    check: (body, ctx) => {
      const intro = introspection(body);
      if (intro) return 'allow';
      const { command } = parseBgSpawn(body);
      if (!command) return { deny: 'пустое тело блока bg — нужна команда, «list», «log <id>» или «kill <id>»' };
      if (rules) return commandCheck(rules, command);
      return defaultCommandCheck(command, {
        safe: BG_SAFE,
        cwd: ctx?.cwd,
        projectHome: ctx?.projectHome,
      });
    },
    async run(body: string, ctx: ToolRunContext) {
      const intro = introspection(body);
      if (intro?.op === 'list') {
        const all = bgList();
        if (all.length === 0) return 'фоновых задач нет';
        return ['фоновые задачи (свежие сверху):', ...all.map(taskLine)].join('\n');
      }
      if (intro?.op === 'log') {
        const task = bgGet(intro.id);
        if (!task) throw new Error(`нет фоновой задачи «${intro.id}» — список телом блока: list`);
        const head = `${STATUS_EMOJI[task.status] ?? '·'} ${task.id} «${task.title}» — ${task.status}`;
        return `${head}\n${bgLog(intro.id, intro.arg ? Number(intro.arg) : 40)}`;
      }
      if (intro?.op === 'kill') return bgKill(intro.id);
      // запуск
      if (!deps) throw new Error('тул bg собран без конвейера — это внутренняя ошибка');
      const { timeoutMs, checkMinutes, title, command } = parseBgSpawn(body);
      if (!command) throw new Error('пустое тело блока bg — нужна команда (опции timeout=/check=/title= перед ней)');
      if (timeoutMs === undefined && /(^|\s)timeout=/.test(body)) {
        throw new Error('timeout=: не понял длительность — «30» (минуты), «30m», «600s» или «2h»');
      }
      const task = spawnBg({
        sessionId: deps.sessionId ?? '',
        by: deps.agent.id,
        command,
        title,
        cwd: ctx.cwd,
        timeoutMs,
        checkMinutes,
      });
      const tmo = task.timeoutMs ? `, таймаут ${formatBgDuration(task.timeoutMs)}` : '';
      const chk = task.checkMinutes > 0 ? `, напоминания каждые ${task.checkMinutes} мин` : '';
      return `Запущено: id=${task.id} «${task.title}»${tmo}${chk}. О завершении сообщу в разговор.`;
    },
  };
};
