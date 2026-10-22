/**
 * Тул «ssh»: команды на серверах проектов (```ssh цель, тело — команда) и
 * обмен файлами: тело «put локальный удалённый» или «get удалённый локальный»
 * уходит в штатный scp. Цель — «проект:хост» (приходит через ctx.arg).
 *
 * check() — слои от жёсткого к мягкому:
 *  1. папка проекта на сервере (host.dir из projects.json) и маски карточки
 *     ("masks", gitignore-синтаксис) — отказ всегда, правила карточки их
 *     не обходят: выход за папку и запретные файлы не бывают «молча»;
 *  2. правила карточки (allow/deny) или дефолт — read-only команды
 *     (uptime, df, systemctl status…) молча, остальное — вопрос человеку.
 * На сервере всё исполняется из папки проекта (cd + pwd в executeSshAction),
 * так что относительные пути — от неё.
 */
import { relative } from 'node:path';
import { executeScpTransfer, executeSshAction, resolveHost, safePath, type HostConfig } from '../actions.js';
import {
  checkCardKeys,
  commandCheck,
  defaultCommandCheck,
  maskDeny,
  parseCommandRules,
  parseMasks,
  pathScan,
  protectedPath,
  splitArgs,
  splitChain,
  type BuiltinDeps,
  type Tool,
  type ToolCheckContext,
  type ToolConfig,
  type ToolVerdict,
} from '../tools-api.js';

/** Безопасные команды на сервере: только читают. */
const SSH_SAFE = new Set([
  'pwd', 'ls', 'cat', 'head', 'tail', 'grep', 'ps', 'df', 'du', 'free',
  'uptime', 'whoami', 'hostname', 'uname', 'id', 'date', 'which', 'journalctl',
]);

