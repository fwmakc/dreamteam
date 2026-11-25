import { findMentions, loadTeam, loadUserProfile, MENTION_TRIGGERS } from '../agents.js';
import {
  MANAGER_ID,
  MANAGER_PROMPT,
  addMailAccount,
  addMessengerBot,
  addProjectHosts,
  addTeamAgent,
  grantTool,
  managerAsAgent,
  managerMentioned,
  managerStateInput,
  parseManagerReply,
  removeMailAccount,
  removeMessengerBot,
  revokeTool,
  updateTeamAgent,
} from '../manager.js';
import {
  actionsHint,
  checkPermission,
  describeAction,
  executeRunAction,
  functionSpecs,
  loadToolsConfig,
  parseActions,
  safePath,
  TOOL_RESULT_HEADER,
  workspaceFor,
  type Action,
  type ToolsConfig,
  type ToolContext,
} from '../actions.js';
import {
  agentToolConfig,
  agentToolIds,
  BUILTIN_TOOL_DESCS,
  BUILTIN_TOOL_IDS,
  type Tool,
  type ToolCheckContext,
  type ToolConfig,
  type ToolFactory,
  type ToolRunContext,
} from '../tools-api.js';
import { buildToolset, loadHouseCards, loadUserTools } from '../tools-registry.js';
import { operationHints, reloadModels, runOperationText } from './operations.js';
import { basename, join, resolve } from 'node:path';
// все пути приложения — только в paths.ts (PROJECT_DIR и др. — живые привязки)
import {
  AGENTS_DIR,
  DT_HOME,
  MEMORY_FILE,
  MODELS_DIR,
  PROJECTS_DIR,
  PROJECT_DIR,
  PROJECT_FILE,
  SESSIONS_DIR,
  SETTINGS_FILE,
  TOOLS_DIR,
  USER_FILE,
  WORKSPACE,
  clearProjectRoot,
  setProjectRoot,
} from '../paths.js';
import * as projects from './projects.js';
import { planTurns, type PlanResult } from '../orchestrator.js';
import { compressIfNeeded, contextSlice } from '../compress.js';
import {
  REFLECT_WINDOW,
  appendChatToLog,
  memoryBlock,
  mergeOtherChats,
  mergeShared,
  needsGlobalMerge,
  needsReflection,
  reflectSessionMemory,
  saveTeamMemory,
} from '../memory.js';
import { instantiateModel, resolveRefId, addModelConfig, updateModelConfig, removeModelConfig, type ImageProviderStatus, type ProviderStatus } from '../providers/registry.js';
import { SessionStore } from '../sessions.js';
import { loadSettings, type SettingsConfig } from '../settings.js';
import { readFileSync, writeFileSync } from 'node:fs';
import type {
  Agent,
  ChatMessage,
  LLMMessage,
  LLMProvider,
  ModelRef,
  ManagerAction,
  ManagerConfig,
  RoundUsage,
  Session,
  StreamRequest,
  TeamMemory,
  ToolSpec,
  UserProfile,
  GoalState,
} from '../types.js';
import type { Presenter, SpeakerRef } from './presenter.js';
import { t, tf, conversationLanguage } from '../i18n.js';

/** Общие правила агента; язык общения — из settings.json, в промт идёт как есть
 *  (пустой settings.language — языка интерфейса: conversationLanguage). */
const commonRules = (language: string) =>
  `Общие правила: отвечай строго на языке: ${language}, от первого лица, коротко и живо (обычно 2–5 предложений), ` +
  'без заголовков и списков, если тебя прямо не просят. Не выходи из роли и не упоминай, что ты ИИ. ' +
  'Если не согласен с коллегой — говори об этом прямо и обращайся к нему по имени. ' +
  'Свершившимся считай только то, что подтверждено историей: результатами «⚙ инструменты» (строки ✅/❌/⛔) или сообщениями о сделанных настройках. ' +
  'Не приписывай себе действий, которых в истории нет: если что-то ещё не сделано или тебе недоступно — скажи прямо, ' +
  'а планы формулируй как планы («сделаю»), а не как сделанное.';

const DIGEST_SYSTEM = `Ты — помощник команды. Сделай краткий конспект разговора, чтобы его можно было передать в другой разговор.
Сохрани: тему; что решили и договорились; ключевые аргументы с именами; важные названия, цифры и ограничения; что осталось незакрытым.
Пиши сжато, до 150 слов, без воды. Это рабочий конспект, а не пересказ.`;

/** Системный промт придумывания имени разговора (нужен только менеджеру) */
const NAMING_SYSTEM =
  'Ты придумываешь короткие имена для разговоров с командой ИИ. ' +
  'Ответь ТОЛЬКО именем: 2–5 слов, без кавычек, точки и пояснений. Язык — как в сообщении.';

/** Просьба-маркер приветствия: новый разговор один на один с менеджером (по ней mock узнаёт сценарий) */
const WELCOME_REQUEST =
  'Разговор только что создан, ты пока единственный его участник. Поприветствуй руководителя: ' +
  'коротко представься и скажи, чем можешь помочь — позвать команду, включить тулы, настроить проекты и серверы. ' +
  'Никаких действий не делай — только поприветствуй.';

const TOOL_FOLLOW_FOCUS =
  'Результаты твоих действий — в истории от «⚙ инструменты». Продолжай: следующий шаг или краткий итог. ' +
  'Опирайся только на эти результаты, ничего не додумывай.';

/** Максимум циклов «ответ с действиями → результаты → продолжение» на один ответ агента.
 *  Реальная работа шире трёх шагов: дерево ссылок сайта (раздел → глава → статья),
 *  ретраи после отказа, многофайловые задачи — раньше агенты просто не доезжали
 *  до записи результата. */
const MAX_TOOL_ITERATIONS = 16;

/** Приложение — конспект другого разговора, подшитый в текущий через @session */
/** Кто входит в раунд: пользователь, фоновая задача (уведомление) или цель. */
type RoundAs = 'user' | 'bg' | 'goal';

/** Реплика служебного автора (bg/goal): текст приходит готовым, рендер — служебный. */
const ROUND_AUTHORS: Record<Exclude<RoundAs, 'user'>, string> = {
  bg: '⚙ фоновая задача',
  goal: '🎯 цель',
};

export function isSessionRef(m: ChatMessage): boolean {
  return m.authorId === 'session-ref';
}

/** Отчёт действия, которое уже записано в хронику чата репликой менеджера:
 *  в сводку раунда и журнал уведомлений его дублировать не нужно. */
class ChatEvent {
  constructor(readonly text: string) {}
}

export interface App {
  /** Магазин разговоров активного проекта; null — проект не выбран */
  store: SessionStore | null;
  /** Активный разговор; null — проект не выбран (старт приложения) */
  session: Session | null;
  /** Карточки моделей из models/ дома */
  models: Map<string, ProviderStatus>;
  /** image-модели (генерация картинок) из той же полки */
  images: Map<string, ImageProviderStatus>;
  /** Мозг модератора и шлюз конфигурации (config/manager.json) */
  mgr: ManagerConfig;
  /** Общие настройки: settings.model — модель по умолчанию (ссылка) */
  settings: SettingsConfig;
  profile: UserProfile;
  memory: TeamMemory;
}

/**
 * Проект обязателен: чат, разговоры и секреты (hosts/mails/messengers) живут
 * в projects/<id>/ дома. Нет проекта — внятная ошибка с подсказкой, не падение.
 */
export function requireProject(app: App): { store: SessionStore; session: Session } {
  if (!app.store || !app.session) {
    throw new Error(t('NO_OPEN_PROJECT_START_WITH_PROJECT_NEW_ID'));
  }
  return { store: app.store, session: app.session };
}

/** Разговор обязателен: проект открыт, но разговор закрыт (/session close). */
export function requireSession(app: App): { store: SessionStore; session: Session } {
  const found = app.store ? (app.session ? { store: app.store, session: app.session } : null) : null;
  if (!found) {
    throw new Error(t('NO_OPEN_SESSION_SESSION_NEW_ID_OR_SESSION'));
  }
  return found;
}

/** Состав чата: явно выбранные участники или вся команда (старые разговоры). */
export function chatTeam(session: Session, fullTeam: Agent[]): Agent[] {
  const ids = session.participants;
  if (!ids || ids.length === 0) return fullTeam;
  const byId = new Map(fullTeam.map((a) => [a.id, a] as const));
  const picked = ids.map((id) => byId.get(id)).filter((a): a is Agent => Boolean(a));
  // «только менеджер» — его id в участниках, но в команде его нет: чат без
  // агентов, все реплики адресуются менеджеру (см. runRound)
  return picked.length > 0 ? picked : ids.includes(MANAGER_ID) ? [] : fullTeam;
}

/** Агент по id — только id: имена и номера адресацией больше не являются. */
function findAgentById(fullTeam: Agent[], id: string): Agent | undefined {
  const norm = id.trim().toLowerCase();
  return fullTeam.find((a) => a.id === norm);
}

let appVersionCache: string | undefined;
/** Версия приложения (package.json корня пакета); прочитать не удалось — пустая строка. */
function appVersion(): string {
  if (appVersionCache === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
      appVersionCache = typeof pkg.version === 'string' ? pkg.version : '';
    } catch {
      appVersionCache = '';
    }
  }
  return appVersionCache;
}

/** Реестр тулов дома для контекста менеджера: описания — карточка дома, иначе сам тул; встроенные — BUILTIN_TOOL_DESCS. */
function houseToolsRegistry(
  userTools: Map<string, ToolFactory>,
  houseCards: Map<string, ToolConfig>,
): { id: string; builtin: boolean; desc: string }[] {
  const list = (BUILTIN_TOOL_IDS as readonly string[]).map((id) => ({
    id,
    builtin: true,
    desc: (BUILTIN_TOOL_DESCS as Readonly<Record<string, string>>)[id] ?? '',
  }));
  for (const [id, make] of userTools) {
    const stated = houseCards.get(id)?.description;
    if (typeof stated === 'string' && stated.trim()) {
      list.push({ id, builtin: false, desc: stated.trim() });
      continue;
    }
    let desc = `формат тела — в файле tools/${id}.ts`;
    try {
      const d = (make({}) as Partial<Tool>).desc;
      if (typeof d === 'string' && d.trim()) desc = d.trim();
    } catch {
      // фабрика требует карточку — менеджеру хватает имени и файла
    }
    list.push({ id, builtin: false, desc });
  }
  return list;
}

/**
 * Ядро приложения: раунды, менеджер, инструменты, память. Всё, что видит
 * человек, проходит через Presenter — ядро ничего не печатает само.
 */
export class Engine {
  /** Пользовательские тулы (tools/*.ts) и карточки дома (tools/*.json) — перечитываются раз в раунд. */
  private userTools = new Map<string, ToolFactory>();
  private userToolCards = new Map<string, ToolConfig>();

  /** Очередь фоновых вливаний: закрывают чаты подряд — merges не перетирают друг друга. */
  private flushChain: Promise<void> = Promise.resolve();

