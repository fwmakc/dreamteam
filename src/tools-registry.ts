/**
 * Реестр тулов: встроенные (files/shell/ssh/look/image) и пользовательские
 * tools/*.ts. Каждый тул — экземпляр Tool {desc, check, run}; валидация —
 * только check() самого тула, никаких списков на стороне хоста. Экземпляры
 * собираются заново перед каждым раундом, поэтому правки и кода тулов,
 * и карточек в agents.json подхватываются без перезапуска.
 *
 * Встроенные тула — обычные фабрики над тем же кодом исполнения, что был
 * всегда; их check() читает allow/deny из карточки агента (для shell/ssh)
 * или решает сам (files — путь в рабочей папке, look/image — локальные и
 * безопасные). Кривые списки в карточке роняют сборку с внятной ошибкой.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  executeFileAction,
  executeImageAction,
  executeLookAction,
  executeRunAction,
  executeSshAction,
  parseImageParams,
  safePath,
  workspaceFor,
  type ToolContext,
  type ToolsConfig,
} from './actions.js';
import {
  agentToolConfig,
  agentToolIds,
  BUILTIN_TOOL_IDS,
  commandCheck,
  parseCommandRules,
  TOOL_ID_RE,
  type Tool,
  type ToolCheckContext,
  type ToolConfig,
  type ToolFactory,
} from './tools-api.js';
import type { Agent } from './types.js';

/** Всё, что встроенному тулу нужно на run: конвейер собирает это перед раундом. */
export interface BuiltinDeps {
  cfg: ToolsConfig;
  agent: Agent;
  tctx: ToolContext;
  signal?: AbortSignal;
}

type BuiltinFactory = (config: ToolConfig, deps?: BuiltinDeps) => Tool;

function shellTool(config: ToolConfig, deps?: BuiltinDeps): Tool {
  const rules = parseCommandRules(config, 'shell');
  return {
    desc:
      'Команды оболочки этого ПК (```run). Тело — команда; что разрешено молча, задано в карточке тула shell (allow/deny в agents.json).',
    check: (body) => commandCheck(rules, body),
    async run(body, ctx) {
      if (!deps) throw new Error('тул shell собран без конвейера — это внутренняя ошибка');
      const r = await executeRunAction({ kind: 'run', command: body, project: ctx.project }, deps.cfg, deps.signal, deps.agent);
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
}

function sshTool(config: ToolConfig, deps?: BuiltinDeps): Tool {
  const rules = parseCommandRules(config, 'ssh');
  return {
    desc:
      'Команды на серверах по ssh (```ssh цель). Цель — «проект:хост»; тело — команда для сервера. Списки allow/deny — в карточке тула ssh.',
    check: (body) => commandCheck(rules, body),
    async run(body, ctx) {
      if (!deps) throw new Error('тул ssh собран без конвейера — это внутренняя ошибка');
      const r = await executeSshAction({ kind: 'ssh', host: ctx.arg ?? '', command: body }, deps.cfg, deps.signal);
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
}

function filesTool(_config: ToolConfig, deps?: BuiltinDeps): Tool {
  return {
    desc: 'Запись файлов в рабочую папку (```file путь, тело — полное содержимое файла). Внутри папки пишется молча.',
    check(path: string, ctx?: ToolCheckContext) {
      const inside = ctx ? safePath(ctx.cwd, path) !== null : false;
      return inside ? 'allow' : 'ask';
    },
    async run(body, ctx) {
      if (!deps) throw new Error('тул files собран без конвейера — это внутренняя ошибка');
      const r = executeFileAction(
        { kind: 'file', path: ctx.arg ?? '', content: body, project: ctx.project },
        deps.cfg,
        deps.agent,
      );
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
}

function lookTool(_config: ToolConfig, deps?: BuiltinDeps): Tool {
  return {
    desc: 'Показать файл своей vision-модели (```look путь, тело — вопрос по картинке).',
    check: () => 'allow',
    async run(body, ctx) {
      if (!deps) throw new Error('тул look собран без конвейера — это внутренняя ошибка');
      const r = await executeLookAction(
        { kind: 'look', path: ctx.arg ?? '', question: body, project: ctx.project },
        deps.cfg,
        deps.agent,
        deps.tctx,
        deps.signal,
      );
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
}

function imageTool(_config: ToolConfig, deps?: BuiltinDeps): Tool {
  return {
    desc: 'Генерация изображений image-моделью (```image, параметры строками «prompt: …», «size: …» и т.д.).',
    check: () => 'allow',
    async run(body, ctx) {
      if (!deps) throw new Error('тул image собран без конвейера — это внутренняя ошибка');
      const r = await executeImageAction(
        { kind: 'image', params: parseImageParams(body), project: ctx.project },
        deps.cfg,
        deps.agent,
        deps.tctx,
        deps.signal,
      );
      if (!r.ok) throw new Error(r.output);
      return r.output;
    },
  };
}

const BUILTIN_FACTORIES: Record<string, BuiltinFactory> = {
  files: filesTool,
  shell: shellTool,
  ssh: sshTool,
  look: lookTool,
  image: imageTool,
};

/** Встроенный тул по id (файлы в tools/ не могут занимать эти имена). */
export function builtinTool(id: string, config: ToolConfig, deps?: BuiltinDeps): Tool {
  const make = BUILTIN_FACTORIES[id];
  if (!make) throw new Error(`«${id}» — не встроенный тул (${BUILTIN_TOOL_IDS.join(', ')})`);
  return make(config, deps);
}

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
 * Читает tools/*.ts|js: имя файла — id тула. Папки может не быть — тогда
 * кастомных тулов нет; файл с кривым именем или без export default — ошибка.
 * Каждый вызов переимпортирует файлы (кэш модулей обходится версий-параметром),
 * поэтому правки кода тулов подхватываются без перезапуска.
 */
export async function loadUserTools(root: string): Promise<Map<string, ToolFactory>> {
  const dir = join(root, 'tools');
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
  const deps: BuiltinDeps = { cfg, agent, tctx, signal };
  const set = new Map<string, Tool>();
  for (const id of agentToolIds(agent)) {
    const config = agentToolConfig(agent, id);
    const builtin = BUILTIN_FACTORIES[id];
    if (builtin) {
      set.set(id, validateInstance(id, 'встроенный тул', builtin(config, deps)));
      continue;
    }
    const factory = userTools.get(id);
    if (!factory) {
      throw new Error(
        `тул «${id}» (агент «${agent.id}») не найден: встроенные — ${BUILTIN_TOOL_IDS.join(', ')}, свои положите в tools/${id}.ts`,
      );
    }
    set.set(id, validateInstance(id, `tools/${id}.ts`, factory(config)));
  }
  return set;
}