/** systemctl только спрашивающие подкоманды — управляющие мимо дефолта. */
const SYSTEMCTL_READONLY = new Set([
  'status', 'is-active', 'is-enabled', 'is-failed', 'list-units',
  'list-unit-files', 'list-timers', 'show', 'cat',
]);

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'ssh', 'allow', 'deny', 'masks');
  const hasRules = config.allow !== undefined || config.deny !== undefined;
  const rules = hasRules ? parseCommandRules(config, 'ssh') : undefined;
  const masks = parseMasks(config, 'ssh');

  /** Хост действия: нужен для жёсткого слоя — папки проекта на сервере. */
  const hostOf = (ctx?: ToolCheckContext): HostConfig | undefined => {
    if (!deps || !ctx?.arg) return undefined;
    // arg — обычно уже полный ref («shop:prod»); голое имя уточняем проектом
    const ref = ctx.arg.includes(':') || !ctx.project ? ctx.arg : `${ctx.project}:${ctx.arg}`;
    const r = resolveHost(ref, deps.cfg);
    return 'error' in r ? undefined : r.host;
  };

  /** Путь-аргументы сегмента против масок; base — папка, от которой считать путь. */
  const maskHit = (seg: string, base: string | undefined): string | null => {
    for (const a of splitArgs(seg).slice(1)) {
      if (a.startsWith('-')) continue;
      if (!(a === '.' || a === '..' || a.startsWith('~') || a.startsWith('.') || a.includes('/') || a.includes('\\'))) continue;
      const rel = base && !a.startsWith('~') ? relative(base, a) : a.replace(/^~[\\/]/, '');
      const d = maskDeny(masks, rel);
      if (d) return d;
    }
    return null;
  };

  /** Жёсткий слой: выход за папку сервера и запретные файлы — deny всегда. */
  const hardScan = (body: string, dir: string | undefined): ToolVerdict | null => {
    for (const seg of splitChain(body)) {
      const bad = pathScan(seg, dir);
      if (bad) return { deny: bad };
      const masked = maskHit(seg, dir);
      if (masked) return { deny: masked };
    }
    return null;
  };

  /** put/get — обмен файлами: обе стороны внутри своих папок, маски действуют. */
  const scpVerdict = (body: string, ctx: ToolCheckContext | undefined, dir: string | undefined): ToolVerdict | null => {
    const words = splitArgs(body);
    if (words[0] !== 'put' && words[0] !== 'get') return null;
    if (words.length !== 3) {
      return { deny: `«${words[0]}» ждёт два пути: put локальный удалённый / get удалённый локальный` };
    }
    const [local, remote] = words[0] === 'put' ? [words[1]!, words[2]!] : [words[2]!, words[1]!];
    const localAbs = ctx ? safePath(ctx.cwd, local) : null;
    if (!localAbs) {
      return { deny: `локальный путь «${local}» вне рабочей папки — обмен только внутри неё` };
    }
    const protLocal = protectedPath(relative(ctx!.cwd, localAbs));
    if (protLocal) return { deny: protLocal };
    const maskedLocal = maskDeny(masks, relative(ctx!.cwd, localAbs));
    if (maskedLocal) return { deny: maskedLocal };
    if (dir) {
      const bad = pathScan(`scp ${remote}`, dir);
      if (bad) return { deny: bad };
      const maskedRemote = maskHit(`scp ${remote}`, dir);
      if (maskedRemote) return { deny: maskedRemote };
    } else if (remote.startsWith('/') || remote.startsWith('~') || remote.includes('..')) {
      return { deny: `удалённый путь «${remote}» вне папки проекта — задайте хосту "dir" в project.json` };
    }
    return rules ? commandCheck(rules, body) : 'ask';
  };

  return {
    desc:
      'Команды на серверах по ssh (```ssh цель). Цель — «проект:хост»; тело — команда для сервера, ' +
      'обмен файлами — put локальный удалённый / get удалённый локальный (scp). ' +
      'Read-only (uptime, df, systemctl status…) — молча; выход за папку проекта на сервере и ' +
      'запретные файлы (маски карточки) — отказ; остальное — по правилам карточки или вопрос человеку.',
    check: (body, ctx) => {
      const dir = hostOf(ctx)?.dir;
      const scp = scpVerdict(body, ctx, dir);
      if (scp) return scp;
      const hard = hardScan(body, dir);
      if (hard) return hard;
      if (rules) return commandCheck(rules, body);
      return defaultCommandCheck(body, {
        safe: SSH_SAFE,
        nested: { command: 'systemctl', readonlySet: SYSTEMCTL_READONLY },
        cwd: dir,
      });
    },
    async run(body, ctx) {
      if (!deps) throw new Error('тул ssh собран без конвейера — это внутренняя ошибка');
      const words = splitArgs(body.trim());
      if (words[0] === 'put' || words[0] === 'get') {
        if (words.length !== 3) {
          throw new Error('put/get ждут два пути: put локальный удалённый / get удалённый локальный');
        }
        const [local, remote] = words[0] === 'put' ? [words[1]!, words[2]!] : [words[2]!, words[1]!];
        const localAbs = safePath(ctx.cwd, local);
        if (!localAbs) throw new Error(`локальный путь «${local}» вне рабочей папки`);
        const prot = protectedPath(relative(ctx.cwd, localAbs));
        if (prot) throw new Error(prot);
        if (!ctx.arg) throw new Error('в блоке ssh не указан хост');
        const ref = ctx.arg.includes(':') || !ctx.project ? ctx.arg : `${ctx.project}:${ctx.arg}`;
        const t = resolveHost(ref, deps.cfg);
        if ('error' in t) throw new Error(t.error);
        const r = await executeScpTransfer(words[0] as 'put' | 'get', localAbs, remote, t, deps.cfg, deps.signal);
        if (!r.ok) throw new Error(r.output);
        return r.output;
      }
      const r = await executeSshAction({ kind: 'ssh', host: ctx.arg ?? '', command: body }, deps.cfg, deps.signal);
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
};
