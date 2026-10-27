/**
 * Тул «shell»: команды оболочки этого ПК (```run, тело — команда).
 *
 * Команды исполняются системным шеллом платформы: на Windows — cmd.exe,
 * на Linux/macOS — /bin/sh. Поэтому и белый список read-only, и подсказка
 * агенту — платформенные (default.json: "allow" для POSIX-шелла,
 * "allowWin32" для cmd), а на Windows bash-команды (ls, pwd, cat) физически
 * не существуют, и родные команды cmd (dir, type, findstr) — существуют.
 *
 * check() — два режима:
 *  - правила карточки (allow/deny) заданы — работает commandCheck: та же
 *    механика, что у git (deny бьёт любую часть цепочки, allow — целыми
 *    словами и без подстановок), дефолтная политика вытесняется целиком;
 *  - карточка пуста — дефолтная политика из default.json: read-only команды
 *    (ls, cat… / dir, type…) текут молча, но ТОЛЬКО внутри рабочей папки:
 *    путь за её пределами или похожий на секрет — отказ с обоснованием
 *    (deny), не вопрос. Git-команды в дефолт не входят сознательно: работа
 *    с репозиторием — отдельный тул git (```git), в shell она остаётся
 *    вопросом человеку.
 *
 * run() исполняет команду через системный шелл, таймаут и обрезка вывода —
 * из настроек. Рабочая папка — папка действия (текущая папка проекта).
 */
import { executeRunAction } from '../../actions.js';
import {
  checkCardKeys,
  commandCheck,
  defaultCommandCheck,
  parseCommandRules,
  toolDefaults,
} from '../../tools-api.js';
import type { BuiltinDeps, Tool, ToolConfig } from '../../tools-api.js';

/**
 * Белый список read-only команд — из default.json рядом с кодом ("allow" для
 * POSIX-шелла, "allowWin32" для cmd.exe: голая `date` в cmd ждёт ввод с stdin
 * и виснет до таймаута, поэтому её в win32-наборе нет; голая `cd` печатает
 * папку — оставлена как аналог pwd). Валидируется теми же правилами, что и
 * карточки: кривой дефолт роняет сборку тула, а не молча меняет политику.
 */
const SAFE_LISTS = toolDefaults('shell');
checkCardKeys(SAFE_LISTS, 'shell default.json', 'allow', 'allowWin32', 'deny');
const pickSafe = (key: 'allow' | 'allowWin32'): Set<string> => {
  const list = SAFE_LISTS[key];
  if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !s.trim())) {
    throw new Error(`src/tools/shell/default.json: "${key}" — массив непустых строк`);
  }
  return new Set((list as string[]).map((s) => s.trim()));
};
const SHELL_SAFE = process.platform === 'win32' ? pickSafe('allowWin32') : pickSafe('allow');

/** find умеет удалять и запускать — такие флаги мимо дефолта. */
const FIND_MUTATIONS = /-(delete|exec|execdir|ok|okdir)\b/;

export default (config: ToolConfig, deps?: BuiltinDeps): Tool => {
  checkCardKeys(config, 'shell', 'allow', 'deny');
  const hasRules = config.allow !== undefined || config.deny !== undefined;
  const rules = hasRules ? parseCommandRules(config, 'shell') : undefined;
  const isWin = process.platform === 'win32';
  const desc = isWin
    ? 'Команды cmd.exe этого ПК (```run, тело — команда). Это Windows: bash-команды ' +
      '(ls, pwd, cat, grep) недоступны — используй dir, type, findstr, tree, where, ' +
      'а для git — отдельный тул git. Read-only — молча, но только внутри рабочей ' +
      'папки и прикладных подпапок проекта inbox/mail/images (выход, секреты и ' +
      'подстановки %переменные% — отказ); ' +
      'остальное — по правилам карточки shell или вопрос человеку.'
    : 'Команды оболочки этого ПК (```run). Read-only (ls, cat, grep…) — ' +
      'молча, но только внутри рабочей папки и прикладных подпапок проекта ' +
      'inbox/mail/images (выход и секреты — отказ); ' +
      'для git — отдельный тул git (```git), для серверов — ssh; ' +
      'остальное — по правилам карточки shell или вопрос человеку.';
  return {
    desc,
    check: (body, ctx) =>
      rules
        ? commandCheck(rules, body)
        : defaultCommandCheck(body, {
            safe: SHELL_SAFE,
            cwd: ctx?.cwd,
            projectHome: ctx?.projectHome,
            askIf: FIND_MUTATIONS,
          }),
    async run(body, ctx) {
      if (!deps) throw new Error('тул shell собран без конвейера — это внутренняя ошибка');
      const r = await executeRunAction({ kind: 'run', command: body, project: ctx.project }, deps.cfg, deps.signal, deps.agent);
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
};
