/** Типы WS-событий и снапшота состояния — единственный контракт GUI ⟷ serve. */

export interface ChatMessage {
  authorId: string;
  authorName: string;
  text: string;
  ts: number;
  /** файлы, прикреплённые к реплике (имена в inbox проекта) — только у пользователя */
  attachments?: string[];
}

/** Накопительная статистика токенов разговора (как /usage в терминале) */
export interface SessionUsage {
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  rounds: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  count: number;
  /** токены разговора — отчёт «Статистика…» (ПКМ в сайдбаре) */
  usage?: SessionUsage;
  /** тот же срез по моделям: id → счётчики */
  usageByModel?: Record<string, SessionUsage>;
  /** заполнение контекста последним раундом — индикатор в статус-баре */
  contextTokens?: number;
  /** модель этой оценки (окно берётся из её карточки) */
  contextModel?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  color?: string;
  model?: string;
  prompt?: string;
  tools?: string[];
  inChat: boolean;
}

/** Одно окно лимита тарифа провайдера (зеркало src/types.ts) */
export interface QuotaWindow {
  /** стабильный id окна: '5h' | 'week' | 'month' | 'mcp' | … */
  key: string;
  kind: 'tokens' | 'credits' | 'calls' | 'time';
  /** сколько ИСПОЛЬЗОВАНО, 0..100 (индикатор показывает остаток 100−used) */
  usedPercent: number;
  limit?: number;
  remaining?: number;
  /** epoch ms следующего сброса окна */
  resetAt?: number;
}

/** Снимок лимитов провайдера на момент опроса (зеркало src/types.ts) */
export interface ProviderQuota {
  plan?: string;
  windows: QuotaWindow[];
  fetchedAt: number;
}

/** Карточка модели из models/ дома (id = имя файла) */
export interface ModelInfo {
  id: string;
  kind: string;
  model?: string;
  /** адаптер из карточки (имя файла в реестре провайдеров) */
  provider?: string;
  baseUrl?: string;
  ok: boolean;
  note?: string;
  vision?: boolean;
  /** размер контекстного окна (токены) — знаменатель индикатора контекста */
  contextWindow?: number;
  /** лимиты тарифа — только у дефолтной модели, из кеша сервера */
  quota?: ProviderQuota;
  isDefault: boolean;
  isManager: boolean;
  /** image-модель (генерация картинок): клик — карточка, основной быть не может */
  img?: boolean;
}

export interface ProjectHost {
  name: string;
  host: string;
  user?: string;
  port?: number;
  dir?: string;
  /** true — пароль задан (сам пароль сервер не отдаёт) */
  hasPassword?: boolean;
}

export interface MailInfo {
  id: string;
  user: string;
  imap: string;
  smtp: string;
  port?: number;
  smtpPort?: number;
  tlsNoVerify?: boolean;
  /** true — пароль задан (сам пароль сервер не отдаёт) */
  hasPassword?: boolean;
}

export interface MessengerInfo {
  /** 'telegram' | 'max' */
  key: string;
  /** true — токен задан (сам токен сервер не отдаёт) */
  hasToken?: boolean;
}

export interface ProjectInfo {
  id: string;
  hosts: ProjectHost[];
  mails?: MailInfo[];
  messengers?: MessengerInfo[];
}

/** Ответ rpc fs.dirs — листинг каталога для встроенного браузера путей */
export interface DirListing {
  path: string;
  /** родитель; null — корень диска, выше некуда */
  parent: string | null;
  dirs: { name: string; path: string }[];
  /** диски (только win32) */
  drives: string[];
}

/** Проект дома (папка в projects/) — для переключения */
export interface ProjectRecordInfo {
  path: string;
  name: string;
  lastOpened?: number;
}

export interface ScheduleTaskInfo {
  id: string;
  message: string;
  intervalMinutes: number;
  enabled: boolean;
}

/** Подсказка операции из манифеста (operations.ts) — для панели команд GUI */
export interface OpHint {
  /** Каноническая команда: '/session open' или обзорная '/sessions' */
  cmd: string;
  args?: string;
  /** Машиночитаемые подсказки аргументов (sessions/agents/chat/models/…), по одной на аргумент */
  hints?: string[];
  help: string;
}

/** Известный язык интерфейса: встроенный (ru/en/zh) или свой из lang/ дома */
export interface LanguageInfo {
  id: string;
  /** Название на самом языке (для селектора в ⚙) */
  name: string;
  builtIn: boolean;
}

/** Поле схемы карточки (card-schema.ts ядра) — форма «Изменить» рендерится из него */
export interface FieldSpec {
  /** Путь значения в карточке: «name», «model.temperature» */
  path: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'object' | 'enum' | 'password' | 'model';
  /** Метка поля — русский ключ, переводится словарём ui.strings */
  label: string;
  /** Варианты для enum */
  values?: string[];
  placeholder?: string;
  /** Поле обязательно по контракту провайдера (схема модели) */
  required?: boolean;
  /** Описание поля (контракт провайдера) — мелкая подпись под контролем */
  desc?: string;
}

