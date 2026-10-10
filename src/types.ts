/**
 * Кто сидит за терминалом: config/user.json или команда /me.
 * Участники видят это в системном промпте и в подписях сообщений.
 */
export interface UserProfile {
  name: string;
  role?: string;
  about?: string;
}

/**
 * Субъективная память агента в конкретном разговоре: задача, отношение к
 * руководителю и к коллегам. Обновляется лениво (раз в ~12 сообщений),
 * хранится в session JSON.
 */
export interface AgentChatMemory {
  /** Моя задача/цель в этом разговоре */
  task?: string;
  /** Личное отношение к собеседнику-руководителю */
  towardUser?: string;
  /** Отношение к коллегам: id агента → заметка */
  ties?: Record<string, string>;
  /** Индекс сообщения, после которого память обновлялась (порог рефлексии) */
  updatedAtMsg: number;
}

/** Итог закрытого разговора в общем логе команды */
export interface ChatLogEntry {
  title: string;
  digest: string;
}

/** Глобальная память агента между разговорами */
export interface AgentGlobalMemory {
  /** Что обсуждали в других разговорах (сжато, от первого лица) */
  otherChats?: string;
  /** Версия лога, которую агент уже «видел» */
  seenVersion?: number;
}

/** Общая память команды — data/memory.json */
export interface TeamMemory {
  /** Итоги последних закрытых разговоров */
  log: ChatLogEntry[];
  /** Растёт с каждым влитым разговором — для ленивых обновлений otherChats */
  logVersion: number;
  /** Общий документ: договорённости, решения, незакрытое — один на всех */
  shared?: string;
  agents: Record<string, AgentGlobalMemory>;
}

/** Инструменты, которыми агент реально действует (а не только говорит) */
export type AgentTool = 'files' | 'shell';

/** Участник команды из config/team.json */
export interface Agent {
  id: string;
  name: string;
  emoji: string;
  role: string;
  description?: string;
  /** Цвет текста в консоли: red|green|yellow|blue|magenta|cyan|white|gray */
  color: string;
  /** Персона агента — системный промпт */
  prompt: string;
  /** Свой провайдер из config/providers.json (необязательно) */
  provider?: string;
  temperature?: number;
  /** Инструменты (config/tools.json + поле tools в team.json): files — запись файлов, shell — команды */
  tools?: AgentTool[];
}

/** Сообщение в истории разговора */
export interface ChatMessage {
  /** 'user' или id агента */
  authorId: string;
  authorName: string;
  authorRole?: string;
  text: string;
  ts: number;
}

/** Разговор, сохраняемый в data/sessions/<id>.json */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Краткий конспект старой части разговора (сжатие контекста). Полная история остаётся в messages. */
  summary?: string;
  /** Сообщения до этого индекса уже свёрнуты в summary и не отправляются в LLM */
  compressedUpTo?: number;
  /** Конспект всего разговора — для @session-приложений в другие чаты (кэш) */
  digest?: string;
  /** Сколько сообщений было, когда строился digest (для устаревания кэша) */
  digestAtCount?: number;
  /** Субъективная память участников (агент → память) */
  memories?: Record<string, AgentChatMemory>;
  /** Конспект этого разговора уже влит в общий лог команды (data/memory.json) */
  digestInLog?: boolean;
  /** Кто позван в этот чат (id агентов); пусто — вся команда (старые разговоры) */
  participants?: string[];
}

/** Краткие сведения о разговоре для списка /sessions */
export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
}

/** Универсальное сообщение для LLM */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Запрос к провайдеру */
export interface StreamRequest {
  system?: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Отмена запроса извне (Esc во время раунда) */
  signal?: AbortSignal;
}

/**
 * Единый интерфейс доступа к любой LLM.
 * Конкретные API (Z.ai, Anthropic, GigaChat...) реализуют его в src/providers/.
 */
export interface LLMProvider {
  /** id провайдера из config/providers.json */
  readonly id: string;
  /** имя адаптера ('openai-compatible' | 'anthropic' | 'gigachat' | 'mock' | ...) */
  readonly kind: string;
  readonly model: string;
  /** Поток кусочков текста ответа */
  stream(req: StreamRequest): AsyncIterable<string>;
}