  /** Язык общения из settings.json; пустой — языка интерфейса. Перечитывается
   *  каждый раунд и перед приветствием менеджера (как профиль). */
  private language = 'русский';

  /** Автономный режим: вопросы человеку решаются сами, раунды продолжаются.
   *  Это же авто-режим без текста цели: персистентная копия — session.goal. */
  autoMode = false;
  /** Сколько автоматических ходов осталось до остановки (лимит безопасности). */
  autoLeft = 0;
  /** Включить/выключить автономный режим с лимитом ходов (/auto on, /auto off). */
  setAutoMode(on: boolean, turns: number): void {
    this.autoMode = on;
    this.autoLeft = on ? turns : 0;
    // цель без текста — персистентная копия авто-режима: переживает рестарт,
    // serve-тикер возобновит её. /auto off снимает только такую цель;
    // цель с текстом выключается отдельно (/goal cancel).
    try {
      const { session, store } = requireProject(this.app);
      const g = session.goal;
      if (on) {
        session.goal = { maxRounds: turns, roundsDone: 0, startedAt: Date.now(), status: 'active' };
      } else if (g?.status === 'active' && !g.text) {
        g.status = 'cancelled';
      } else {
        return;
      }
      store.save(session);
    } catch {
      // нет проекта/разговора — синхронизировать нечего
    }
  }
  /** Автоответ на текстовые вопросы агентов (из settings.json). */
  private autoMessage = 'Решите вопрос на своё усмотрение.';
  /** Максимальное число отвечающих за раунд (0 — без ограничения; из settings.json). */
  private maxTurns = 3;

  // ── цель (Session.goal): крутить, пока модель не отчитается ─────────────

  /** Активная цель разговора (для снапшота serve и операций). */
  goalState(): GoalState | undefined {
    try {
      return requireProject(this.app).session.goal;
    } catch {
      return undefined;
    }
  }

  /** Задать цель: раунды продолжаются, пока модель не отчитается блоком
   *  ```goal done|failed или не кончится бюджет. /goal set, менеджер goal.set. */
  setGoal(text: string, maxRounds: number): string {
    const { session, store } = requireProject(this.app);
    const rounds = Math.max(1, Math.min(200, Math.floor(maxRounds) || 1));
    session.goal = { text, maxRounds: rounds, roundsDone: 0, startedAt: Date.now(), status: 'active' };
    store.save(session);
    return `🎯 Цель задана (бюджет: ${rounds} раундов-продолжений): ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`;
  }

  /** Снимает активную цель (пользователем: /goal cancel). */
  cancelGoal(): string {
    const { session, store } = requireProject(this.app);
    const g = session.goal;
    if (g?.status !== 'active') return 'активной цели нет';
    g.status = 'cancelled';
    store.save(session);
    return '🎯 Цель снята — раунды больше не продолжаются';
  }

  /** Отчитывается о цели вручную (/goal done — «я сам всё проверил»). */
  finishGoal(status: 'done' | 'failed' | 'budget', result?: string): string {
    const { session, store } = requireProject(this.app);
    const g = session.goal;
    if (g?.status !== 'active') return 'активной цели нет';
    g.status = status;
    if (result) g.result = result;
    store.save(session);
    if (status === 'budget') {
      return `🎯 Бюджет цели исчерпан (${g.roundsDone} из ${g.maxRounds} раундов). Продолжить: /goal set «тот же текст»`;
    }
    return status === 'done' ? `🎯 Цель достигнута${result ? `: ${result}` : ''}` : `🎯 Цель не достигнута${result ? `: ${result}` : ''}`;
  }

  /** Строки /goal status: состояние цели для человека. */
  goalStatusLines(): string[] {
    const g = this.goalState();
    if (!g) return ['цели нет — задать: /goal set <текст> [раунды]'];
    const head =
      g.status === 'active'
        ? `🎯 цель активна (раундов ${g.roundsDone}/${g.maxRounds})`
        : `🎯 цель: ${g.status}`;
    const lines = [head];
    if (g.text) lines.push(`  текст: ${g.text}`);
    if (g.result) lines.push(`  итог: ${g.result}`);
    return lines;
  }

  /** Целевой промпт — сообщение, которым продолжается цикл после ответа команды. */
  private goalContinueText(g: GoalState): string {
    return (
      `🎯 Цель: ${g.text}\n\n` +
      'Продолжай работу над целью. Если цель полностью достигнута — ответь блоком ```goal done, ' +
      'в теле — итог: что сделано и как проверено. Если цель недостижима (ошибка, тупик, нужен человек) — ' +
      'блоком ```goal failed с причиной. Пока не готов — работай и рассказывай, что делаешь.'
    );
  }

