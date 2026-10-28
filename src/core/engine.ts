import { findMentions, loadTeam, loadUserProfile, MENTION_TRIGGERS } from '../agents.js';
import {
  MANAGER_ID,
  MANAGER_PROMPT,
  MANAGER_ROLE,
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
  updateTeamAgent,
} from '../manager.js';
import {
  actionsHint,
  checkPermission,
  describeAction,
  executeRunAction,
  loadToolsConfig,
  parseActions,
  safePath,
  workspaceFor,
  type Action,
  type ToolsConfig,
  type ToolContext,
} from '../actions.js';
import {
  agentToolConfig,
  agentToolIds,
  type Tool,
  type ToolCheckContext,
  type ToolFactory,
  type ToolRunContext,
} from '../tools-api.js';
import { buildToolset, loadUserTools } from '../tools-registry.js';
import { operationHints, runOperationText } from './operations.js';
import { basename, join, resolve } from 'node:path';
// все пути приложения — только в paths.ts (PROJECT_DIR и др. — живые привязки)
import {
  AGENTS_DIR,
  MEMORY_FILE,
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
import { instantiateModel, resolveRefId, type ImageProviderStatus, type ProviderStatus } from '../providers/registry.js';
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
  UserProfile,
} from '../types.js';
import type { Presenter, SpeakerRef } from './presenter.js';
import { t, tf } from '../i18n.js';

/** Общие правила агента; язык общения — из settings.json, в промт идёт как есть. */
const commonRules = (language: string) =>
  `Общие правила: отвечай строго на языке: ${language}, от первого лица, коротко и живо (обычно 2–5 предложений), ` +
  'без заголовков и списков, если тебя прямо не просят. Не выходи из роли и не упоминай, что ты ИИ. ' +
  'Если не согласен с коллегой — говори об этом прямо и обращайся к нему по имени.';

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
    throw new Error(t('нет открытого проекта — сначала /project new <id> [папка] или /project open <id|путь>'));
  }
  return { store: app.store, session: app.session };
}

