import { findMentions, loadTeam, loadUserProfile } from '../agents.js';
import {
  MANAGER_ID,
  MANAGER_PROMPT,
  MANAGER_ROLE,
  addProjectHosts,
  addTeamAgent,
  grantTool,
  managerAsAgent,
  managerMentioned,
  managerStateInput,
  parseManagerReply,
  updateTeamAgent,
} from '../manager.js';
import {
  actionsHint,
  checkPermission,
  describeAction,
  executeRunAction,
  loadToolsConfig,
  parseActions,
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
import { writeFileSync } from 'node:fs';
// пути всех трёх слоёв (пакет / дом / проект) — только в paths.ts
import {
  AGENTS_FILE,
  HOSTS_FILE,
  MEMORY_FILE,
  SETTINGS_FILE,
  TOOLS_DIR,
  USER_FILE,
  WORKSPACE,
} from '../paths.js';
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
import type { ImageProviderStatus, ProviderStatus } from '../providers/registry.js';
import { SessionStore } from '../sessions.js';
import { loadSettings } from '../settings.js';
import type {
  Agent,
  ChatMessage,
  LLMMessage,
  LLMProvider,
  ManagerAction,
  ManagerConfig,
  Session,
  StreamRequest,
  TeamMemory,
  UserProfile,
} from '../types.js';
import type { Presenter, SpeakerRef } from './presenter.js';

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
  'коротко представься и скажи, чем можешь помочь — позвать команду, включить тула, настроить проекты и серверы. ' +
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

export interface App {
  store: SessionStore;
  session: Session;
  providers: Map<string, ProviderStatus>;
  /** image-провайдеры (генерация картинок) из того же providers.json */
  images: Map<string, ImageProviderStatus>;
  defaultProviderId: string;
  /** Мозг модератора и шлюз конфигурации (config/manager.json) */
  mgr: ManagerConfig;
  profile: UserProfile;
  memory: TeamMemory;
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

/** Ищет агента по номеру из /team, имени или id (регистр и «ё» не важны). */
function findAgentByArg(fullTeam: Agent[], arg: string): Agent | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const n = Number.parseInt(arg, 10);
  if (Number.isInteger(n) && n > 0) return fullTeam[n - 1];
  return fullTeam.find((a) => norm(a.name) === norm(arg) || a.id === norm(arg));
}

/**
 * Ядро приложения: раунды, менеджер, инструменты, память. Всё, что видит
 * человек, проходит через Presenter — ядро ничего не печатает само.
 */
export class Engine {
  /** Пользовательские тула (tools/*.ts), перечитываются раз в раунд. */
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

  // ── провайдеры ───────────────────────────────────────────────────────────

  defaultProvider(): LLMProvider {
    const status = this.app.providers.get(this.app.defaultProviderId);
    if (!status) {
      throw new Error('не настроен ни один провайдер — проверьте config/providers.json');
    }
    return status.provider;
  }

  /** Провайдер менеджера переговорки: только его, /provider на это не влияет */
  private managerProvider(): LLMProvider {
    const status = this.app.providers.get(this.app.mgr.provider);
    if (!status) {
      throw new Error(`у менеджера переговорки неизвестный провайдер «${this.app.mgr.provider}» (config/manager.json)`);
    }
    return status.provider;
  }

  private agentProvider(agent: Agent): LLMProvider {
    if (agent.provider) {
      const status = this.app.providers.get(agent.provider);
      if (status) return status.provider;
      this.presenter.notice(`⚠ у агента ${agent.name} указан неизвестный провайдер «${agent.provider}», использую основной`);
    }
    return this.defaultProvider();
  }

  /** Глаза и руки агентов: vision-провайдер для look и image-провайдер для image. */
  private toolContext(): ToolContext {
    const app = this.app;
    return {
      getVisionProvider(agent) {
        const pid = agent?.vision ?? agent?.provider ?? app.defaultProviderId;
        const status = app.providers.get(pid);
        if (!status) return { error: `провайдер «${pid}» не найден (см. providers.json)` };
        if (!status.vision) {
          return {
            error: `провайдер «${pid}» (${status.provider.model}) не умеет смотреть картинки — задайте агенту поле "vision" с провайдером, у которого в providers.json "vision": true`,
          };
        }
        return { provider: status.provider };
      },
      getImageProvider(agent) {
        const pid = agent?.image;
        if (!pid) return { error: 'агенту не назначен image-провайдер (поле "image" в agents.json)' };
        const status = app.images.get(pid);
        if (!status) return { error: `image-провайдер «${pid}» не найден (см. providers.json)` };
        if (!status.ok) return { error: `image-провайдер «${pid}» не настроен: ${status.note ?? ''}` };
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
    return loadTeam(AGENTS_FILE);
  }

  // ── сборка запроса ──────────────────────────────────────────────────────

  /** Собирает запрос агенту: профиль собеседника + конспект старой части + недавняя история + слово от модератора. */
  private buildRequest(
    agent: Agent,
    focus: string | undefined,
    history: ChatMessage[],
    user: UserProfile,
    summary?: string,
    personal?: string,
  ): StreamRequest {
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
    return loadToolsConfig(SETTINGS_FILE, HOSTS_FILE, WORKSPACE);
  }

  // ── конспекты и @session ────────────────────────────────────────────────

  /**
   * Выбор разговора для @session: "@session 2" — сразу номер из списка других
   * разговоров, "@session" — интерактивный выбор. Enter отменяет.
   */
  private async pickSession(numStr?: string): Promise<Session | null> {
    // автономный режим: никаких интерактивных вопросов
    if (this.autoMode) return null;
    const list = this.app.store.list().filter((s) => s.id !== this.app.session.id);
    if (list.length === 0) {
      this.presenter.notice('  ⚠ Других разговоров пока нет — нечего прикладывать.');
      return null;
    }
    if (numStr) {
      const n = Number.parseInt(numStr, 10);
      const meta = Number.isInteger(n) && n > 0 ? list[n - 1] : undefined;
      if (!meta) {
        this.presenter.notice(`  ⚠ В списке других разговоров нет №${numStr} (см. /sessions).`);
        return null;
      }
      return this.app.store.load(meta.id);
    }
    const idx = await this.presenter.chooseSession(list.map((s) => ({ title: s.title, count: s.count })));
    if (idx === null || idx < 0 || idx >= list.length) {
      this.presenter.notice('  … продолжаю без приложения.');
      return null;
    }
    return this.app.store.load(list[idx].id);
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
  ): Promise<string | null> {
    const provider = this.defaultProvider();
    if (session.digest && session.digestAtCount !== undefined
        && session.messages.length - session.digestAtCount < 10) {
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
      if (!quiet) this.presenter.notice('  ⚠ Выбранный разговор пуст.');
      return null;
    }

    const busy = quiet ? null : this.presenter.busy(`Читаю разговор «${session.title}»…`);
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
        if (!quiet) this.presenter.notice('  ⚠ Не удалось построить конспект разговора.');
        return null;
      }
      session.digest = digest;
      session.digestAtCount = session.messages.length;
      this.app.store.save(session);
      return digest;
    } catch (err) {
      if (signal?.aborted) return null; // прервано (Esc) — сообщение об этом ниже
      if (!quiet) this.presenter.notice(`  ⚠ Не удалось прочитать разговор: ${err instanceof Error ? err.message : err}`);
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
    let team: Agent[];
    try {
      team = this.team();
    } catch (err) {
      this.presenter.error(`не удалось прочитать команду: ${err instanceof Error ? err.message : err}`);
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
          this.presenter.notice('  🤖 автономный режим завершён: лимит ходов исчерпан (/auto on — включить снова)');
        }
        break;
      }
      this.autoLeft--;
      current = this.autoMessage;
    }
  }

  private async runRound(text: string, fullTeam: Agent[], signal: AbortSignal): Promise<void> {
    const { session, store } = this.app;
    // профиль читаем каждый раунд: правки config/user.json подхватываются на лету
    const profile = loadUserProfile(USER_FILE);
    this.app.profile = profile;
    // язык общения, автоответ, лимит отвечающих — из settings.json, на лету
    const ui = loadSettings(SETTINGS_FILE, 0);
    this.language = ui.language;
    this.autoMessage = ui.autoMessage;
    this.maxTurns = ui.maxTurns;
    // тула тоже: переимпорт tools/*.ts и свежие карточки — без перезапуска
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
      if (this.managerProvider().kind !== 'mock') {
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

    const moderator = this.managerProvider();

    // не даём контексту расти бесконечно: старые сообщения сворачиваются в конспект
    const compressing = this.presenter.busy('Проверяю длину разговора…');
    let compressed = false;
    try {
      compressed = await compressIfNeeded(session, moderator, signal, profile.name);
    } catch (err) {
      if (signal.aborted) return;
      this.presenter.notice(`  … не удалось сжать историю, продолжаю как есть: ${err instanceof Error ? err.message : err}`);
    } finally {
      compressing.stop();
    }
    if (compressed) {
      store.save(session);
      this.presenter.notice('  … разговор длинный: старые сообщения свёрнуты в конспект (полная история — /session history и transcripts/ проекта)');
    }

    const planning = this.presenter.busy('Модератор решает, кто из команды ответит…');
    let plan: PlanResult;
    const mentionedAll = findMentions(text, fullTeam);
    for (const a of mentionedAll) {
      if (!team.some((t) => t.id === a.id)) {
        this.presenter.notice(`  ⚠ ${a.name} не в этом чате — позвать: /add ${a.name}`);
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
      const sink = this.presenter.stream(`${turn.agent.emoji} ${turn.agent.name} печатает…`);
      let full = '';
      let streamError: unknown = null;
      try {
        for await (const chunk of provider.stream({
          ...this.buildRequest(turn.agent, turn.focus, contextSlice(session), profile, session.summary, personal),
          signal,
        })) {
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
        this.presenter.notice('(пустой ответ)');
      }
    }
    if (signal.aborted) {
      this.presenter.notice('\n  ⏹ Прервано (Esc). Ответы, которые успели появиться, сохранены в истории.');
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
    const { session, store } = this.app;
    const agent = managerAsAgent(this.app.mgr);
    const provider = this.managerProvider();
    this.presenter.turnHeader(agent);
    const busy = this.presenter.busy(`${agent.emoji} ${agent.name} разбирается…`);
    // реестр серверов для блока состояния; не читается только если файл битый —
    // но тогда приложение не стартовало бы, так что здесь он всегда валиден
    const cfg = this.toolsConfig();
    let full = '';
    let streamError: unknown = null;
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
              operations: operationHints(),
            }),
          },
        ],
        temperature: this.app.mgr.temperature,
        signal,
      })) {
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
    if (signal.aborted) {
      this.presenter.notice('  ⏹ Прервано (Esc).');
      return;
    }
    const reply = parseManagerReply(full);
    if (!reply.say && reply.actions.length === 0) {
      this.presenter.notice('(менеджер молчит — пустой ответ)');
      return;
    }
    if (reply.say) this.presenter.say(reply.say);

    const reports: string[] = [];
    const pendingSwitches: (() => Promise<void> | void)[] = [];
    for (const action of reply.actions) {
      let report: string;
      try {
        report = await this.execManagerAction(action, fullTeam, pendingSwitches);
      } catch (err) {
        report = `✗ ${err instanceof Error ? err.message : err}`;
      }
      reports.push(report);
      this.presenter.notice('  ' + report);
    }

    session.messages.push({
      authorId: MANAGER_ID,
      authorName: agent.name,
      authorRole: MANAGER_ROLE,
      text: [reply.say, ...reports].filter(Boolean).join('\n\n'),
      ts: Date.now(),
    });
    store.save(session);
    for (const apply of pendingSwitches) await apply();
  }

  /** Исполнение одного действия менеджера; то, что меняет app.session, уходит в pendingSwitches. */
  private async execManagerAction(
    action: ManagerAction,
    fullTeam: Agent[],
    pendingSwitches: (() => Promise<void> | void)[],
  ): Promise<string> {
    switch (action.op) {
      case 'team.add':
        return addTeamAgent(AGENTS_FILE, action, this.app.providers);
      case 'team.update':
        return updateTeamAgent(AGENTS_FILE, action.id, action.fields, this.app.providers);
      case 'chat.add':
        return this.addToChat(action.who, fullTeam);
      case 'chat.remove':
        return this.removeFromChat(action.who, fullTeam);
      case 'session.rename':
        return this.renameSession(String(action.title ?? ''));
      case 'tool.grant':
        return grantTool(AGENTS_FILE, action.agent, action.tool, action.card, TOOLS_DIR);
      case 'project.host.add':
        return addProjectHosts(HOSTS_FILE, { [String(action.name ?? 'main')]: action });
      default:
        throw new Error(`неизвестное действие менеджера «${(action as { op: string }).op}»`);
      case 'session.list':
        return this.sessionsListText();
      case 'session.open': {
        const meta = Number.isInteger(action.n) && action.n > 0 ? this.app.store.list()[action.n - 1] : undefined;
        if (!meta) return `Не нашёл разговор №${action.n} — см. /sessions`;
        if (meta.id === this.app.session.id) return `Разговор «${meta.title}» и так открыт.`;
        const loaded = this.app.store.load(meta.id);
        if (!loaded) return `Не удалось прочитать разговор «${meta.title}».`;
        pendingSwitches.push(() => {
          this.openSession(loaded);
        });
        return `✓ Открываю разговор «${loaded.title}» (${loaded.messages.length} сообщ.)`;
      }
      case 'session.new': {
        const title = (action.title ?? '').trim() || 'Новый разговор';
        const known = new Set(fullTeam.map((a) => a.id as string));
        const ids = [...new Set((action.participants ?? []).map((p) => String(p).trim()).filter(Boolean))]
          .filter((id) => known.has(id));
        pendingSwitches.push(() => {
          const old = this.app.session;
          this.app.session = this.app.store.create();
          this.app.session.title = title;
          // новый разговор без явных участников — один на один с менеджером
          this.app.session.participants = ids.length > 0 ? ids : [MANAGER_ID];
          this.app.store.save(this.app.session);
          this.queueFlush(old);
          this.presenter.notice(`  Новый разговор «${this.app.session.title}» (${this.app.session.id})`);
          const line = this.participantsLine(this.app.session);
          if (line) this.presenter.notice(`  Участники: ${line}`);
        });
        return `✓ Создаю разговор «${title}»${ids.length ? `, в чате: ${ids.join(', ')}` : ''}`;
      }
      case 'session.delete':
        return this.deleteSession(action.n);
    }
  }

  // ── операции над разговорами (команды и действия менеджера) ────────────

  /** Список разговоров текстом — для действия session.list. */
  sessionsListText(): string {
    const list = this.app.store.list();
    if (list.length === 0) return 'Разговоров пока нет.';
    return list
      .map((s, i) => `${i + 1}. ${s.title} — ${s.count} сообщ.${s.id === this.app.session.id ? ' (текущий)' : ''}`)
      .join('\n');
  }

  /** Подтверждение для команд уровня ядра (импорт дома и т.п.) — через Presenter. */
  async confirmAction(label: string, desc = ''): Promise<boolean> {
    const agent = managerAsAgent(this.app.mgr);
    return this.presenter.confirm({ label, desc, who: { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, role: agent.role } });
  }

  /** Удаление разговора по номеру списка; текущий не удаляется. */
  deleteSession(n: number): string {
    const meta = Number.isInteger(n) && n > 0 ? this.app.store.list()[n - 1] : undefined;
    if (!meta) return `Не нашёл разговор №${n} — см. /sessions`;
    if (meta.id === this.app.session.id) return 'Текущий разговор удалить нельзя — сначала откройте другой.';
    this.app.store.delete(meta.id);
    return `Разговор «${meta.title}» удалён.`;
  }

  /**
   * Переименовать текущий разговор (/rename и действие менеджера session.rename).
   * С именем — напрямую; без — менеджер придумывает по дайджесту, а если его
   * ещё нет — по первому и последним сообщениям.
   */
  async renameSession(name?: string): Promise<string> {
    const clean = (name ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) {
      const context = this.app.session.digest
        ? `Вот краткое содержание разговора:\n${this.app.session.digest}`
        : this.namingContextFromMessages();
      const invented = await this.generateSessionName(`Нужно дать имя сессии.\n${context}`);
      if (!invented) return 'Не придумал имя — назовите сами: /session rename <имя>';
      return this.applySessionName(invented);
    }
    return this.applySessionName(clean.slice(0, 80) + (clean.length > 80 ? '…' : ''));
  }

  private applySessionName(title: string): string {
    this.app.session.title = title;
    this.app.store.save(this.app.session);
    return `Разговор переименован: «${title}»`;
  }

  /** Первое и последние сообщения — запасной контекст, когда дайджеста ещё нет. */
  private namingContextFromMessages(): string {
    const msgs = this.app.session.messages.filter((m) => m.authorId !== 'tool');
    const first = msgs[0]?.text ?? '(пусто)';
    const last = msgs.slice(-3).map((m) => `${m.authorName}: ${m.text}`).join('\n');
    return `Вот первое сообщение разговора:\n${first.slice(0, 600)}\n\nИ последние сообщения:\n${last.slice(0, 600)}`;
  }

  /** Просит менеджера придумать короткое имя; неудача — null (останется прежнее). */
  private async generateSessionName(context: string): Promise<string | null> {
    const busy = this.presenter.busy('Придумываю имя разговору…');
    try {
      let full = '';
      for await (const chunk of this.managerProvider().stream({
        system: NAMING_SYSTEM,
        messages: [{ role: 'user', content: context }],
        temperature: 0.4,
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

  /** /session <№>: открыть разговор из списка; нет такого — заметка. */
  openSessionByArg(arg: string): void {
    const n = Number.parseInt(arg, 10);
    const target = Number.isInteger(n) ? this.app.store.list()[n - 1] : undefined;
    const loaded = target ? this.app.store.load(target.id) : null;
    if (!loaded) {
      this.presenter.notice(`  Не нашёл разговор №${arg}. Посмотрите список: /sessions`);
      return;
    }
    this.openSession(loaded);
  }

  /** Переключение на другой разговор: общее для /session и действия менеджера session.open. */
  openSession(loaded: Session): void {
    if (loaded.id !== this.app.session.id) {
      const old = this.app.session;
      this.app.session = loaded;
      this.queueFlush(old);
    }
    this.presenter.notice(`  Открыт разговор «${loaded.title}» (${loaded.messages.length} сообщ.)`);
    const line = this.participantsLine(loaded);
    if (line) this.presenter.notice(`  Участники: ${line}`);
    this.presenter.sessionOpened(loaded);
  }

  /** Позвать участника в текущий чат: общее для /add и действия менеджера chat.add. */
  addToChat(arg: string, fullTeam: Agent[]): string {
    const agent = findAgentByArg(fullTeam, arg);
    if (!agent) return `Нет участника «${arg}» — см. /team`;
    if (chatTeam(this.app.session, fullTeam).some((a) => a.id === agent.id)) {
      return `${agent.emoji} ${agent.name} уже в чате.`;
    }
    this.app.session.participants ??= fullTeam.map((a) => a.id);
    if (!this.app.session.participants.includes(agent.id)) this.app.session.participants.push(agent.id);
    this.app.store.save(this.app.session);
    return `${agent.emoji} ${agent.name} присоединился к чату.`;
  }

  /** Вывести участника из чата: общее для /out и действия менеджера chat.remove. */
  removeFromChat(arg: string, fullTeam: Agent[]): string {
    const kicked = findAgentByArg(fullTeam, arg);
    if (!kicked) return `Нет участника «${arg}» — см. /team`;
    if (!chatTeam(this.app.session, fullTeam).some((a) => a.id === kicked.id)) {
      return `${kicked.emoji} ${kicked.name} и так не в этом чате.`;
    }
    // материализуем явный список, иначе выгон «вернул» бы всю команду
    this.app.session.participants ??= fullTeam.map((a) => a.id);
    const rest = this.app.session.participants.filter((id) => id !== kicked.id);
    // без агентов чат не бросаем: остаётся консьерж — он позовёт кого нужно
    const byId = new Set(fullTeam.map((a) => a.id));
    this.app.session.participants = rest.some((id) => byId.has(id)) ? rest : [MANAGER_ID];
    this.app.store.save(this.app.session);
    const alone = this.app.session.participants.length === 1 && this.app.session.participants[0] === MANAGER_ID;
    return (
      `${kicked.emoji} ${kicked.name} покинул(а) чат. Реплики останутся в истории.` +
      (alone ? ' Кроме менеджера в чате никого — попросите его позвать кого-нибудь.' : '')
    );
  }

  /** Смена основного провайдера агентов; false — нет такого id. */
  setProvider(id: string): boolean {
    if (!this.app.providers.has(id)) return false;
    this.app.defaultProviderId = id;
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
      `Запомнил: вы — ${this.app.profile.name}` +
      (this.app.profile.role ? ` (${this.app.profile.role})` : '') +
      '. Команда теперь знает, кто вы.'
    );
  }

  /** Имена участников чата для подписи (без чтения agents.json возвращает null). */
  participantsLine(session: Session): string | null {
    if (!session.participants || session.participants.length === 0) return null;
    if (session.participants.length === 1 && session.participants[0] === MANAGER_ID) {
      return `${this.app.mgr.emoji} ${this.app.mgr.name} — конфигурация через разговор`;
    }
    try {
      const full = loadTeam(AGENTS_FILE);
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

  /** /session new: мгновенно новый разговор один на один с менеджером + приветствие. */
  async newSession(signal: AbortSignal): Promise<void> {
    const old = this.app.session;
    this.app.session = this.app.store.create();
    this.app.session.participants = [MANAGER_ID];
    this.app.store.save(this.app.session);
    this.presenter.notice(`  Новый разговор ${this.app.session.id}`);
    this.presenter.notice(`  В чате: ${this.app.mgr.emoji} ${this.app.mgr.name} — попросите позвать кого-нибудь из команды (/team)`);
    this.queueFlush(old);
    await this.welcomeManager(signal);
  }

  /** Старт приложения на пустом разговоре: менеджер здоровается сам, как по /new. */
  async startupWelcome(signal: AbortSignal): Promise<void> {
    const session = this.app.session;
    session.participants = [MANAGER_ID];
    this.app.store.save(session);
    this.presenter.notice(`  В чате: ${this.app.mgr.emoji} ${this.app.mgr.name} — попросите позвать кого-нибудь из команды (/team)`);
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
      run: async (command) => {
        // полный конвейер shell-тула: check тула → живой вопрос → запуск
        const shell = toolset.get('shell');
        if (!shell) return { ok: false, output: 'тул shell этому агенту не включён' };
        const verdict = shell.check(command, base);
        if (typeof verdict === 'object')
          return { ok: false, output: `отказ: shell отклонил команду «${command}»: ${verdict.deny}` };
        if (verdict === 'deny') return { ok: false, output: `отказ: shell отклонил команду «${command}»` };
        if (verdict === 'ask' && !(await this.presenter.confirm({ label: 'Команда', desc: `команда: ${command}`, who }))) {
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
   * Цикл инструментов: разбираем блоки ```file / ```run / ```тул из ответа
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
    const { session, store } = this.app;
    const cfg = this.toolsConfig();
    let toolset: Map<string, Tool>;
    try {
      toolset = this.toolsetFor(agent, cfg, signal);
    } catch (err) {
      // кривая карточка или код тула: конфигурация чинится в файлах, раунд громко об этом скажет
      this.presenter.notice(`  ⚠ тула не собраны: ${err instanceof Error ? err.message : err}`);
      return;
    }
    // виды тул-блоков, которые движок исполняет, — ровно тула агента: у него
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
    const personal = memoryBlock(agent, this.app.session, fullTeam, this.app.memory, profile.name);
    const sink = this.presenter.stream(`${agent.emoji} ${agent.name} продолжает…`);
    let full = '';
    try {
      for await (const chunk of provider.stream({
        ...this.buildRequest(
          agent,
          TOOL_FOLLOW_FOCUS,
          contextSlice(this.app.session),
          profile,
          this.app.session.summary,
          personal,
        ),
        signal,
      })) {
        full += chunk;
        sink.delta(chunk);
      }
    } catch (err) {
      if (!signal.aborted) {
        this.presenter.notice(`  ⚠ не удалось получить продолжение: ${err instanceof Error ? err.message : err}`);
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
    const { session } = this.app;

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
        this.app.store.save(session);
        this.presenter.notice(`  … ${agent.name} осмыслил(а) разговор — память обновлена`);
      } catch (err) {
        if (!signal.aborted) {
          this.presenter.notice(`  … не удалось обновить память ${agent.name}: ${err instanceof Error ? err.message : err}`);
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
        this.presenter.notice(`  … ${stale.name} освежил(а) память о других разговорах`);
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
    target: Session = this.app.session,
    opts: { quiet?: boolean; onlyIfFreshDigest?: boolean } = {},
  ): Promise<void> {
    const session = target;
    const quiet = opts.quiet ?? false;
    if (session.messages.length < 6) return; // нечего запоминать
    const fresh = !!(session.digest && session.digestAtCount !== undefined
      && session.messages.length - session.digestAtCount < 10);
    if (fresh && session.digestInLog) return; // с прошлой выгрузки ничего нового
    if (opts.onlyIfFreshDigest && !fresh) {
      this.presenter.notice('  Итоги этого разговора вольются в общую память позже — при следующем /new.');
      return;
    }

    const digest = fresh && session.digest
      ? session.digest
      : await this.getSessionDigest(session, AbortSignal.timeout(60_000), this.app.profile.name, quiet);
    if (!digest) return;

    appendChatToLog(this.app.memory, session.title, digest);
    session.digestInLog = true;
    this.app.store.save(session);
    try {
      if (!quiet) this.presenter.notice('  Сохраняю итоги разговора в общую память команды…');
      this.app.memory.shared = await mergeShared(this.app.memory.shared, session.title, digest, this.defaultProvider());
      saveTeamMemory(MEMORY_FILE, this.app.memory);
      if (!quiet) this.presenter.notice('  … итоги влиты в общую память команды');
    } catch (err) {
      if (!quiet) this.presenter.notice(`  … не удалось обновить общую память: ${err instanceof Error ? err.message : err}`);
    }
  }

  private queueFlush(session: Session): void {
    this.flushChain = this.flushChain
      .then(() => this.flushChatMemory(session, { quiet: true }))
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
