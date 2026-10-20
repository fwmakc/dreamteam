/**
 * Реестр тулов: встроенные (src/tools/*.ts — по файлу на тул) и пользовательские
 * tools/*.ts. Каждый тул — экземпляр Tool {desc, check, run}; валидация —
 * только check() самого тула, никаких списков на стороне хоста. Экземпляры
 * собираются заново перед каждым раундом, поэтому правки и кода тулов,
 * и карточек в agents.json подхватываются без перезапуска.
 *
 * Встроенные тула — обычные фабрики над кодом исполнения (actions.ts), каждый
 * сам валидирует свою карточку (строгие поля + правила команд). Кривая карточка
 * роняет сборку тулов с внятной ошибкой, а не молча не работает.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolsConfig, ToolContext } from './actions.js';
import {
  agentToolConfig,
  agentToolIds,
  BUILTIN_TOOL_IDS,
  TOOL_ID_RE,
  type BuiltinFactory,
  type Tool,
  type ToolConfig,
  type ToolFactory,
} from './tools-api.js';
import filesTool from './tools/files.js';
import shellTool from './tools/shell.js';
import gitTool from './tools/git.js';
import archTool from './tools/arch.js';
import sshTool from './tools/ssh.js';
import lookTool from './tools/look.js';
import imageTool from './tools/image.js';
import type { Agent } from './types.js';

const BUILTIN_FACTORIES: Record<string, BuiltinFactory> = {
  files: filesTool,
  shell: shellTool,
  git: gitTool,
  arch: archTool,
  ssh: sshTool,
  look: lookTool,
  image: imageTool,
};

/** Проверяет, что объект правда тул; иначе — внятная ошибка с именем тула. */
function validateInstance(id: string, source: string, value: unknown): Tool {
  if (!value || typeof value !== 'object') {
    throw new Error(`${source}: тул «${id}» — export default должен вернуть объект {desc, check, run}`);
  }
  const t = value as Partial<Tool>;
  if (typeof t.desc !== 'string' || !t.desc.trim()) {
    throw new Error(`${source}: тул «${id}» — обязательное поле desc (строка: что это и как пользоваться)`);
  }
  if (typeof t.check !== 'function') {
    throw new Error(`${source}: тул «${id}» — обязательный метод check(body): 'allow' | 'deny' | 'ask'`);
  }
  if (typeof t.run !== 'function') {
    throw new Error(`${source}: тул «${id}» — обязательный метод run(body, ctx)`);
  }
  return value as Tool;
}

/**
 * Читает пользовательские тула из папки (<проект>/tools/*.ts|js): имя файла —
 * id тула. Папки может не быть — тогда кастомных тулов нет; файл с кривым
 * именем или без export default — ошибка. Каждый вызов переимпортирует файлы
 * (кэш модулей обходится версий-параметром), поэтому правки кода тулов
 * подхватываются без перезапуска.
 */
export async function loadUserTools(toolsDir: string): Promise<Map<string, ToolFactory>> {
  const dir = toolsDir;
  const map = new Map<string, ToolFactory>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return map;
  }
  for (const name of names.filter((f) => f.endsWith('.ts') || f.endsWith('.js'))) {
    const id = name.replace(/\.(ts|js)$/, '');
    if (!TOOL_ID_RE.test(id)) {
      throw new Error(`tools/${name}: «${id}» — id тула: строчные буквы/цифры/-/_ от 2 символов`);
    }
    if ((BUILTIN_TOOL_IDS as readonly string[]).includes(id)) {
      throw new Error(`tools/${name}: «${id}» — имя занято встроенным тулом, переименуйте файл`);
    }
    const url = pathToFileURL(join(dir, name)).href;
    const mod = (await import(`${url}?v=${Date.now()}-${Math.random().toString(36).slice(2)}`)) as {
      default?: unknown;
    };
    if (typeof mod.default !== 'function') {
      throw new Error(`tools/${name}: нужен export default — фабрика (config) => Tool`);
    }
    map.set(id, mod.default as ToolFactory);
  }
  return map;
}

/**
 * Экземпляры тулов агента: встроенные — фабрика + карточка из agents.json,
 * кастомные — фабрика из tools/<id>.ts + карточка. Карточка без тула — ошибка:
 * включённого, но не существующего инструмента быть не должно.
 */
export function buildToolset(
  agent: Agent,
  cfg: ToolsConfig,
  tctx: ToolContext,
  signal: AbortSignal | undefined,
  userTools: Map<string, ToolFactory>,
): Map<string, Tool> {
  const set = new Map<string, Tool>();
  const makeBuiltin = (id: string): BuiltinFactory | undefined => BUILTIN_FACTORIES[id];
  for (const id of agentToolIds(agent)) {
    const config = agentToolConfig(agent, id);
    const factory = makeBuiltin(id);
    if (factory) {
      set.set(id, validateInstance(id, `встроенный тул ${id}`, factory(config, { cfg, agent, tctx, signal })));
      continue;
    }
    const userFactory = userTools.get(id);
    if (!userFactory) {
      throw new Error(
        `тул «${id}» (агент «${agent.id}») не найден: встроенные — ${BUILTIN_TOOL_IDS.join(', ')}, свои положите в tools/${id}.ts`,
      );
    }
    set.set(id, validateInstance(id, `tools/${id}.ts`, userFactory(config)));
  }
  return set;
}
