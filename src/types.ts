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

/**
 * Инструменты, которыми агент реально действует (а не только говорит).
 * Встроенные: files — запись файлов; shell — команды на этом ПК; ssh — команды
 * на настроенных серверах; look — посмотреть картинку глазами vision-модели;
 * image — сгенерировать изображение. Свои тула — файлы tools/*.ts, их имена
 * свободны. Форма поля tools в agents.json — только объект карточек
 * ({"shell": {…} или "shell": null}); карточка (или {} для null) уходит
 * в фабрику тула.
 */
export type AgentTools = Record<string, unknown>;

/** Участник команды из config/agents.json */
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
  /** Инструменты-карточки {"shell": {…} или null} (поле tools в agents.json) */
  tools?: AgentTools;
  /** Доступ к серверам hosts.json (поле projects в agents.json) — префикс «project:» в блоках */
  projects?: string[];
  /** Подпапка рабочей папки или абсолютный путь — куда идут блоки без префикса */
  workspace?: string;
  /** Чем агент смотрит картинки (```look): id провайдера с "vision": true; по умолчанию — его же провайдер */
  vision?: string;
  /** Чем агент рисует (```image): id image-провайдера из providers.json */
  image?: string;
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
  createdAt: number;
  updatedAt: number;
  count: number;
}

/** Универсальное сообщение для LLM */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Картинки (data: URL) — vision-моделям, обычно в запросе инструмента look */
  images?: string[];
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
 * Менеджер переговорки: config/manager.json. Это тот самый модератор-оркестратор,
 * но с собственным минимальным конфигом: свой провайдер, имя, вид. Через него
 * (@менеджер) выполняются все конфигурационные операции — состав команды,
 * состав чата, разговоры.
 */
export interface ManagerConfig {
  /** id провайдера из config/providers.json (модель берётся из записи провайдера) */
  provider: string;
  name: string;
  emoji: string;
  color: string;
  temperature: number;
}

/** Правка существующего участника (белый список полей для team.update) */
export interface ManagerUpdateFields {
  name?: string;
  emoji?: string;
  color?: string;
  role?: string;
  description?: string;
  prompt?: string;
  provider?: string;
  temperature?: number;
}

/** Действие менеджера из его ответа (JSON-объект после текста) */
export type ManagerAction =
  | {
      op: 'team.add';
      id: string;
      name: string;
      role?: string;
      prompt?: string;
      emoji?: string;
      color?: string;
      description?: string;
      temperature?: number;
      provider?: string;
      tools?: AgentTools;
    }
  | { op: 'team.update'; id: string; fields: ManagerUpdateFields }
  | { op: 'chat.add'; who: string }
  | { op: 'chat.remove'; who: string }
  | { op: 'session.list' }
  | { op: 'session.open'; n: number }
  | { op: 'session.new'; title?: string; participants?: string[] }
  | { op: 'session.delete'; n: number }
  /** Переименовать текущий разговор (имя придумывает менеджер или руководитель) */
  | { op: 'session.rename'; title: string }
  /** Включить тул агенту / обновить его карточку (tools в agents.json) */
  | { op: 'tool.grant'; agent: string; tool: string; card?: unknown }
  | { op: 'project.host.add'; project?: string; name: string } & ManagerHostSpec;

/** Сервер в действии менеджера (project.host.add) */
export interface ManagerHostSpec {
  host: string;
  user?: string;
  password?: string;
  port?: number;
  dir?: string;
}

/** Проект для блока состояния менеджера: id и имена серверов */
export interface ManagerProjectInfo {
  id: string;
  hosts: string[];
}

/** Разобранный ответ менеджера: текст для человека + действия */
export interface ManagerReply {
  say: string;
  actions: ManagerAction[];
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

/** Запрос к image-модели: генерация с нуля или перерисовка по референсам */
export interface ImageRequest {
  prompt: string;
  /** Сколько вариантов (по умолчанию 1) */
  n?: number;
  /** «512x768», «1024x1024»… */
  size?: string;
  /** Шаги диффузии: больше — качественнее и дольше */
  steps?: number;
  /** Насколько строго модель следует промпту (guidance scale) */
  guidance?: number;
  seed?: number;
  /** Референсы как data: URL — режим перерисовки (images/edits) */
  refImages?: string[];
}

/** Одна сгенерированная картинка: base64 без префикса */
export interface GeneratedImage {
  data: string;
  mediaType: string;
}

export interface ImageResult {
  ok: boolean;
  images: GeneratedImage[];
  error?: string;
}

/**
 * Единый интерфейс image-моделей (Flux, SD-Turbo, Qwen-Image-Edit, облачные API).
 * Адаптер — только транспорт: файлы на диск кладёт приложение, в рабочую папку.
 */
export interface ImageProvider {
  readonly id: string;
  readonly kind: string;
  readonly model: string;
  generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
}