  /**
   * Отчёт модели о цели в репликах раунда (после индекса before): блок
   * ```goal done|failed — однострочный («```goal done Сборка зелёная»)
   * или многострочный (тело блока — итог). Только у активной цели с текстом.
   */
  private goalVerdictSince(before: number): { status: 'done' | 'failed'; result?: string } | null {
    const g = this.goalState();
    if (g?.status !== 'active' || !g.text) return null;
    for (const m of this.session.messages.slice(before)) {
      if (['user', 'tool', 'bg', 'goal', 'session-ref'].includes(m.authorId)) continue;
      const m1 = /```goal[ \t]+(done|failed)[ \t]+([^\n`]*)/.exec(m.text);
      if (m1) return { status: m1[1] as 'done' | 'failed', result: m1[2]?.trim() || undefined };
      const m2 = /```goal[ \t]+(done|failed)[ \t]*\n([\s\S]*?)```/.exec(m.text);
      if (m2) return { status: m2[1] as 'done' | 'failed', result: m2[2]?.trim() || undefined };
    }
    return null;
  }

  constructor(
    public app: App,
    private presenter: Presenter,
  ) {}

  /** Активный разговор; нет проекта — подсказка «/project new | open». */
  private get session(): Session {
    return requireProject(this.app).session;
  }

  /** Магазин разговоров активного проекта; нет проекта — та же подсказка. */
  private get store(): SessionStore {
    return requireProject(this.app).store;
  }

  // ── модели ───────────────────────────────────────────────────────────────

  /**
   * Провайдер по ссылке с учётом дефолтной (settings.model): карточка ←
   * settings.model ← ref. Неизвестный id — громко (списком доступных).
   */
  resolveProvider(ref: ModelRef | undefined): LLMProvider {
    const status = this.modelStatus(ref);
    return status.provider;
  }

  private modelStatus(ref: ModelRef | undefined): ProviderStatus {
    const settings = this.app.settings;
    const id = resolveRefId(ref, settings.model?.id);
    const status = this.app.models.get(id);
    if (!status) {
      const known = [...this.app.models.keys()].join(', ') || 'нет ни одной';
      throw new Error(`модель «${id}» не найдена в models/ (есть: ${known})`);
    }
    // мердж параметров: настройки по умолчанию, затем ссылка вызывающего
    const merged: ModelRef | undefined =
      settings.model || ref
        ? {
            ...(settings.model ?? {}),
            ...(ref ?? {}),
          }
        : undefined;
    return instantiateModel(id, status, merged);
  }

  /** Модель менеджера переговорки: только его ссылка из manager.json */
  private managerProvider(): LLMProvider {
    return this.resolveProvider(this.app.mgr.model);
  }

  private agentProvider(agent: Agent): LLMProvider {
    return this.resolveProvider(agent.model);
  }

  /** Служебная модель (модератор, нейминг, сжатие, память); пусто — основная. */
  private serviceModel(): LLMProvider {
    return this.resolveProvider(this.app.settings.serviceModel);
  }

  /** Уровень контекста после раунда: промпт+ответ и модель-автор оценки —
   *  для индикатора в статус-барах и порогового сжатия. */
  private touchContext(session: Session, usage: RoundUsage | undefined, providerId: string): void {
    if (!usage) return;
    session.contextTokens = (usage.promptTokens ?? 0) + (usage.outputTokens ?? 0);
    session.contextModel = providerId;
  }

  /** Самое тесное окно среди моделей разговора (min) — знаменатель порога
   *  сжатия: если не переполнилось оно, не переполнятся и остальные. */
  private minContextWindow(session: Session): number | undefined {
    const ids = new Set(Object.keys(session.usageByModel ?? {}));
    if (this.app.settings.model?.id) ids.add(this.app.settings.model.id);
    if (session.contextModel) ids.add(session.contextModel);
    const wins: number[] = [];
    for (const id of ids) {
      const w = this.app.models.get(id)?.config?.contextWindow;
      if (typeof w === 'number' && w > 0) wins.push(w);
    }
    return wins.length > 0 ? Math.min(...wins) : undefined;
  }

  /** Глаза и руки агентов: vision-модель для look и image-модель для image. */
  private toolContext(): ToolContext {
    const app = this.app;
    return {
      getVisionProvider(agent) {
        const status = app.models.get(resolveRefId(agent?.vision ?? agent?.model, app.settings.model?.id));
        if (!status) return { error: 'модель не найдена (см. models/)' };
        if (!status.vision) {
          return {
            error: `модель «${status.provider.model}» не умеет смотреть картинки — задайте агенту поле "vision" со ссылкой на модель, у которой в карточке "vision": true`,
          };
        }
        return { provider: status.provider };
      },
      getImageProvider(agent) {
        const ref = agent?.image;
        if (!ref) return { error: 'агенту не назначена image-модель (поле "image" в карточке агента)' };
        const id = resolveRefId(ref, app.settings.model?.id);
        const status = app.images.get(id);
        if (!status) return { error: `image-модель «${id}» не найдена (см. models/)` };
        if (!status.ok) return { error: `image-модель «${id}» не настроена: ${status.note ?? ''}` };
        return { provider: status.provider };
      },
      model(mid?: string) {
        const id = mid ?? app.settings.model?.id;
        if (!id) return { error: 'модель не указана (нет id и settings.model.id)' };
        const status = app.models.get(id);
        if (!status) {
          const known = [...app.models.keys()].join(', ') || 'нет ни одной';
          return { error: `модель «${id}» не найдена — есть: ${known}` };
        }
        return { provider: status.provider };
      },
    };
  }

  async refreshUserTools(): Promise<void> {
    try {
      this.userTools = await loadUserTools(TOOLS_DIR);
      this.userToolCards = loadHouseCards(TOOLS_DIR);
    } catch (err) {
      this.userTools = new Map();
      this.userToolCards = new Map();
      this.presenter.error(`тулы: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Тулы дома: id, встроенный ли, описание (карточка дома → сам тул). */
  houseTools(): { id: string; builtin: boolean; desc: string }[] {
    return houseToolsRegistry(this.userTools, this.userToolCards);
  }

  /** Полная команда из agents.json (свежая, не кэш). */
  team(): Agent[] {
    return loadTeam(AGENTS_DIR);
  }

  // ── сборка запроса ──────────────────────────────────────────────────────

  /** Собирает запрос агенту: профиль собеседника + конспект старой части + недавняя история + слово от модератора. */
  private buildRequest(
    agent: Agent,
    focus: string | undefined,
    fullHistory: ChatMessage[],
    user: UserProfile,
    summary?: string,
    personal?: string,
  ): StreamRequest {
    // focused-контекст: чужие реплики вне хвоста — однострочники
    let history = fullHistory;
    const focused = agent.context?.mode === 'focused';
    if (focused) {
      const tail = agent.context?.tail ?? 8;
      const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
      history = fullHistory.map((m, i) => {
        const isTail = i >= fullHistory.length - tail;
        const isMine = m.authorId === agent.id;
        const isUser = m.authorId === 'user';
        const isTool = m.authorId === 'tool';
        // служебные ходы (фоновые уведомления, цель) не сворачиваются никогда:
        // пропущенное «задача упала» стоит дороже экономии контекста
        const isService = m.authorId === 'bg' || m.authorId === 'goal';
        const addressed = MENTION_TRIGGERS.some((p) =>
          norm(m.text).includes(p + norm(agent.name)) || norm(m.text).includes(p + agent.id),
        );
        if (isTail || isMine || isUser || isTool || isService || addressed || isSessionRef(m)) return m;
        const preview = m.text.slice(0, 80).replace(/\n/g, ' ');
        return { ...m, text: `(${preview}${m.text.length > 80 ? '…' : ''})` };
      });
    }
    const messages: LLMMessage[] = [];
    if (summary) {
      messages.push({
        role: 'user',
        content: `Итог более ранней части разговора (сжатый конспект):\n${summary}\n\nНиже — недавние сообщения.`,
      });
    }
    for (const m of history.slice(-30)) {
      if (isSessionRef(m)) {
        messages.push({
          role: 'user',
          content: `Приложение — конспект другого разговора «${m.authorName}»:\n${m.text}`,
        });
      } else if (m.authorId === 'user') {
        messages.push({ role: 'user', content: `${user.name}: ${m.text}` });
      } else if (m.authorId === 'tool') {
        messages.push({ role: 'user', content: `${TOOL_RESULT_HEADER}\n${m.text}` });
      } else if (m.authorId === 'bg' || m.authorId === 'goal') {
        // служебные ходы приходят с самодостаточным текстом («[⚙ фоновая задача
        // …]», «🎯 Цель: …») — уходят как есть, без автора-человека
        messages.push({ role: 'user', content: m.text });
      } else {
        messages.push({
          role: 'user',
          content: `${m.authorName}: ${m.text}`,
        });
      }
    }
    messages.push({
      role: 'user',
      content: focus
        ? `Модератор передаёт слово тебе. Фокус: ${focus}`
        : 'Модератор передаёт слово тебе. Ответь по существу.',
    });
    const identity =
      `Твой собеседник — ${user.name}.${user.about ? ` О себе: ${user.about}.` : ''} ` +
      'Обращайся к собеседнику по имени, когда это уместно.';
    const blocks = [agent.prompt, identity];
    if (personal) {
      blocks.push(`Твоя память (субъективно и сжато, это то, что ты помнишь сам):\n${personal}`);
    }
    let tools: ToolSpec[] | undefined;
    if (agentToolIds(agent).length > 0) {
      // desc кастомных тулов — из живых экземпляров; кривая карточка не должна
      // ронять сборку промпта: об ошибке отрапортует конвейер при выполнении
      const custom = new Map<string, Tool>();
      for (const id of agentToolIds(agent)) {
        const factory = this.userTools.get(id);
        if (factory) {
          try {
            const house = this.userToolCards.get(id);
            custom.set(id, factory({ ...(house ?? {}), ...agentToolConfig(agent, id) }));
          } catch {
            // кривая карточка — подсказка по этому тулу будет общей
          }
        }
      }
      const hint = actionsHint(agent, this.toolsConfig(), custom);
      if (hint) blocks.push(hint);
      // провайдерам с нативным function calling (gigachat) — те же тулы структурой запроса
      tools = functionSpecs(agent, custom);
    }
    blocks.push(commonRules(this.language));
    return {
      system: blocks.join('\n\n'),
      messages,
      tools,
      // не задано — дефолт провайдера: температура карточки модели (с учётом
      // переопределений settings.model и model.* агента), без своего хардкода
      temperature: agent.model?.temperature,
    };
  }

  private toolsConfig(): ToolsConfig {
    // ssh-серверы — поле hosts в project.json; нет проекта — серверов нет
    return loadToolsConfig(SETTINGS_FILE, PROJECT_FILE || null, WORKSPACE);
  }

  // ── конспекты и @session ────────────────────────────────────────────────

  /**
   * Выбор разговора для @session: "@session 2" — сразу номер из списка других
   * разговоров, "@session" — интерактивный выбор. Enter отменяет.
   */
  private async pickSession(numStr?: string): Promise<Session | null> {
    // автономный режим: никаких интерактивных вопросов
    if (this.autoMode) return null;
    const list = this.store.list().filter((s) => s.id !== this.session.id);
    if (list.length === 0) {
      this.presenter.notice(t('NO_OTHER_SESSIONS_YET_NOTHING_TO_ATTACH'));
      return null;
    }
    if (numStr) {
      const n = Number.parseInt(numStr, 10);
      const meta = Number.isInteger(n) && n > 0 ? list[n - 1] : undefined;
      if (!meta) {
        this.presenter.notice(tf('NO_SESSION_N_IN_THE_LIST_OF_OTHER', { n: numStr }));
        return null;
      }
      return this.store.load(meta.id);
    }
    const idx = await this.presenter.chooseSession(list.map((s) => ({ title: s.title, count: s.count })));
    if (idx === null || idx < 0 || idx >= list.length) {
      this.presenter.notice(t('CONTINUING_WITHOUT_AN_ATTACHMENT'));
      return null;
    }
    return this.store.load(list[idx].id);
  }

  /**
   * Конспект разговора для передачи в другой чат. Кэшируется в самом разговоре
   * (session.digest) и перестраивается, только если разговор заметно вырос.
   */
  async getSessionDigest(
    session: Session,
    signal?: AbortSignal,
    userName = 'Пользователь',
    quiet = false,
    store: SessionStore = requireProject(this.app).store,
  ): Promise<string | null> {
    const provider = this.resolveProvider(undefined);
    if (session.digest && session.digestAtCount !== undefined        && session.messages.length - session.digestAtCount < 10) {
      return session.digest;
    }
    const parts: string[] = [];
    if (session.summary) parts.push(`Предыдущий конспект:\n${session.summary}`);
    const rest = session.messages.slice(session.compressedUpTo ?? 0);
    if (rest.length > 0) {
      parts.push(
        'Сообщения разговора:\n' +
        rest.map((m) =>
          `${m.authorId === 'user' ? userName : m.authorName}: ${m.text}`,
        ).join('\n'),
      );
    }
    if (parts.length === 0) {
      if (!quiet) this.presenter.notice(t('THE_SELECTED_SESSION_IS_EMPTY'));
      return null;
    }

    const busy = quiet ? null : this.presenter.busy(tf('READING_SESSION_TITLE', { title: session.title }));
    try {
      let digest: string;
      if (provider.kind === 'mock') {
        digest = `Разговор «${session.title}»: ` +
          rest.slice(0, 6).map((m) => `${m.authorName}: ${m.text.slice(0, 60)}`).join('; ');
      } else {
        let out = '';
        for await (const chunk of provider.stream({
          system: DIGEST_SYSTEM,
          messages: [{ role: 'user', content: parts.join('\n\n') }],
          temperature: 0.2,
          signal,
        })) {
          out += chunk;
        }
        digest = out.trim();
      }
      if (!digest) {
        if (!quiet) this.presenter.notice(t('FAILED_TO_BUILD_THE_SESSION_DIGEST'));
        return null;
      }
      session.digest = digest;
      session.digestAtCount = session.messages.length;
      store.save(session);
      return digest;
    } catch (err) {
      if (signal?.aborted) return null; // прервано (Esc) — сообщение об этом ниже
      if (!quiet) this.presenter.notice(tf('FAILED_TO_READ_THE_SESSION_ERR', { err: err instanceof Error ? err.message : String(err) }));
      return null;
    } finally {
      busy?.stop();
    }
  }

  // ── раунд ────────────────────────────────────────────────────────────────

  /** Реплика пользователя: весь раунд под одним signal (Esc/Ctrl+C у оболочки). */
  async handleMessage(text: string, signal: AbortSignal, files: string[] = []): Promise<void> {
    // команды исполняет ядро: один набор для терминала, сети и менеджера;
    // текст команды в историю разговора не пишется
    if (text.startsWith('/')) {
      for (const line of await runOperationText(this, text, signal)) {
        this.presenter.notice('  ' + line);
      }
      return;
    }
    // болтовня без проекта невозможна: разговоры живут в projects/<id>/
    if (!this.app.store) {
      this.presenter.notice(t('NO_OPEN_PROJECT_PICK_ONE_PROJECT_NEW_ID'));
      return;
    }
    if (!this.app.session) {
      this.presenter.notice(t('NO_OPEN_SESSION_SESSION_NEW_ID_SESSION_OPEN'));
      return;
    }
    let team: Agent[];
    try {
      team = this.team();
    } catch (err) {
      this.presenter.error(tf('FAILED_TO_READ_THE_COMMAND_ERR', { err: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // автономность и цель — в общем цикле раундов: продолжения, бюджет, отчёт
    await this.roundsLoop(text, 'user', files, team, signal);
  }

  /**
   * Цикл раундов с продолжениями. После ответа команды цикл продолжается
   * авто-сообщением (авто-режим — реплика от пользователя, как раньше) или
   * целевым промптом (цель — реплика authorId 'goal') — пока не кончатся
   * ходы/бюджет, не придёт отчёт модели ```goal done|failed или автономность
   * не снимут (/auto off, /goal cancel). Отчёт ищем в репликах каждого раунда:
   * любые агенты, включая продолжения после тулов. Тем же входом живут и
   * служебные ходы: возобновление цели после рестарта (as 'goal') и доставка
   * фоновых уведомлений (as 'bg').
   */
  private async roundsLoop(
    initial: string,
    initialAs: RoundAs,
    files: string[],
    team: Agent[],
    signal: AbortSignal,
  ): Promise<void> {
    let current: string | null = initial;
    let currentAs: RoundAs = initialAs;
    while (current !== null) {
      const before = this.session.messages.length;
      await this.runRound(current, team, signal, currentAs === 'user' ? files : [], currentAs);
      if (signal.aborted) break;
      const verdict = this.goalVerdictSince(before);
      if (verdict) {
        this.presenter.notice('  ' + this.finishGoal(verdict.status, verdict.result));
        break;
      }
      const g = this.session.goal;
      if (g?.status === 'active' && g.text) {
        if (g.roundsDone >= g.maxRounds) {
          this.presenter.notice('  ' + this.finishGoal('budget'));
          break;
        }
        g.roundsDone++;
        this.store.save(this.session);
        current = this.goalContinueText(g);
        currentAs = 'goal';
        continue;
      }
      if (!this.autoMode || this.autoLeft <= 0) {
        if (this.autoMode && this.autoLeft <= 0) {
          this.setAutoMode(false, 0);
          this.presenter.notice(t('AUTONOMOUS_MODE_FINISHED_THE_MOVE_LIMIT_IS_REACHED'));
        }
        break;
      }
      this.autoLeft--;
      if (g?.status === 'active' && !g.text) {
        g.roundsDone++;
        this.store.save(this.session);
      }
      current = this.autoMessage;
      currentAs = 'user';
    }
  }

  /**
   * Служебный ход от подсистемы фоновых задач: уведомление попадает в разговор
   * как реплика authorId 'bg', команда реагирует; активная цель после этого
   * продолжается как обычно (roundsLoop).
   */
  async deliverBgNote(text: string, signal: AbortSignal): Promise<void> {
    const team = this.team();
    await this.roundsLoop(text, 'bg', [], team, signal);
  }

  /**
   * Служебный ход цели (as 'goal'): начать или продолжить цикл прямо сейчас —
   * первый ввод после /goal set и возобновление после рестарта (serve-тикер).
   * Неактивная цель — тихий no-op.
   */
  async startGoalRound(signal: AbortSignal): Promise<void> {
    const g = this.goalState();
    if (g?.status !== 'active') return;
    const input = g.text ? this.goalContinueText(g) : this.autoMessage;
    const team = this.team();
    await this.roundsLoop(input, 'goal', [], team, signal);
  }

  private async runRound(
    text: string,
    fullTeam: Agent[],
    signal: AbortSignal,
    files: string[] = [],
    as: RoundAs = 'user',
  ): Promise<void> {
    const { session, store } = requireProject(this.app);
    // профиль читаем каждый раунд: правки config/user.json подхватываются на лету
    const profile = loadUserProfile(USER_FILE);
    this.app.profile = profile;
    // язык общения, автоответ, лимит отвечающих — из settings.json, на лету;
    // язык общения пустой — команда говорит на языке интерфейса
    const ui = loadSettings(SETTINGS_FILE, 0);
    this.language = ui.language ?? conversationLanguage(ui.ui, DT_HOME);
    this.autoMessage = ui.autoMessage;
    this.maxTurns = ui.maxTurns;
    // тулы тоже: переимпорт tools/*.ts и свежие карточки — без перезапуска
    await this.refreshUserTools();
    // в чате отвечают только позванные (старые чаты без списка — вся команда)
    const team = chatTeam(session, fullTeam);

    // @session — приложить конспект другого разговора (можно несколько, "@session 2" — сразу номер);
    // служебные ходы (bg/goal) идут с готовым текстом, конспекты к ним не приделываются
    const attachments: ChatMessage[] = [];
    const usedIds = new Set<string>();
    let cleaned = text;
    if (as === 'user') {
      const refRegex = /[@!]session(?:\s+(\d+))?/gi;
      for (const match of text.matchAll(refRegex)) {
        const picked = await this.pickSession(match[1]);
        if (!picked || picked.id === session.id || usedIds.has(picked.id)) continue;
        usedIds.add(picked.id);
        const digest = await this.getSessionDigest(picked, signal, profile.name);
        if (!digest) continue;
        attachments.push({
          authorId: 'session-ref',
          authorName: picked.title,
          text: digest,
          ts: Date.now(),
        });
        cleaned = cleaned.replace(match[0], ' ');
      }
    }
    if (signal.aborted) return;
    // подчищаем следы @session, но не трогаем переносы строк (многострочные сообщения)
    cleaned = cleaned.replace(/[^\S\n]{2,}/g, ' ').replace(/ ?\n ?/g, '\n').trim();

    for (const a of attachments) {
      this.presenter.attachment(a.authorName, a.text);
      session.messages.push(a);
    }
    store.save(session);

    const userText = cleaned || (attachments.length > 0 ? 'Ознакомься с приложенным конспектом' : '');
    if (!userText) return;
    const userMsg: ChatMessage =
      as === 'user'
        ? { authorId: 'user', authorName: 'Вы', text: userText, ts: Date.now() }
        : { authorId: as, authorName: ROUND_AUTHORS[as], text: userText, ts: Date.now() };
    // метки [имя] в тексте остаются (агенты ищут файлы в inbox по ним), список — рядом
    if (files.length) userMsg.attachments = files;
    session.messages.push(userMsg);
    if (as === 'user' && session.title === 'Новый разговор') {
      const flat = userText.replace(/\s+/g, ' ');
      session.title = flat.slice(0, 42) + (flat.length > 42 ? '…' : '');
      // у живого менеджера спрашиваем имя по первому сообщению; в mock-режиме
      // остаётся имя по первому сообщению (болтовня в имя не годится)
      if (this.serviceModel().kind !== 'mock') {
        const name = await this.generateSessionName(`Нужно дать имя сессии. Вот первое сообщение:\n${userText.slice(0, 800)}`);
        if (name) session.title = name;
      }
    }
    store.save(session);

    // @менеджер — конфигурация переговорки через разговор: состав команды,
    // состав чата, разговоры. Другого пути менять agents.json в приложении нет.
    // Чат «только менеджер» (новый разговор): все реплики — ему, без модератора.
    // Служебные ходы менеджера не зовут: bg-уведомление или цель — не просьба
    // перекроить команду.
    if (team.length === 0 || (as === 'user' && managerMentioned(text, this.app.mgr))) {
      await this.managerTurn(text, fullTeam, profile, signal);
      return;
    }

    // модератор и сжатие едут на служебной модели (serviceModel), не на флагмане
    const moderator = this.serviceModel();

    // не даём контексту расти бесконечно: старые сообщения сворачиваются в конспект
    const compressing = this.presenter.busy(t('CHECKING_THE_SESSION_LENGTH'));
    let compressed = false;
    try {
      compressed = await compressIfNeeded(session, moderator, signal, profile.name, {
        tokens: session.contextTokens,
        window: this.minContextWindow(session),
        threshold: ui.compressThreshold,
      });
    } catch (err) {
      if (signal.aborted) return;
      this.presenter.notice(tf('FAILED_TO_COMPACT_HISTORY_CONTINUING_AS_IS_ERR', { err: err instanceof Error ? err.message : String(err) }));
    } finally {
      compressing.stop();
    }
    if (compressed) {
      store.save(session);
      this.presenter.notice(t('THE_SESSION_IS_LONG_OLDER_MESSAGES_WERE_FOLDED'));
    }

    const planning = this.presenter.busy(t('THE_MODERATOR_IS_PICKING_WHO_ON_THE_TEAM'));
    let plan: PlanResult;
    const mentionedAll = findMentions(text, fullTeam);
    for (const a of mentionedAll) {
      if (!team.some((t) => t.id === a.id)) {
        this.presenter.notice(tf('NAME_IS_NOT_IN_THIS_CHAT_INVITE_SESSION', { name: a.name }));
      }
    }
    try {
      plan = await planTurns({
        text,
        team,
        history: session.messages.slice(0, -1),
        moderator,
        mentioned: findMentions(text, team),
        signal,
        userName: profile.name,
        maxTurns: this.maxTurns,
      });
    } finally {
      planning.stop();
    }
    if (signal.aborted) return;
    if (plan.note) this.presenter.notice(`  … ${plan.note}`);

    for (const turn of plan.turns) {
      if (signal.aborted) break; // Esc во время предыдущего ответа — остальных не зовём
      this.presenter.turnHeader(turn.agent);
      const provider = this.agentProvider(turn.agent);
      const personal = memoryBlock(turn.agent, session, fullTeam, this.app.memory, profile.name);
      const sink = this.presenter.stream(tf('NAME_IS_TYPING', { name: turn.agent.name }));
      let full = '';
      let streamError: unknown = null;
      let usage: RoundUsage | undefined;
      try {
        for await (const chunk of provider.stream(
          {
            ...this.buildRequest(turn.agent, turn.focus, contextSlice(session), profile, session.summary, personal),
            signal,
          },
          (u) => { usage = u; },
        )) {
          full += chunk;
          sink.delta(chunk);
        }
      } catch (err) {
        streamError = err;
      } finally {
        sink.done();
      }
      if (streamError && !signal.aborted) {
        this.presenter.error(`ошибка провайдера «${provider.id}»: ${streamError instanceof Error ? streamError.message : streamError}`);
      }
      this.presenter.turnEnd(full);
      // кэш промптов: попадание показываем сразу, промахи и мелочи молча
      if (usage && (usage.cachedTokens ?? 0) > 0) {
        this.presenter.notice(
          tf('CACHED_OF_TOTAL_INPUT_TOKENS_CAME_FROM_THE', {
            cached: (usage.cachedTokens ?? 0).toLocaleString('ru-RU'),
            total: (usage.promptTokens ?? usage.cachedTokens ?? 0).toLocaleString('ru-RU'),
          }),
        );
      }
      // накопительная статистика: раунд → session.usage (итого и срез по модели)
      if (usage) {
        const bump = (u: { promptTokens: number; cachedTokens: number; outputTokens: number; rounds: number }) => {
          u.promptTokens += usage?.promptTokens ?? 0;
          u.cachedTokens += usage?.cachedTokens ?? 0;
          u.outputTokens += usage?.outputTokens ?? 0;
          u.rounds++;
        };
        bump(session.usage ?? (session.usage = { promptTokens: 0, cachedTokens: 0, outputTokens: 0, rounds: 0 }));
        const byModel = session.usageByModel ?? (session.usageByModel = {});
        bump(byModel[provider.id] ?? (byModel[provider.id] = { promptTokens: 0, cachedTokens: 0, outputTokens: 0, rounds: 0 }));
        this.touchContext(session, usage, provider.id);
      }
      if (full.trim()) {
        session.messages.push({
          authorId: turn.agent.id,
          authorName: turn.agent.name,
          text: full.trim(),
          ts: Date.now(),
        });
        store.save(session);
        if (agentToolIds(turn.agent).length > 0 && !signal.aborted) {
          await this.runToolLoop(turn.agent, full.trim(), fullTeam, profile, provider, signal);
        }
      } else if (!signal.aborted) {
        this.presenter.notice(t('EMPTY_REPLY'));
      }
    }
    if (signal.aborted) {
      this.presenter.notice(t('ABORTED_ESC_THE_REPLIES_THAT_MADE_IT_OUT'));
      return;
    }
    // ленивые обновления памяти: максимум одна рефлексия и одно слияние за раунд
    await this.updateMemories(team, profile, plan, signal);
  }

  // ── менеджер переговорки (@менеджер) ────────────────────────────────────

  /**
   * Ответ менеджера на @менеджер. Реплика буферизуется целиком: ответ короткий,
   * а сырой JSON действий показывать нельзя. Действия исполняются по одному,
   * отчёты «✓/✗» печатаются и сохраняются в реплике — менеджер видит их итоги
   * в своей истории. Смена разговора (session.open/new) применяется строго
   * после сохранения реплики, иначе ответ ушёл бы в новый разговор.
   */
  private async managerTurn(
    text: string,
    fullTeam: Agent[],
    profile: UserProfile,
    signal: AbortSignal,
  ): Promise<void> {
    const { session, store } = requireProject(this.app);
    const agent = managerAsAgent(this.app.mgr);
    const provider = this.managerProvider();
    this.presenter.turnHeader(agent);
    const busy = this.presenter.busy(tf('NAME_IS_ON_IT', { name: agent.name }));
    // ssh-серверы для блока состояния — из project.json (toolsConfig перечитывает)
    const cfg = this.toolsConfig();
    let full = '';
    let streamError: unknown = null;
    let usage: RoundUsage | undefined;
    try {
      for await (const chunk of provider.stream({
        // язык общения добавляется хвостом: mock и пробы узнают менеджерский
        // промт по началу («Ты — менеджер переговорки»)
        system: `${MANAGER_PROMPT}\n\nОбщие правила: отвечай строго на языке: ${this.language}.`,
        messages: [
          {
            role: 'user',
            content: managerStateInput({
              team: fullTeam,
              participants: session.participants,
              sessions: store.list(),
              currentSessionId: session.id,
              sessionTitle: session.title,
              digest: session.digest,
              userName: profile.name,
              history: session.messages.slice(-12),
              request: text,
              projects: [...cfg.projects.entries()].map(([id, p]) => ({
                id,
                hosts: [...p.hosts.keys()],
                agents: fullTeam.filter((a) => a.projects?.includes(id)).map((a) => a.id),
              })),
              knownProjects: projects.listProjects().map((p) => ({
                name: p.id,
                path: p.path ?? '',
                current: Boolean(PROJECT_DIR) && basename(PROJECT_DIR) === p.id,
              })),
              operations: operationHints(),
              houseTools: this.houseTools(),
              models: [...this.app.models.entries()].map(([id, s]) => ({
                id,
                provider: String(s.config?.provider ?? ''),
                vision: s.vision === true,
                main: id === this.app.settings.model?.id || id === this.app.mgr.model.id,
              })),
              appVersion: appVersion() || undefined,
            }),
          },
        ],
        // не задано — дефолт провайдера: температура карточки модели (с учётом
        // переопределений settings.model и ссылки менеджера), как у агентов
        temperature: this.app.mgr.model.temperature,
        signal,
      }, (u) => { usage = u; })) {
        full += chunk;
      }
    } catch (err) {
      streamError = err;
    } finally {
      busy.stop();
    }
    if (streamError && !signal.aborted) {
      this.presenter.error(`ошибка провайдера «${provider.id}»: ${streamError instanceof Error ? streamError.message : streamError}`);
    }
    if (usage && (usage.cachedTokens ?? 0) > 0) {
      this.presenter.notice(
        tf('CACHED_OF_TOTAL_INPUT_TOKENS_CAME_FROM_THE', {
          cached: (usage.cachedTokens ?? 0).toLocaleString('ru-RU'),
          total: (usage.promptTokens ?? usage.cachedTokens ?? 0).toLocaleString('ru-RU'),
        }),
      );
    }
    // контекст растёт и от менеджерского хода (приветствие, роутинг) — фиксируем сразу
    if (usage) {
      this.touchContext(session, usage, provider.id);
      store.save(session);
    }
    if (signal.aborted) {
      this.presenter.notice(t('ABORTED_ESC'));
      return;
    }
    const reply = parseManagerReply(full);
    if (!reply.say && reply.actions.length === 0) {
      this.presenter.notice(t('THE_MANAGER_IS_SILENT_EMPTY_REPLY'));
      return;
    }
    if (reply.say) this.presenter.say(reply.say);

    const reports: string[] = [];
    const pendingSwitches: (() => Promise<void> | void)[] = [];
    for (const action of reply.actions) {
      let step: string | ChatEvent;
      try {
        step = await this.execManagerAction(action, fullTeam, pendingSwitches);
      } catch (err) {
        step = `✗ ${err instanceof Error ? err.message : err}`;
      }
      if (step instanceof ChatEvent) continue; // событие чата уже в хронологии репликой менеджера
      reports.push(step);
      this.presenter.notice('  ' + step);
    }

    const summary = [reply.say, ...reports].filter(Boolean).join('\n\n');
    if (summary) {
      session.messages.push({
        authorId: MANAGER_ID,
        authorName: agent.name,
        text: summary,
        ts: Date.now(),
      });
      store.save(session);
    }
    for (const apply of pendingSwitches) await apply();
  }

  /** Исполнение одного действия менеджера; то, что меняет app.session, уходит в pendingSwitches. */
  private async execManagerAction(
    action: ManagerAction,
    fullTeam: Agent[],
    pendingSwitches: (() => Promise<void> | void)[],
  ): Promise<string | ChatEvent> {
    switch (action.op) {
      case 'team.add':
        return addTeamAgent(AGENTS_DIR, action, this.app.models);
      case 'team.update':
        return updateTeamAgent(AGENTS_DIR, action.id, action.fields, this.app.models);
      case 'model.new':
      case 'model.update': {
        // тот же исполнитель, что у /model new|update: контракт валидирует
        // карточку и приводит строковые true|false/числа; карта перечитывается
        const report = action.op === 'model.new'
          ? addModelConfig(MODELS_DIR, action.id, action.fields)
          : updateModelConfig(MODELS_DIR, action.id, action.fields);
        reloadModels(this);
        return report;
      }
      case 'model.delete': {
        // те же защищённые, что у /model delete: основная, служебная, менеджерская
        const s = this.app.settings;
        const protectedIds = [s.model?.id, s.serviceModel?.id, this.app.mgr.model.id]
          .filter((x): x is string => Boolean(x));
        const report = removeModelConfig(MODELS_DIR, action.id, protectedIds);
        reloadModels(this);
        return report;
      }
      case 'chat.add': {
        const res = this.addToChat(action.who, fullTeam);
        if (!res.changed) return res.text;
        this.serviceLine(res.text);
        return new ChatEvent(res.text);
      }
      case 'chat.remove': {
        const res = this.removeFromChat(action.who, fullTeam);
        if (!res.changed) return res.text;
        this.serviceLine(res.text);
        return new ChatEvent(res.text);
      }
      case 'session.rename':
        return this.renameSession(String(action.title ?? ''));
      case 'agent.tool.add':
        return grantTool(AGENTS_DIR, action.agent, action.tool, action.card, TOOLS_DIR);
      case 'agent.tool.update':
        return grantTool(AGENTS_DIR, action.agent, action.tool, action.card ?? {}, TOOLS_DIR);
      case 'agent.tool.delete':
        return revokeTool(AGENTS_DIR, action.agent, action.tool);
      case 'project.host.add':
        return addProjectHosts(PROJECT_FILE, { [String(action.name ?? 'main')]: action });
      case 'project.open': {
        // смена проекта — после сохранения реплики менеджера в СТАРУЮ сессию:
        // разговор принадлежит своему проекту
        const target = projects.resolveProjectTarget(String(action.path ?? ''), WORKSPACE || process.cwd());
        if (!target.created && target.config.path && WORKSPACE && resolve(target.config.path) === resolve(WORKSPACE)) {
          return t('THIS_PROJECT_IS_ALREADY_OPEN');
        }
        pendingSwitches.push(() => {
          this.applyProjectSwitch(target.config.id);
        });
        return tf('SWITCHING_TO_PROJECT_LABEL_PATH', { label: target.config.id, path: target.config.path ?? '(папка ещё не задана)' });
      }
      case 'mail.add': {
        // op и name — поля действия, не ящика: в spec не идут (валидация строга к лишним полям)
        const { op, name, ...spec } = action;
        return addMailAccount(PROJECT_FILE, String(name), spec);
      }
      case 'mail.remove':
        return removeMailAccount(PROJECT_FILE, String(action.name));
      case 'messenger.add':
        return addMessengerBot(PROJECT_FILE, action.key, action.token);
      case 'messenger.remove':
        return removeMessengerBot(PROJECT_FILE, action.key);
      default:
        throw new Error(`неизвестное действие менеджера «${(action as { op: string }).op}»`);
      case 'session.list':
        return this.sessionsListText();
      case 'session.open': {
        const id = String(action.id ?? '').trim();
        const meta = this.store.list().find((s) => s.id === id);
        if (!meta) return tf('NO_SESSION_WITH_ID_ID_SEE_SESSIONS_2', { id });
        if (meta.id === this.app.session?.id) return tf('SESSION_TITLE_IS_ALREADY_OPEN', { title: meta.title });
        const loaded = this.store.load(meta.id);
        if (!loaded) return tf('FAILED_TO_READ_SESSION_TITLE', { title: meta.title });
        pendingSwitches.push(() => {
          this.openSession(loaded);
        });
        return tf('OPENING_SESSION_TITLE_N_MSGS', { title: loaded.title, n: loaded.messages.length });
      }
      case 'session.new': {
        const title = (action.title ?? '').trim() || 'Новый разговор';
        const known = new Set(fullTeam.map((a) => a.id as string));
        const ids = [...new Set((action.participants ?? []).map((p) => String(p).trim()).filter(Boolean))]
          .filter((id) => known.has(id));
        pendingSwitches.push(() => {
          const old = this.app.session;
          const store = requireProject(this.app).store;
          const created = store.create();
          created.title = title;
          // новый разговор без явных участников — один на один с менеджером
          created.participants = ids.length > 0 ? ids : [MANAGER_ID];
          store.save(created);
          this.app.session = created;
          this.queueFlush(old!);
          this.presenter.notice(tf('NEW_SESSION_TITLE_ID', { title: created.title, id: created.id }));
          const line = this.participantsLine(created);
          if (line) this.presenter.notice(`  ${t('MEMBERS')} ${line}`);
        });
        return tf('CREATING_SESSION_TITLE_CHAT', { title, chat: ids.length ? tf('IN_CHAT_IDS', { ids: ids.join(', ') }) : '' });
      }
      case 'session.delete':
        return this.deleteSessionById(String(action.id ?? ''));
      case 'goal.set': {
        // тот же дефолт бюджета, что у /goal set: настройка goalMaxRounds
        const rounds = typeof action.maxRounds === 'number' && Number.isInteger(action.maxRounds) && action.maxRounds > 0
          ? action.maxRounds
          : loadSettings(SETTINGS_FILE, 0).goalMaxRounds;
        return this.setGoal(String(action.text), rounds);
      }
      case 'goal.cancel':
        return this.cancelGoal();
    }
  }

  // ── операции над разговорами (команды и действия менеджера) ────────────

  /** Список разговоров текстом — для действия session.list. */
  sessionsListText(): string {
    const list = this.store.list();
    if (list.length === 0) return t('NO_SESSIONS_YET');
    return list
      .map((s) => `${s.id} — ${s.title} — ${tf('N_MSGS', { n: s.count })}${s.id === this.session.id ? ` (${t('CURRENT')})` : ''}`)
      .join('\n');
  }

  /** Подтверждение для команд уровня ядра (импорт дома и т.п.) — через Presenter. */
  async confirmAction(label: string, desc = ''): Promise<boolean> {
    const agent = managerAsAgent(this.app.mgr);
    return this.presenter.confirm({ label, desc, who: { id: agent.id, name: agent.name, color: agent.color } });
  }

  /** Удаление разговора по id; текущий — отказ: сначала /session close. */
  deleteSessionById(id: string): string {
    const meta = this.store.list().find((s) => s.id === id);
    if (!meta) return tf('NO_SESSION_WITH_ID_ID_SEE_SESSIONS_2', { id });
    if (this.app.session && meta.id === this.app.session.id) {
      return t('THE_CURRENT_SESSION_CANNOT_BE_DELETED_SESSION_CLOSE');
    }
    this.store.delete(meta.id);
    return tf('SESSION_TITLE_ID_DELETED', { title: meta.title, id: meta.id });
  }

  /** /session close: разговор закрыт, проект остаётся открытым. */
  closeSession(): string {
    if (!this.app.store) return t('NO_PROJECT_IS_OPEN');
    if (!this.app.session) return t('NO_SESSION_IS_OPEN_ANYWAY_SESSIONS_SESSION_NEW');
    this.queueFlush(this.app.session);
    this.app.session = null;
    return t('SESSION_CLOSED_PROJECT_STAYS_OPEN_SESSIONS_SESSION_NEW');
  }

  // ── проекты: реестр — папки в доме (projects/<id>/) ─────────────────────

  /** project.close: остаёмся без проекта — состояние голого запуска. */
  closeProject(): string {
    if (!this.app.store) return t('NO_PROJECT_IS_OPEN_ANYWAY');
    if (this.app.session) this.queueFlush(this.app.session, this.app.store);
    this.app.store = null;
    this.app.session = null;
    clearProjectRoot();
    return t('PROJECT_CLOSED_PROJECTS_PROJECT_NEW_ID_FOLDER_OR');
  }

  /** project.open: имя проекта или путь к папке (незарегистрированная — регистрируем).
   *  announce=false — вызов из команды: подтверждением служит сам ответ, без заметки-дубля. */
  switchProject(arg: string, announce = true): string {
    const { config, created } = projects.resolveProjectTarget(arg, WORKSPACE || process.cwd());
    const registered = created
      ? tf('REGISTERED_THE_PROJECT_ID_IN_THE_HOME_THE', { id: config.id })
      : '';
    return registered + this.applyProjectSwitch(config.id, announce);
  }

  /** project.new: создать проект (+ рабочую папку, если задана) и открыть его;
   *  без имени id берётся из папки, без папки — штамп как у разговоров. */
  newProject(name: string | null, pathRaw: string | null, announce = true): string {
    const cfg = projects.createProject(name, pathRaw);
    return tf('CREATED_THE_PROJECT_ID_THE_DATA_LIVES_IN', { id: cfg.id }) + this.applyProjectSwitch(cfg.id, announce);
  }

  /** project.remove: удалить проект ИЗ ДОМА (projects/<id>/); рабочая папка не трогается. */
  deleteProject(arg: string): string {
    const id = this.projectIdByArg(arg);
    projects.removeProject(id, PROJECT_DIR);
    return tf('PROJECT_ID_REMOVED_FROM_THE_HOME_THE_WORKING', { id });
  }

  /** project.rename: переименовать ТЕКУЩИЙ проект (папка в доме + id в project.json). */
  renameCurrentProject(newIdRaw: string): string {
    if (!PROJECT_DIR) throw new Error(t('NO_OPEN_PROJECT_START_WITH_PROJECT_NEW_ID'));
    const oldId = basename(PROJECT_DIR);
    const cfg = projects.renameProject(oldId, newIdRaw);
    // слой путей указывал в старую папку — перепривязываем к новой; магазин
    // держит путь к sessions/ с момента создания — пересобираем и перечитываем
    // открытый разговор, чтобы запись пошла в переименованную папку
    setProjectRoot(join(PROJECTS_DIR, cfg.id), cfg.path ?? '');
    if (this.app.store) {
      this.app.store = new SessionStore(SESSIONS_DIR);
      const reread = this.app.session ? this.app.store.load(this.app.session.id) : null;
      if (reread) this.app.session = reread;
    }
    return tf('PROJECT_RENAMED_OLD_NEW', { old: oldId, new: cfg.id });
  }

  /** project.path: сменить рабочую папку текущего проекта (папка создаётся). */
  repointProject(pathRaw: string): string {
    if (!PROJECT_DIR) throw new Error(t('NO_OPEN_PROJECT_START_WITH_PROJECT_NEW_ID'));
    const cfg = projects.loadProjectConfig(basename(PROJECT_DIR));
    if (!cfg) throw new Error(t('THE_CURRENT_PROJECT_JSON_CAN_NOT_BE_READ'));
    projects.setProjectPath(cfg, pathRaw);
    setProjectRoot(PROJECT_DIR, cfg.path ?? '');
    return tf('WORKING_FOLDER_OF_PROJECT_ID_PATH', { id: cfg.id, path: WORKSPACE });
  }

  /** Имя проекта по аргументу remove: id или путь из реестра; НЕ регистрирует новые. */
  private projectIdByArg(arg: string): string {
    const raw = arg.trim().replace(/^["']|["']$/g, '');
    if (!raw) throw new Error(t('GIVE_A_PROJECT_PROJECT_DELETE_ID_PATH_LIST'));
    const found = projects.listProjects().find(
      (p) => p.id.toLowerCase() === raw.toLowerCase() || (p.path && resolve(p.path) === resolve(projects.expandHome(raw))),
    );
    if (!found) throw new Error(tf('NO_PROJECT_RAW_SEE_PROJECTS', { raw }));
    return found.id;
  }

  /**
   * Применить смену проекта: отметить lastOpened, слой путей (PROJECT_DIR,
   * WORKSPACE, SESSIONS_DIR), магазин разговоров; открыть последний разговор
   * или создать новый. Итоги старого разговора вливаются в общую память ДО
   * подмены хранилища: фоновое вливание должно писать в проект, где разговор жил.
   */
  applyProjectSwitch(id: string, announce = true): string {
    const dir = join(PROJECTS_DIR, id);
    const cfg = projects.loadProjectConfig(id);
    if (!cfg) throw new Error(tf('PROJECT_ID_CAN_NOT_BE_READ_NO_PROJECT', { id }));
    // «уже открыт» — про состояние ЭТОГО движка, а не глобального слоя путей:
    // paths общие на процесс, а магазинов может быть несколько (второй serve
    // в том же процессе стартует без проекта при уже выставленном PROJECT_DIR)
    if (this.app.store && this.app.session && PROJECT_DIR && resolve(PROJECT_DIR) === resolve(dir)) {
      return tf('THIS_PROJECT_IS_ALREADY_OPEN_ID', { id: cfg.id });
    }
    if (this.app.store && this.app.session) this.queueFlush(this.app.session, this.app.store);
    projects.touchProject(id);
    setProjectRoot(dir, cfg.path ?? '');
    this.app.store = new SessionStore(SESSIONS_DIR);
    const list = this.app.store.list();
    this.app.session = list.length > 0 ? this.app.store.load(list[0].id) ?? this.app.store.create() : this.app.store.create();
    if (announce) this.presenter.notice(`  ${t('PROJECT')} ${cfg.id}${WORKSPACE ? ` · ${WORKSPACE}` : ''}`);
    this.presenter.notice(tf('OPENED_SESSION_TITLE_N_MSGS', { title: this.app.session.title, n: this.app.session.messages.length }));
    this.presenter.sessionOpened(this.app.session);
    return tf('PROJECT_ID_WS', { id: cfg.id, ws: WORKSPACE ? ` (${WORKSPACE})` : '' });
  }

  /**
   * /session update: переименовать текущий разговор. С title=… — напрямую;
   * без полей менеджер придумывает по дайджесту, а если его ещё нет —
   * по первому и последним сообщениям.
   */
  async renameSession(name?: string): Promise<string> {
    const clean = (name ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) {
      const context = this.session.digest
        ? `Вот краткое содержание разговора:\n${this.session.digest}`
        : this.namingContextFromMessages();
      const invented = await this.generateSessionName(`Нужно дать имя сессии.\n${context}`);
      if (!invented) return t('COULDN_T_INVENT_A_TITLE_NAME_IT_YOURSELF');
      return this.applySessionName(invented);
    }
    return this.applySessionName(clean.slice(0, 80) + (clean.length > 80 ? '…' : ''));
  }

  private applySessionName(title: string): string {
    this.session.title = title;
    this.store.save(this.session);
    return tf('SESSION_RENAMED_TITLE', { title });
  }

  /** Первое и последние сообщения — запасной контекст, когда дайджеста ещё нет. */
  private namingContextFromMessages(): string {
    const msgs = this.session.messages.filter((m) => m.authorId !== 'tool');
    const first = msgs[0]?.text ?? '(пусто)';
    const last = msgs.slice(-3).map((m) => `${m.authorName}: ${m.text}`).join('\n');
    return `Вот первое сообщение разговора:\n${first.slice(0, 600)}\n\nИ последние сообщения:\n${last.slice(0, 600)}`;
  }

  /** Просит менеджера придумать короткое имя; неудача — null (останется прежнее). */
  private async generateSessionName(context: string): Promise<string | null> {
    const busy = this.presenter.busy(t('COMING_UP_WITH_A_SESSION_TITLE'));
    try {
      let full = '';
      for await (const chunk of this.serviceModel().stream({
        system: NAMING_SYSTEM,
        messages: [{ role: 'user', content: context }],
        temperature: 0.4,
        maxTokens: 64,
      })) {
        full += chunk;
      }
      const name = full.replace(/[«»"']/g, '').replace(/\s+/g, ' ').trim().replace(/[.…]+$/, '').trim();
      if (!name) return null;
      return name.slice(0, 60) + (name.length > 60 ? '…' : '');
    } catch {
      return null; // имя не критично: останется прежнее
    } finally {
      busy.stop();
    }
  }

  /** /session open <id>: открыть разговор по id; нет такого — заметка. */
  openSessionById(id: string): void {
    if (!this.app.store) {
      throw new Error(t('NO_OPEN_PROJECT_START_WITH_PROJECT_NEW_ID'));
    }
    const loaded = this.app.store.load(id.trim());
    if (!loaded) {
      this.presenter.notice(tf('NO_SESSION_WITH_ID_ID_CHECK_THE_LIST', { id }));
      return;
    }
    this.openSession(loaded);
  }

  /** Переключение на другой разговор: общее для /session и действия менеджера session.open. */
  openSession(loaded: Session): void {
    const current = this.app.session;
    if (loaded.id !== current?.id) {
      this.app.session = loaded;
      if (current) this.queueFlush(current);
    }
    this.presenter.notice(tf('OPENED_SESSION_TITLE_N_MSGS', { title: loaded.title, n: loaded.messages.length }));
    const line = this.participantsLine(loaded);
    if (line) this.presenter.notice(`  ${t('MEMBERS')} ${line}`);
    this.presenter.sessionOpened(loaded);
  }

  /** Служебное сообщение о событии чата: идёт в общую хронологию разговора
   *  (session.messages), автор — менеджер (модератор беседы), а не журнал
   *  уведомлений. GUI получит реплику с ближайшим state; терминалу строка
   *  показывается живьём через presenter.service. */
  serviceLine(text: string): void {
    const mgr = managerAsAgent(this.app.mgr);
    this.session.messages.push({
      authorId: mgr.id,
      authorName: mgr.name,
      text,
      ts: Date.now(),
    });
    this.store.save(this.session);
    this.presenter.service?.(text);
  }

  /** Позвать участника в текущий чат: общее для /session agent add и действия менеджера chat.add.
   *  changed — состав чата реально поменялся (только тогда это событие хроники). */
  addToChat(id: string, fullTeam: Agent[]): { text: string; changed: boolean } {
    const agent = findAgentById(fullTeam, id);
    if (!agent) return { text: tf('NO_AGENT_WITH_ID_ID_SEE_AGENTS', { id }), changed: false };
    if (chatTeam(this.session, fullTeam).some((a) => a.id === agent.id)) {
      return { text: tf('NAME_IS_ALREADY_IN_THE_CHAT', { name: agent.name }), changed: false };
    }
    const session = this.session;
    session.participants ??= fullTeam.map((a) => a.id);
    if (!session.participants.includes(agent.id)) session.participants.push(agent.id);
    this.store.save(session);
    return { text: tf('NAME_JOINED_THE_CHAT', { name: agent.name }), changed: true };
  }

  /** Вывести участника из чата: общее для /session agent delete и действия менеджера chat.remove. */
  removeFromChat(id: string, fullTeam: Agent[]): { text: string; changed: boolean } {
    const kicked = findAgentById(fullTeam, id);
    if (!kicked) return { text: tf('NO_AGENT_WITH_ID_ID_SEE_AGENTS', { id }), changed: false };
    const session = this.session;
    if (!chatTeam(session, fullTeam).some((a) => a.id === kicked.id)) {
      return { text: tf('NAME_IS_NOT_IN_THIS_CHAT_ANYWAY', { name: kicked.name }), changed: false };
    }
    // материализуем явный список, иначе выгон «вернул» бы всю команду
    session.participants ??= fullTeam.map((a) => a.id);
    const rest = session.participants.filter((id) => id !== kicked.id);
    // без агентов чат не бросаем: остаётся консьерж — он позовёт кого нужно
    const byId = new Set(fullTeam.map((a) => a.id));
    session.participants = rest.some((id) => byId.has(id)) ? rest : [MANAGER_ID];
    this.store.save(session);
    const alone = session.participants.length === 1 && session.participants[0] === MANAGER_ID;
    return {
      text:
        tf('NAME_LEFT_THE_CHAT_THE_REPLIES_WILL', { name: kicked.name }) +
        (alone ? ' ' + t('NOBODY_IS_IN_THE_CHAT_EXCEPT_THE_MANAGER') : ''),
      changed: true,
    };
  }

  /** Смена основной модели агентов: пишет settings.model в settings.json; false — нет такой id. */
  setModel(id: string): boolean {
    if (!this.app.models.has(id)) return false;
    this.app.settings.model = { ...this.app.settings.model, id };
    try {
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
      raw.model = this.app.settings.model;
      writeFileSync(SETTINGS_FILE, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    } catch (err) {
      throw new Error(`не удалось сохранить ${SETTINGS_FILE}: ${err instanceof Error ? err.message : err}`);
    }
    return true;
  }

  /** /profile update поле=значение: точечная правка профиля (name, about). */
  updateProfile(fields: { name?: string; about?: string }): string {
    const next = { ...this.app.profile };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      (next as Record<string, string | undefined>)[k] = v;
    }
    if (!next.name) return t('A_NAME_IS_REQUIRED_SET_NAME');
    this.app.profile = next as UserProfile;
    try {
      writeFileSync(USER_FILE, JSON.stringify(this.app.profile, null, 2) + '\n');
    } catch (err) {
      throw new Error(`не удалось сохранить ${USER_FILE}: ${err instanceof Error ? err.message : err}`);
    }
    return (
      tf('REMEMBERED_YOU_ARE_NAME', { name: this.app.profile.name }) +
      `. ${t('THE_TEAM_NOW_KNOWS_WHO_YOU_ARE')}`
    );
  }

  /** Имена участников чата для подписи (без чтения agents.json возвращает null). */
  participantsLine(session: Session): string | null {
    if (!session.participants || session.participants.length === 0) return null;
    if (session.participants.length === 1 && session.participants[0] === MANAGER_ID) {
      return tf('NAME_CONFIGURE_VIA_CONVERSATION', { name: this.app.mgr.name });
    }
    try {
      const full = loadTeam(AGENTS_DIR);
      return chatTeam(session, full).map((a) => a.name).join(', ');
    } catch {
      return null;
    }
  }

  // ── приветствие консьержа ───────────────────────────────────────────────

  /** Реплика-приветствие менеджера в новом (пустом) разговоре. */
  async welcomeManager(signal: AbortSignal): Promise<void> {
    // язык — свежий из settings.json (пустой — языка интерфейса): приветствие
    // идёт до первого раунда, поле по-другому остаётся с зашитым «русский»
    const { language, ui } = loadSettings(SETTINGS_FILE, 0);
    this.language = language ?? conversationLanguage(ui, DT_HOME);
    let team: Agent[] = [];
    try {
      team = this.team();
    } catch {
      // нет agents.json — менеджер в приветствии сам объяснит, что дальше
    }
    await this.managerTurn(WELCOME_REQUEST, team, this.app.profile, signal);
  }

  /** /session new [id]: новый разговор один на один с менеджером + приветствие; id не задан — автоштамп. */
  async newSession(signal: AbortSignal, id?: string): Promise<void> {
    if (!this.app.store) {
      throw new Error(t('NO_OPEN_PROJECT_START_WITH_PROJECT_NEW_ID'));
    }
    const store = this.app.store;
    const old = this.app.session;
    const created = store.create(id);
    created.participants = [MANAGER_ID];
    store.save(created);
    this.app.session = created;
    this.presenter.notice(tf('NEW_SESSION_ID', { id: created.id }));
    this.presenter.notice(tf('IN_THE_CHAT_NAME_ASK_TO_INVITE', { name: this.app.mgr.name }));
    if (old) this.queueFlush(old);
    await this.welcomeManager(signal);
  }

  /** Старт приложения на пустом разговоре: менеджер здоровается сам, как по /new. */
  async startupWelcome(signal: AbortSignal): Promise<void> {
    const { session, store } = requireProject(this.app);
    session.participants = [MANAGER_ID];
    store.save(session);
    this.presenter.notice(tf('IN_THE_CHAT_NAME_ASK_TO_INVITE', { name: this.app.mgr.name }));
    await this.welcomeManager(signal);
  }

  // ── инструменты ─────────────────────────────────────────────────────────

  /** «Тело» действия для check(): то, по каким словам тул решает свою судьбу. */
  private checkTargetOf(action: Action): string {
    if (action.kind === 'file' || action.kind === 'look') return action.path;
    if (action.kind === 'image') return action.params.prompt;
    return action.command; // run, ssh, tool
  }

  /** «Тело» действия для run(): что тул получает в body (у file это содержимое файла). */
  private actionBody(action: Action): string {
    if (action.kind === 'file') return action.content;
    if (action.kind === 'look') return action.question;
    if (action.kind === 'image') {
      const p = action.params;
      const lines = [
        p.prompt && `prompt: ${p.prompt}`,
        p.size && `size: ${p.size}`,
        p.n && `n: ${p.n}`,
        p.steps && `steps: ${p.steps}`,
        p.guidance && `guidance: ${p.guidance}`,
        p.seed !== undefined && `seed: ${p.seed}`,
        p.refs?.length && `refs: ${p.refs.join(', ')}`,
      ].filter(Boolean);
      return lines.join('\n');
    }
    return action.command; // run, ssh, tool
  }

  /** Карточки → экземпляры Tool для агента (пересобирается на каждый раунд). */
  private toolsetFor(agent: Agent, cfg: ToolsConfig, signal: AbortSignal): Map<string, Tool> {
    return buildToolset(agent, cfg, this.toolContext(), signal, this.userTools, this.userToolCards, this.session.id);
  }

  /** Мосты к хосту для тулов: рабочая папка, полный конвейер shell, http и живой вопрос. */
  private runContext(
    agent: Agent,
    action: Action,
    cfg: ToolsConfig,
    signal: AbortSignal,
    toolset: Map<string, Tool>,
  ): ToolRunContext {
    const who: SpeakerRef = agent;
    const base: ToolCheckContext = {
      cwd: workspaceFor(agent, action, cfg),
      projectHome: PROJECT_DIR || null,
      project: action.project,
      arg:
        action.kind === 'file' || action.kind === 'look'
          ? action.path
          : action.kind === 'ssh'
            ? action.host
            : undefined,
    };
    return {
      ...base,
      workspaceFile: (rel) => {
        const abs = safePath(base.cwd, rel);
        if (!abs) throw new Error(`путь «${rel}» вне рабочей папки — работа только внутри неё`);
        return abs;
      },
      projectFile: (rel) => {
        if (!PROJECT_DIR) throw new Error('нет открытого проекта — прикладных папок нет (inbox, mail, images)');
        const abs = safePath(PROJECT_DIR, rel);
        if (!abs) throw new Error(`путь «${rel}» вне папки проекта в доме (${PROJECT_DIR})`);
        return abs;
      },
      run: async (command) => {
        // полный конвейер shell-тула: check тула → живой вопрос → запуск
        const shell = toolset.get('shell');
        if (!shell) return { ok: false, output: 'тул shell этому агенту не включён' };
        const verdict = shell.check(command, base);
        if (typeof verdict === 'object')
          return { ok: false, output: `отказ: shell отклонил команду «${command}»: ${verdict.deny}` };
        if (verdict === 'deny') return { ok: false, output: `отказ: shell отклонил команду «${command}»` };
        if (verdict === 'ask' && !(await this.presenter.confirm({ label: t('COMMAND'), desc: tf('COMMAND_CMD', { cmd: command }), who }))) {
          return { ok: false, output: 'отклонено пользователем' };
        }
        const r = await executeRunAction({ kind: 'run', command, project: base.project }, cfg, signal, agent);
        return { ok: r.ok, output: r.output };
      },
      http: async (url, body) => {
        try {
          const res = await fetch(url, {
            method: body === undefined ? 'GET' : 'POST',
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
          });
          let output = await res.text();
          if (output.length > cfg.maxOutputChars) {
            output = output.slice(0, cfg.maxOutputChars) + `… (обрезано, всего ${output.length} символов)`;
          }
          return { ok: res.ok, output: output || `(HTTP ${res.status})` };
        } catch (err) {
          return { ok: false, output: `ошибка http: ${err instanceof Error ? err.message : err}` };
        }
      },
      confirm: async (text) => {
        return this.presenter.confirm({ label: t('TOOL_QUESTION'), desc: text, who });
      },
    };
  }

  /**
   * Цикл инструментов: разбираем блоки ```file / ```run / ```<тул> из ответа
   * агента, спрашиваем вердикт check() у тула ('allow' — молча, 'deny' — отказ,
   * 'ask' — живой y/n), выполняем, отдаём результаты в историю и просим агента
   * продолжить — до трёх итераций или пока блоки не кончатся.
   */
  private async runToolLoop(
    agent: Agent,
    firstText: string,
    fullTeam: Agent[],
    profile: UserProfile,
    provider: LLMProvider,
    signal: AbortSignal,
  ): Promise<void> {
    const { session, store } = requireProject(this.app);
    const cfg = this.toolsConfig();
    let toolset: Map<string, Tool>;
    try {
      toolset = this.toolsetFor(agent, cfg, signal);
    } catch (err) {
      // кривая карточка или код тула: конфигурация чинится в файлах, раунд громко об этом скажет
      this.presenter.notice(tf('TOOLS_NOT_ASSEMBLED_ERR', { err: err instanceof Error ? err.message : String(err) }));
      return;
    }
    // виды тул-блоков, которые движок исполняет, — ровно тулы агента: у него
    // есть встроенные (files, docs, ocr, …), у файлов-тулов имена из tools/;
    // чужой блок остаётся текстом, гейт checkPermission его бы всё равно не пустил
    const toolIds = [...toolset.keys()];
    let text = firstText;
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS && !signal.aborted; iteration++) {
      const actions = parseActions(text, toolIds);
      if (actions.length === 0) break;
      const results: string[] = [];
      for (const action of actions) {
        if (signal.aborted) break;
        // структурные гейты до всего остального: чужой проект/хост/тул — сразу отказ
        const gate = checkPermission(agent, action, cfg);
        if (gate) {
          results.push(`⛔ ${describeAction(action)} — запрещено: ${gate}`);
          continue;
        }
        const tool = toolset.get(action.kind === 'tool' ? action.tool : action.kind === 'file' ? 'files' : action.kind === 'run' ? 'shell' : action.kind)!;
        const verdict = tool.check(this.checkTargetOf(action), {
          cwd: workspaceFor(agent, action, cfg),
          projectHome: PROJECT_DIR || null,
          project: action.project,
          arg:
            action.kind === 'file' || action.kind === 'look'
              ? action.path
              : action.kind === 'ssh'
                ? action.host
                : undefined,
        });
        if (typeof verdict === 'object') {
          results.push(`⛔ ${describeAction(action)} — тул отклонил: ${verdict.deny}`);
          continue;
        }
        if (verdict === 'deny') {
          results.push(`⛔ ${describeAction(action)} — тул отклонил действие`);
          continue;
        }
        if (verdict === 'ask') {
          // автономный ход (авто-режим или активная цель): вопросы решаются сами
          if (this.autoMode) {
            results.push(`🤖 автономно: разрешаю ${describeAction(action)}`);
          } else if (this.session.goal?.status === 'active') {
            results.push(`🎯 цель: разрешаю ${describeAction(action)}`);
          } else {
            const ok = await this.presenter.confirm({ label: toolLabelOf(action), desc: describeAction(action), who: agent });
            if (!ok) {
              results.push(`⛔ ${describeAction(action)} — отклонено пользователем`);
              continue;
            }
          }
        }
        try {
          const out = await tool.run(this.actionBody(action), this.runContext(agent, action, cfg, signal, toolset));
          results.push(`✅ ${out}`);
        } catch (err) {
          results.push(`❌ ${err instanceof Error ? err.message : err}`);
        }
      }
      if (results.length === 0) break;
      this.presenter.toolLines(results);
      session.messages.push({
        authorId: 'tool',
        authorName: '⚙ инструменты',
        text: results.join('\n\n'),
        ts: Date.now(),
      });
      store.save(session);
      const follow = await this.streamFollowUp(agent, fullTeam, profile, provider, signal);
      if (!follow) break;
      session.messages.push({
        authorId: agent.id,
        authorName: agent.name,
        text: follow,
        ts: Date.now(),
      });
      store.save(session);
      text = follow;
    }
  }

  /** Договорращивает ответ агента после показа результатов его действий. */
  private async streamFollowUp(
    agent: Agent,
    fullTeam: Agent[],
    profile: UserProfile,
    provider: LLMProvider,
    signal: AbortSignal,
  ): Promise<string> {
    const personal = memoryBlock(agent, this.session, fullTeam, this.app.memory, profile.name);
    const sink = this.presenter.stream(`${agent.name} продолжает…`);
    let full = '';
    try {
      for await (const chunk of provider.stream({
        ...this.buildRequest(
          agent,
          TOOL_FOLLOW_FOCUS,
          contextSlice(this.session),
          profile,
          this.session.summary,
          personal,
        ),
        signal,
      })) {
        full += chunk;
        sink.delta(chunk);
      }
    } catch (err) {
      if (!signal.aborted) {
        this.presenter.notice(tf('FAILED_TO_GET_A_CONTINUATION_ERR', { err: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      sink.done();
    }
    return full.trim();
  }

  // ── память ──────────────────────────────────────────────────────────────

  /**
   * Субъективная память после раунда. Экономика: в обычном раунде — 0 вызовов;
   * когда разговор вырос на ~12 сообщений — одна рефлексия самого устаревшего
   * из отвечавших; и максимум одно слияние «другие разговоры» одному агенту.
   */
  private async updateMemories(
    team: Agent[],
    profile: UserProfile,
    plan: PlanResult,
    signal: AbortSignal,
  ): Promise<void> {
    const { session } = requireProject(this.app);

    // 1) память разговора
    const speakers = plan.turns
      .map((t) => t.agent)
      .filter((a) => needsReflection(session, a.id))
      .sort((a, b) =>
        (session.memories?.[a.id]?.updatedAtMsg ?? 0) - (session.memories?.[b.id]?.updatedAtMsg ?? 0),
      );
    if (speakers.length > 0) {
      const agent = speakers[0];
      const from = session.memories?.[agent.id]?.updatedAtMsg ?? 0;
      const window = Math.max(from, session.messages.length - REFLECT_WINDOW);
      const dialog = session.messages.slice(window);
      const busy = this.presenter.busy(`${agent.name} осмысливает разговор…`);
      try {
        const memory = await reflectSessionMemory(
          agent,
          session.memories?.[agent.id],
          dialog,
          profile.name,
          team,
          this.agentProvider(agent),
          signal,
        );
        session.memories = { ...session.memories, [agent.id]: { ...memory, updatedAtMsg: session.messages.length } };
        this.store.save(session);
        this.presenter.notice(tf('NAME_REFLECTED_ON_THE_SESSION_MEMORY_UPDATED', { name: agent.name }));
      } catch (err) {
        if (!signal.aborted) {
          this.presenter.notice(tf('FAILED_TO_UPDATE_THE_NAME_MEMORY_ERR', { name: agent.name, err: err instanceof Error ? err.message : String(err) }));
        }
      } finally {
        busy.stop();
      }
    }
    if (signal.aborted) return;

    // 2) память о других разговорах — одному «устаревшему» агенту за раунд
    const stale = team.find((a) => needsGlobalMerge(this.app.memory, a.id));
    if (stale) {
      try {
        const otherChats = await mergeOtherChats(
          this.app.memory.agents[stale.id]?.otherChats,
          this.app.memory.log.map((e) => `«${e.title}»: ${e.digest}`),
          this.agentProvider(stale),
          signal,
        );
        this.app.memory.agents[stale.id] = {
          ...this.app.memory.agents[stale.id],
          otherChats,
          seenVersion: this.app.memory.logVersion,
        };
        saveTeamMemory(MEMORY_FILE, this.app.memory);
        this.presenter.notice(tf('NAME_REFRESHED_THEIR_MEMORY_OF_OTHER_SESSIONS', { name: stale.name }));
      } catch {
        // не критично: попробуем в следующем раунде
      }
    }
  }

  /**
   * Вливание итогов разговора в общую память команды: конспект — в лог,
   * слияние — в общий документ. quiet — фоновый режим без единой печати
   * (при /new и /session); onlyIfFreshDigest — не делать дорогой постройки
   * конспекта (при /exit: нет свежего конспекта — отложим на следующий /new).
   */
  async flushChatMemory(
    target: Session = requireProject(this.app).session,
    opts: { quiet?: boolean; onlyIfFreshDigest?: boolean } = {},
    store: SessionStore = requireProject(this.app).store,
  ): Promise<void> {
    const session = target;
    const quiet = opts.quiet ?? false;
    if (session.messages.length < 6) return; // нечего запоминать
    const fresh = !!(session.digest && session.digestAtCount !== undefined
      && session.messages.length - session.digestAtCount < 10);
    if (fresh && session.digestInLog) return; // с прошлой выгрузки ничего нового
    if (opts.onlyIfFreshDigest && !fresh) {
      this.presenter.notice(t('TAKEAWAYS_FROM_THIS_SESSION_WILL_MERGE_INTO_THE'));
      return;
    }

    const digest = fresh && session.digest
      ? session.digest
      : await this.getSessionDigest(session, AbortSignal.timeout(60_000), this.app.profile.name, quiet, store);
    if (!digest) return;

    appendChatToLog(this.app.memory, session.title, digest);
    session.digestInLog = true;
    store.save(session);
    try {
      if (!quiet) this.presenter.notice(t('SAVING_THE_SESSION_TAKEAWAYS_TO_THE_TEAM_SHARED'));
      this.app.memory.shared = await mergeShared(this.app.memory.shared, session.title, digest, this.resolveProvider(undefined));
      saveTeamMemory(MEMORY_FILE, this.app.memory);
      if (!quiet) this.presenter.notice(t('TAKEAWAYS_MERGED_INTO_THE_TEAM_SHARED_MEMORY'));
    } catch (err) {
      if (!quiet) this.presenter.notice(tf('FAILED_TO_UPDATE_THE_SHARED_MEMORY_ERR', { err: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Вливание — в хранилище, где живёт разговор: при смене проекта магазин
   *  подменяется, и фоновая задача не должна писать в чужой проект. */
  private queueFlush(session: Session, store: SessionStore = requireProject(this.app).store): void {
    this.flushChain = this.flushChain
      .then(() => this.flushChatMemory(session, { quiet: true }, store))
      .catch(() => {
        // фоновое вливание не критично: конспект не помечен как влитый и повторится при следующем закрытии
      });
  }
}

const KIND_LABEL: Record<Action['kind'], string> = {
  file: 'Запись файла',
  run: 'Команда',
  ssh: 'Команда по ssh',
  look: 'Просмотр картинки',
  image: 'Генерация изображений',
  tool: 'Кастомный тул',
};

function toolLabelOf(action: Action): string {
  return action.kind === 'tool' ? `Тул «${action.tool}»` : KIND_LABEL[action.kind];
}