/** Разговор обязателен: проект открыт, но разговор закрыт (/session close). */
export function requireSession(app: App): { store: SessionStore; session: Session } {
  const found = app.store ? (app.session ? { store: app.store, session: app.session } : null) : null;
  if (!found) {
    throw new Error(t('нет открытого разговора — /session new [id] или /session open <id>; список — /sessions'));
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

/**
 * Ядро приложения: раунды, менеджер, инструменты, память. Всё, что видит
 * человек, проходит через Presenter — ядро ничего не печатает само.
 */
export class Engine {
  /** Пользовательские тулы (tools/*.ts), перечитываются раз в раунд. */
  private userTools = new Map<string, ToolFactory>();

  /** Очередь фоновых вливаний: закрывают чаты подряд — merges не перетирают друг друга. */
  private flushChain: Promise<void> = Promise.resolve();

  /** Язык общения из settings.json — перечитывается каждый раунд (как профиль). */
  private language = 'русский';

  /** Автономный режим: вопросы человеку решаются сами, раунды продолжаются. */
  autoMode = false;
  /** Сколько автоматических ходов осталось до остановки (лимит безопасности). */
  autoLeft = 0;
  /** Включить/выключить автономный режим с лимитом ходов (/auto on, /auto off). */
  setAutoMode(on: boolean, turns: number): void {
    this.autoMode = on;
    this.autoLeft = on ? turns : 0;
  }
  /** Автоответ на текстовые вопросы агентов (из settings.json). */
  private autoMessage = 'Решите вопрос на своё усмотрение.';
  /** Максимальное число отвечающих за раунд (0 — без ограничения; из settings.json). */
  private maxTurns = 3;

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
    } catch (err) {
      this.userTools = new Map();
      this.presenter.error(`тулы: ${err instanceof Error ? err.message : err}`);
    }
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
        const addressed = MENTION_TRIGGERS.some((p) =>
          norm(m.text).includes(p + norm(agent.name)) || norm(m.text).includes(p + agent.id),
        );
        if (isTail || isMine || isUser || isTool || addressed || isSessionRef(m)) return m;
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
        messages.push({ role: 'user', content: `⚙ Результаты твоих действий:\n${m.text}` });
      } else {
        messages.push({
          role: 'user',
          content: `${m.authorName} (${m.authorRole ?? 'коллега'}): ${m.text}`,
        });
      }
    }
    messages.push({
      role: 'user',
      content: focus
        ? `Модератор передаёт слово тебе. Фокус: ${focus}`
        : 'Модератор передаёт слово тебе. Ответь по существу.',
    });
    const who = user.role ? ` (${user.role})` : '';
    const identity =
      `Твой собеседник — ${user.name}${who}.${user.about ? ` О себе: ${user.about}.` : ''} ` +
      'Обращайся к собеседнику по имени, когда это уместно.';
    const blocks = [agent.prompt, identity];
    if (personal) {
      blocks.push(`Твоя память (субъективно и сжато, это то, что ты помнишь сам):\n${personal}`);
    }
    if (agentToolIds(agent).length > 0) {
      // desc кастомных тулов — из живых экземпляров; кривая карточка не должна
      // ронять сборку промпта: об ошибке отрапортует конвейер при выполнении
      const custom = new Map<string, Tool>();
      for (const id of agentToolIds(agent)) {
        const factory = this.userTools.get(id);
        if (factory) {
          try {
            custom.set(id, factory(agentToolConfig(agent, id)));
          } catch {
            // невалидная карточка — подсказка для этого тула будет общей
          }
        }
      }
      const hint = actionsHint(agent, this.toolsConfig(), custom);
      if (hint) blocks.push(hint);
    }
    blocks.push(commonRules(this.language));
    return {
      system: blocks.join('\n\n'),
      messages,
      temperature: agent.temperature ?? 0.7,
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
      this.presenter.notice(t('  ⚠ Других разговоров пока нет — нечего прикладывать.'));
      return null;
    }
    if (numStr) {
      const n = Number.parseInt(numStr, 10);
      const meta = Number.isInteger(n) && n > 0 ? list[n - 1] : undefined;
      if (!meta) {
        this.presenter.notice(tf('  ⚠ В списке других разговоров нет №{n} (см. /sessions).', { n: numStr }));
        return null;
      }
      return this.store.load(meta.id);
    }
    const idx = await this.presenter.chooseSession(list.map((s) => ({ title: s.title, count: s.count })));
    if (idx === null || idx < 0 || idx >= list.length) {
      this.presenter.notice(t('  … продолжаю без приложения.'));
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
          `${m.authorId === 'user' ? userName : `${m.authorName} (${m.authorRole ?? 'участник'})`}: ${m.text}`,
        ).join('\n'),
      );
    }
    if (parts.length === 0) {
      if (!quiet) this.presenter.notice(t('  ⚠ Выбранный разговор пуст.'));
      return null;
    }

    const busy = quiet ? null : this.presenter.busy(tf('Читаю разговор «{title}»…', { title: session.title }));
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
        if (!quiet) this.presenter.notice(t('  ⚠ Не удалось построить конспект разговора.'));
        return null;
      }
      session.digest = digest;
      session.digestAtCount = session.messages.length;
      store.save(session);
      return digest;
    } catch (err) {
      if (signal?.aborted) return null; // прервано (Esc) — сообщение об этом ниже
      if (!quiet) this.presenter.notice(tf('  ⚠ Не удалось прочитать разговор: {err}', { err: err instanceof Error ? err.message : String(err) }));
      return null;
    } finally {
      busy?.stop();
    }
  }

  // ── раунд ────────────────────────────────────────────────────────────────

  /** Реплика пользователя: весь раунд под одним signal (Esc/Ctrl+C у оболочки). */
  async handleMessage(text: string, signal: AbortSignal): Promise<void> {
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
      this.presenter.notice(t('  Нет открытого проекта — выберите: /project new <id> [папка] или /project open <id|путь> (список — /projects)'));
      return;
    }
    if (!this.app.session) {
      this.presenter.notice(t('  Нет открытого разговора — /session new [id], /session open <id> или /sessions.'));
      return;
    }
    let team: Agent[];
    try {
      team = this.team();
    } catch (err) {
      this.presenter.error(tf('не удалось прочитать команду: {err}', { err: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // автономный режим: после ответа команды авто-сообщение запускает новый
    // раунд, пока не кончатся ходы (лимит) или авто-режим не выключат
    let current = text;
    let turns = 0;
    while (current !== null) {
      await this.runRound(current, team, signal);
      if (!this.autoMode || this.autoLeft <= 0 || signal.aborted) {
        if (this.autoMode && this.autoLeft <= 0 && this.autoMode) {
          this.autoMode = false;
          this.presenter.notice(t('  🤖 автономный режим завершён: лимит ходов исчерпан (/auto on — включить снова)'));
        }
        break;
      }
      this.autoLeft--;
      current = this.autoMessage;
    }
  }

  private async runRound(text: string, fullTeam: Agent[], signal: AbortSignal): Promise<void> {
    const { session, store } = requireProject(this.app);
    // профиль читаем каждый раунд: правки config/user.json подхватываются на лету
    const profile = loadUserProfile(USER_FILE);
    this.app.profile = profile;
    // язык общения, автоответ, лимит отвечающих — из settings.json, на лету
    const ui = loadSettings(SETTINGS_FILE, 0);
    this.language = ui.language;
    this.autoMessage = ui.autoMessage;
    this.maxTurns = ui.maxTurns;
    // тулы тоже: переимпорт tools/*.ts и свежие карточки — без перезапуска
    await this.refreshUserTools();
    // в чате отвечают только позванные (старые чаты без списка — вся команда)
    const team = chatTeam(session, fullTeam);

    // @session — приложить конспект другого разговора (можно несколько, "@session 2" — сразу номер)
    const attachments: ChatMessage[] = [];
    const usedIds = new Set<string>();
    let cleaned = text;
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
    session.messages.push({ authorId: 'user', authorName: 'Вы', text: userText, ts: Date.now() });
    if (session.title === 'Новый разговор') {
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
    if (team.length === 0 || managerMentioned(text, this.app.mgr)) {
      await this.managerTurn(text, fullTeam, profile, signal);
      return;
    }

    // модератор и сжатие едут на служебной модели (serviceModel), не на флагмане
    const moderator = this.serviceModel();

    // не даём контексту расти бесконечно: старые сообщения сворачиваются в конспект
    const compressing = this.presenter.busy(t('Проверяю длину разговора…'));
    let compressed = false;
    try {
      compressed = await compressIfNeeded(session, moderator, signal, profile.name);
    } catch (err) {
      if (signal.aborted) return;
      this.presenter.notice(tf('  … не удалось сжать историю, продолжаю как есть: {err}', { err: err instanceof Error ? err.message : String(err) }));
    } finally {
      compressing.stop();
    }
    if (compressed) {
      store.save(session);
      this.presenter.notice(t('  … разговор длинный: старые сообщения свёрнуты в конспект (полная история — /session history и transcripts/ проекта)'));
    }

    const planning = this.presenter.busy(t('Модератор решает, кто из команды ответит…'));
    let plan: PlanResult;
    const mentionedAll = findMentions(text, fullTeam);
    for (const a of mentionedAll) {
      if (!team.some((t) => t.id === a.id)) {
        this.presenter.notice(tf('  ⚠ {name} не в этом чате — позвать: /add {name}', { name: a.name }));
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
      const sink = this.presenter.stream(tf('{emoji} {name} печатает…', { emoji: turn.agent.emoji, name: turn.agent.name }));
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
          tf('{cached} из {total} входных токенов — из кэша промпта', {
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
      }
      if (full.trim()) {
        session.messages.push({
          authorId: turn.agent.id,
          authorName: turn.agent.name,
          authorRole: turn.agent.role,
          text: full.trim(),
          ts: Date.now(),
        });
        store.save(session);
        if (agentToolIds(turn.agent).length > 0 && !signal.aborted) {
          await this.runToolLoop(turn.agent, full.trim(), fullTeam, profile, provider, signal);
        }
      } else if (!signal.aborted) {
        this.presenter.notice(t('(пустой ответ)'));
      }
    }
    if (signal.aborted) {
      this.presenter.notice(t('\n  ⏹ Прервано (Esc). Ответы, которые успели появиться, сохранены в истории.'));
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
    const busy = this.presenter.busy(tf('{emoji} {name} разбирается…', { emoji: agent.emoji, name: agent.name }));
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
            }),
          },
        ],
        temperature: this.app.mgr.temperature,
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
        tf('{cached} из {total} входных токенов — из кэша промпта', {
          cached: (usage.cachedTokens ?? 0).toLocaleString('ru-RU'),
          total: (usage.promptTokens ?? usage.cachedTokens ?? 0).toLocaleString('ru-RU'),
        }),
      );
    }
    if (signal.aborted) {
      this.presenter.notice(t('  ⏹ Прервано (Esc).'));
      return;
    }
    const reply = parseManagerReply(full);
    if (!reply.say && reply.actions.length === 0) {
      this.presenter.notice(t('(менеджер молчит — пустой ответ)'));
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
        authorRole: MANAGER_ROLE,
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
      case 'tool.grant':
        return grantTool(AGENTS_DIR, action.agent, action.tool, action.card, TOOLS_DIR);
      case 'project.host.add':
        return addProjectHosts(PROJECT_FILE, { [String(action.name ?? 'main')]: action });
      case 'project.open': {
        // смена проекта — после сохранения реплики менеджера в СТАРУЮ сессию:
        // разговор принадлежит своему проекту
        const target = projects.resolveProjectTarget(String(action.path ?? ''), WORKSPACE || process.cwd());
        if (!target.created && target.config.path && WORKSPACE && resolve(target.config.path) === resolve(WORKSPACE)) {
          return t('Этот проект и так открыт.');
        }
        pendingSwitches.push(() => {
          this.applyProjectSwitch(target.config.id);
        });
        return tf('✓ Переключаюсь на проект «{label}» ({path})', { label: target.config.id, path: target.config.path ?? '(папка ещё не задана)' });
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
        if (!meta) return tf('Не нашёл разговор с id «{id}» — см. /sessions', { id });
        if (meta.id === this.app.session?.id) return tf('Разговор «{title}» и так открыт.', { title: meta.title });
        const loaded = this.store.load(meta.id);
        if (!loaded) return tf('Не удалось прочитать разговор «{title}».', { title: meta.title });
        pendingSwitches.push(() => {
          this.openSession(loaded);
        });
        return tf('✓ Открываю разговор «{title}» ({n} сообщ.)', { title: loaded.title, n: loaded.messages.length });
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
          this.presenter.notice(tf('  Новый разговор «{title}» ({id})', { title: created.title, id: created.id }));
          const line = this.participantsLine(created);
          if (line) this.presenter.notice(`  ${t('Участники:')} ${line}`);
        });
        return tf('✓ Создаю разговор «{title}»{chat}', { title, chat: ids.length ? tf(', в чате: {ids}', { ids: ids.join(', ') }) : '' });
      }
      case 'session.delete':
        return this.deleteSessionById(String(action.id ?? ''));
    }
  }

  // ── операции над разговорами (команды и действия менеджера) ────────────

  /** Список разговоров текстом — для действия session.list. */
  sessionsListText(): string {
    const list = this.store.list();
    if (list.length === 0) return t('Разговоров пока нет.');
    return list
      .map((s) => `${s.id} — ${s.title} — ${tf('{n} сообщ.', { n: s.count })}${s.id === this.session.id ? ` (${t('текущий')})` : ''}`)
      .join('\n');
  }

  /** Подтверждение для команд уровня ядра (импорт дома и т.п.) — через Presenter. */
  async confirmAction(label: string, desc = ''): Promise<boolean> {
    const agent = managerAsAgent(this.app.mgr);
    return this.presenter.confirm({ label, desc, who: { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, role: agent.role } });
  }

  /** Удаление разговора по id; текущий — отказ: сначала /session close. */
  deleteSessionById(id: string): string {
    const meta = this.store.list().find((s) => s.id === id);
    if (!meta) return tf('Разговора с id «{id}» нет — см. /sessions', { id });
    if (this.app.session && meta.id === this.app.session.id) {
      return t('Текущий разговор удалить нельзя — сначала /session close.');
    }
    this.store.delete(meta.id);
    return tf('Разговор «{title}» ({id}) удалён.', { title: meta.title, id: meta.id });
  }

  /** /session close: разговор закрыт, проект остаётся открытым. */
  closeSession(): string {
    if (!this.app.store) return t('Проект не открыт.');
    if (!this.app.session) return t('Разговор и так не открыт — /sessions, /session new [id] или /session open <id>.');
    this.queueFlush(this.app.session);
    this.app.session = null;
    return t('✓ Разговор закрыт. Проект открыт: /sessions, /session new [id] или /session open <id>.');
  }

  // ── проекты: реестр — папки в доме (projects/<id>/) ─────────────────────

  /** project.close: остаёмся без проекта — состояние голого запуска. */
  closeProject(): string {
    if (!this.app.store) return t('Проект и так не открыт.');
    if (this.app.session) this.queueFlush(this.app.session, this.app.store);
    this.app.store = null;
    this.app.session = null;
    clearProjectRoot();
    return t('✓ Проект закрыт: /projects, /project new <id> [папка] или /project open <id|путь>.');
  }

  /** project.open: имя проекта или путь к папке (незарегистрированная — регистрируем). */
  switchProject(arg: string): string {
    const { config, created } = projects.resolveProjectTarget(arg, WORKSPACE || process.cwd());
    const registered = created
      ? tf('Проект «{id}» зарегистрировал в доме (папка была открыта впервые).\n', { id: config.id })
      : '';
    return registered + this.applyProjectSwitch(config.id);
  }

  /** project.new: создать проект (+ рабочую папку, если задана) и открыть его. */
  newProject(name: string, pathRaw: string | null): string {
    const cfg = projects.createProject(name, pathRaw);
    return tf('✓ Проект «{id}» создал (данные — в доме, projects/{id}/)\n', { id: cfg.id }) + this.applyProjectSwitch(cfg.id);
  }

  /** project.remove: удалить проект ИЗ ДОМА (projects/<id>/); рабочая папка не трогается. */
  deleteProject(arg: string): string {
    const id = this.projectIdByArg(arg);
    projects.removeProject(id, PROJECT_DIR);
    return tf('✓ Проект «{id}» удалён из дома — файлы рабочей папки не тронуты.', { id });
  }

  /** project.rename: переименовать ТЕКУЩИЙ проект (папка в доме + id в project.json). */
  renameCurrentProject(newIdRaw: string): string {
    if (!PROJECT_DIR) throw new Error(t('нет открытого проекта — сначала /project new <id> [папка] или /project open <id|путь>'));
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
    return tf('✓ Проект переименован: «{old}» → «{new}»', { old: oldId, new: cfg.id });
  }

  /** project.path: сменить рабочую папку текущего проекта (папка создаётся). */
  repointProject(pathRaw: string): string {
    if (!PROJECT_DIR) throw new Error(t('нет открытого проекта — сначала /project new <id> [папка] или /project open <id|путь>'));
    const cfg = projects.loadProjectConfig(basename(PROJECT_DIR));
    if (!cfg) throw new Error(t('project.json текущего проекта не читается — см. /projects'));
    projects.setProjectPath(cfg, pathRaw);
    setProjectRoot(PROJECT_DIR, cfg.path ?? '');
    return tf('✓ Рабочая папка проекта «{id}»: {path}', { id: cfg.id, path: WORKSPACE });
  }

  /** Имя проекта по аргументу remove: id или путь из реестра; НЕ регистрирует новые. */
  private projectIdByArg(arg: string): string {
    const raw = arg.trim().replace(/^["']|["']$/g, '');
    if (!raw) throw new Error(t('укажите проект: /project delete <id|путь> (список — /projects)'));
    const found = projects.listProjects().find(
      (p) => p.id.toLowerCase() === raw.toLowerCase() || (p.path && resolve(p.path) === resolve(raw)),
    );
    if (!found) throw new Error(tf('проекта «{raw}» нет — см. /projects', { raw }));
    return found.id;
  }

  /**
   * Применить смену проекта: отметить lastOpened, слой путей (PROJECT_DIR,
   * WORKSPACE, SESSIONS_DIR), магазин разговоров; открыть последний разговор
   * или создать новый. Итоги старого разговора вливаются в общую память ДО
   * подмены хранилища: фоновое вливание должно писать в проект, где разговор жил.
   */
  applyProjectSwitch(id: string): string {
    const dir = join(PROJECTS_DIR, id);
    const cfg = projects.loadProjectConfig(id);
    if (!cfg) throw new Error(tf('проект «{id}» не читается (нет project.json) — /project new {id} создаст заново', { id }));
    // «уже открыт» — про состояние ЭТОГО движка, а не глобального слоя путей:
    // paths общие на процесс, а магазинов может быть несколько (второй serve
    // в том же процессе стартует без проекта при уже выставленном PROJECT_DIR)
    if (this.app.store && this.app.session && PROJECT_DIR && resolve(PROJECT_DIR) === resolve(dir)) {
      return tf('Этот проект уже открыт: {id}', { id: cfg.id });
    }
    if (this.app.store && this.app.session) this.queueFlush(this.app.session, this.app.store);
    projects.touchProject(id);
    setProjectRoot(dir, cfg.path ?? '');
    this.app.store = new SessionStore(SESSIONS_DIR);
    const list = this.app.store.list();
    this.app.session = list.length > 0 ? this.app.store.load(list[0].id) ?? this.app.store.create() : this.app.store.create();
    this.presenter.notice(`  ${t('Проект:')} ${cfg.id}${WORKSPACE ? ` · ${WORKSPACE}` : ''}`);
    this.presenter.notice(tf('  Открыт разговор «{title}» ({n} сообщ.)', { title: this.app.session.title, n: this.app.session.messages.length }));
    this.presenter.sessionOpened(this.app.session);
    return tf('✓ Проект: {id}{ws}', { id: cfg.id, ws: WORKSPACE ? ` (${WORKSPACE})` : '' });
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
      if (!invented) return t('Не придумал имя — назовите сами: /session update title=<имя>');
      return this.applySessionName(invented);
    }
    return this.applySessionName(clean.slice(0, 80) + (clean.length > 80 ? '…' : ''));
  }

  private applySessionName(title: string): string {
    this.session.title = title;
    this.store.save(this.session);
    return tf('Разговор переименован: «{title}»', { title });
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
    const busy = this.presenter.busy(t('Придумываю имя разговору…'));
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
      throw new Error(t('нет открытого проекта — сначала /project new <id> [папка] или /project open <id|путь>'));
    }
    const loaded = this.app.store.load(id.trim());
    if (!loaded) {
      this.presenter.notice(tf('  Разговора с id «{id}» нет. Посмотрите список: /sessions', { id }));
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
    this.presenter.notice(tf('  Открыт разговор «{title}» ({n} сообщ.)', { title: loaded.title, n: loaded.messages.length }));
    const line = this.participantsLine(loaded);
    if (line) this.presenter.notice(`  ${t('Участники:')} ${line}`);
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
      authorRole: mgr.role,
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
    if (!agent) return { text: tf('Нет агента с id «{id}» — см. /agents', { id }), changed: false };
    if (chatTeam(this.session, fullTeam).some((a) => a.id === agent.id)) {
      return { text: tf('{emoji} {name} уже в чате.', { emoji: agent.emoji, name: agent.name }), changed: false };
    }
    const session = this.session;
    session.participants ??= fullTeam.map((a) => a.id);
    if (!session.participants.includes(agent.id)) session.participants.push(agent.id);
    this.store.save(session);
    return { text: tf('{emoji} {name} присоединился к чату.', { emoji: agent.emoji, name: agent.name }), changed: true };
  }

  /** Вывести участника из чата: общее для /session agent delete и действия менеджера chat.remove. */
  removeFromChat(id: string, fullTeam: Agent[]): { text: string; changed: boolean } {
    const kicked = findAgentById(fullTeam, id);
    if (!kicked) return { text: tf('Нет агента с id «{id}» — см. /agents', { id }), changed: false };
    const session = this.session;
    if (!chatTeam(session, fullTeam).some((a) => a.id === kicked.id)) {
      return { text: tf('{emoji} {name} и так не в этом чате.', { emoji: kicked.emoji, name: kicked.name }), changed: false };
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
        tf('{emoji} {name} покинул(а) чат. Реплики останутся в истории.', { emoji: kicked.emoji, name: kicked.name }) +
        (alone ? ' ' + t('Кроме менеджера в чате никого — попросите его позвать кого-нибудь.') : ''),
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

  /** /profile set Имя; роль; о себе — сохранить профиль (config/user.json). */
  setProfile(name: string, role?: string, about?: string): string {
    this.app.profile = { name, role, about };
    try {
      writeFileSync(USER_FILE, JSON.stringify(this.app.profile, null, 2) + '\n');
    } catch (err) {
      throw new Error(`не удалось сохранить ${USER_FILE}: ${err instanceof Error ? err.message : err}`);
    }
    return (
      tf('Запомнил: вы — {name}', { name: this.app.profile.name }) +
      (this.app.profile.role ? ` (${this.app.profile.role})` : '') +
      `. ${t('Команда теперь знает, кто вы.')}`
    );
  }

  /** /profile update поле=значение: точечная правка профиля (name, role, about). */
  updateProfile(fields: { name?: string; role?: string; about?: string }): string {
    const next = { ...this.app.profile };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      (next as Record<string, string | undefined>)[k] = v;
    }
    if (!next.name) return t('Без имени нельзя — укажите name=…');
    this.app.profile = next as UserProfile;
    try {
      writeFileSync(USER_FILE, JSON.stringify(this.app.profile, null, 2) + '\n');
    } catch (err) {
      throw new Error(`не удалось сохранить ${USER_FILE}: ${err instanceof Error ? err.message : err}`);
    }
    return (
      tf('Запомнил: вы — {name}', { name: this.app.profile.name }) +
      (this.app.profile.role ? ` (${this.app.profile.role})` : '') +
      `. ${t('Команда теперь знает, кто вы.')}`
    );
  }

  /** Имена участников чата для подписи (без чтения agents.json возвращает null). */
  participantsLine(session: Session): string | null {
    if (!session.participants || session.participants.length === 0) return null;
    if (session.participants.length === 1 && session.participants[0] === MANAGER_ID) {
      return tf('{emoji} {name} — конфигурация через разговор', { emoji: this.app.mgr.emoji, name: this.app.mgr.name });
    }
    try {
      const full = loadTeam(AGENTS_DIR);
      return chatTeam(session, full).map((a) => `${a.emoji} ${a.name}`).join(', ');
    } catch {
      return null;
    }
  }

  // ── приветствие консьержа ───────────────────────────────────────────────

  /** Реплика-приветствие менеджера в новом (пустом) разговоре. */
  async welcomeManager(signal: AbortSignal): Promise<void> {
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
      throw new Error(t('нет открытого проекта — сначала /project new <id> [папка] или /project open <id|путь>'));
    }
    const store = this.app.store;
    const old = this.app.session;
    const created = store.create(id);
    created.participants = [MANAGER_ID];
    store.save(created);
    this.app.session = created;
    this.presenter.notice(tf('  Новый разговор {id}', { id: created.id }));
    this.presenter.notice(tf('  В чате: {emoji} {name} — попросите позвать кого-нибудь из команды (/agents)', { emoji: this.app.mgr.emoji, name: this.app.mgr.name }));
    if (old) this.queueFlush(old);
    await this.welcomeManager(signal);
  }

  /** Старт приложения на пустом разговоре: менеджер здоровается сам, как по /new. */
  async startupWelcome(signal: AbortSignal): Promise<void> {
    const { session, store } = requireProject(this.app);
    session.participants = [MANAGER_ID];
    store.save(session);
    this.presenter.notice(tf('  В чате: {emoji} {name} — попросите позвать кого-нибудь из команды (/agents)', { emoji: this.app.mgr.emoji, name: this.app.mgr.name }));
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
    return buildToolset(agent, cfg, this.toolContext(), signal, this.userTools);
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
        if (verdict === 'ask' && !(await this.presenter.confirm({ label: t('Команда'), desc: tf('команда: {cmd}', { cmd: command }), who }))) {
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
        return this.presenter.confirm({ label: 'Вопрос тула', desc: text, who });
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
      this.presenter.notice(tf('  ⚠ тулы не собраны: {err}', { err: err instanceof Error ? err.message : String(err) }));
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
          // автономный режим: вопросы решаются сами (на усмотрение агентов)
          if (this.autoMode) {
            results.push(`🤖 автономно: разрешаю ${describeAction(action)}`);
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
        authorRole: agent.role,
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
    const sink = this.presenter.stream(`${agent.emoji} ${agent.name} продолжает…`);
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
        this.presenter.notice(tf('  ⚠ не удалось получить продолжение: {err}', { err: err instanceof Error ? err.message : String(err) }));
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
      const busy = this.presenter.busy(`${agent.emoji} ${agent.name} осмысливает разговор…`);
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
        this.presenter.notice(tf('  … {name} осмыслил(а) разговор — память обновлена', { name: agent.name }));
      } catch (err) {
        if (!signal.aborted) {
          this.presenter.notice(tf('  … не удалось обновить память {name}: {err}', { name: agent.name, err: err instanceof Error ? err.message : String(err) }));
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
        this.presenter.notice(tf('  … {name} освежил(а) память о других разговорах', { name: stale.name }));
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
      this.presenter.notice(t('  Итоги этого разговора вольются в общую память позже — при следующем /new.'));
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
      if (!quiet) this.presenter.notice(t('  Сохраняю итоги разговора в общую память команды…'));
      this.app.memory.shared = await mergeShared(this.app.memory.shared, session.title, digest, this.resolveProvider(undefined));
      saveTeamMemory(MEMORY_FILE, this.app.memory);
      if (!quiet) this.presenter.notice(t('  … итоги влиты в общую память команды'));
    } catch (err) {
      if (!quiet) this.presenter.notice(tf('  … не удалось обновить общую память: {err}', { err: err instanceof Error ? err.message : String(err) }));
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