export interface CardSchema {
  entity: string;
  fields: FieldSpec[];
}

export interface StateSnapshot {
  /** null — проект не выбран: оболочка показывает панель выбора проекта */
  session: { id: string; title: string; messages: ChatMessage[] } | null;
  sessions: SessionMeta[];
  /** битый agents.json: текст ошибки (нет файла — пустая команда, ошибки нет) */
  teamError?: string | null;
  team: AgentInfo[];
  manager: { name: string; emoji: string; color: string; model?: string; temperature?: number };
  models: ModelInfo[];
  images: { id: string; ok: boolean; note?: string; kind?: string; model?: string; provider?: string }[];
  /** все имена провайдеров (встроенные + кастомные) — селектор в новой модели */
  providers?: string[];
  profile: { name: string; about?: string };
  projects: ProjectInfo[];
  /** текущий проект (id = папка в projects/ дома); null — не выбран */
  project?: { id: string; name: string; path: string } | null;
  /** проекты дома — клик = переключение (rpc project.open) */
  knownProjects?: ProjectRecordInfo[];
  auto: { mode: boolean; left: number };
  settings: { width: number; language?: string; margin: number; screen: boolean; runTimeoutMs: number; maxOutputChars: number; autoMessage: string; quotePrefix?: string; maxInputRows: number; compressThreshold: number };
  completion: { operations: OpHint[] };
  /** схемы карточек: формы «Изменить» (агент/модель/разговор/проект) рендерятся из них */
  schemas?: Record<string, CardSchema>;
  /** язык интерфейса, словарь переводов (русский ключ → перевод) и список
   *  известных языков — системные (ru/en/zh) и свои из lang/ дома (селектор в ⚙) */
  ui?: { id: string; strings: Record<string, string>; languages?: LanguageInfo[] };
  /** кэш последнего события schedule (в снапшот state не входит) */
  scheduleTasks?: ScheduleTaskInfo[];
  /** память команды: общая и «из других разговоров» по участникам */
  memory?: { shared: string; agents: Record<string, { otherChats?: string }> };
}

// ── входящие WS-события ──────────────────────────────────────────────────────

export type WsEvent =
  | { type: 'state'; state: StateSnapshot }
  | { type: 'session_opened'; session: StateSnapshot['session'] }
  | { type: 'auth_required' }
  | { type: 'auth_ok' }
  | { type: 'auth_failed' }
  | { type: 'notice'; text: string }
  | { type: 'error'; text: string }
  | { type: 'turn_header'; agent: { id: string; name: string; emoji?: string; color?: string } }
  | { type: 'busy'; id: string; label: string }
  | { type: 'busy_end'; id: string }
  | { type: 'delta'; text: string }
  | { type: 'turn_end'; full: string }
  | { type: 'say'; text: string }
  | { type: 'tool_results'; results: string[] }
  | { type: 'attachment'; title: string; digest: string }
  | { type: 'confirm'; id: string; label: string; desc?: string; who?: { id: string; name: string; emoji?: string; color?: string } }
  | { type: 'choose_session'; id: string; items: { title: string; count: number }[] }
  | { type: 'export_data'; name: string; dataB64: string }
  | { type: 'projects'; projects: ProjectInfo[] }
  | { type: 'settings'; settings: StateSnapshot['settings'] }
  | { type: 'manager'; manager: StateSnapshot['manager'] }
  | { type: 'schedule'; tasks: ScheduleTaskInfo[] }
  | { type: 'rpc_result'; id: string; result: unknown }
  | { type: 'rpc_error'; id: string; error: string };

// ── исходящие WS-сообщения ───────────────────────────────────────────────────

export type WsMessage =
  | { type: 'hello' }
  | { type: 'auth'; token: string }
  | { type: 'user_message'; text: string; attachments?: string[] }
  | { type: 'command'; text: string }
  | { type: 'abort' }
  | { type: 'confirm_response'; id: string; approved: boolean }
  | { type: 'choose_response'; id: string; index: number | null }
  | { type: 'export_home' }
  | { type: 'export_settings' }
  | { type: 'export_project'; id?: string }
  | { type: 'export_session'; id: string }
  | { type: 'import_home'; dataB64: string }
  | { type: 'import_settings'; dataB64: string }
  | { type: 'import_project'; dataB64: string; id?: string }
  | { type: 'import_session'; dataB64: string }
  | { type: 'file_ref'; name: string; path: string; text?: string; defer?: boolean }
  | { type: 'rpc'; id: string; method: string; args?: Record<string, unknown> };
