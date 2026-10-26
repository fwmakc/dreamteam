/** Типы WS-событий и снапшота состояния — единственный контракт GUI ⟷ serve. */

export interface ChatMessage {
  authorId: string;
  authorName: string;
  authorRole?: string;
  text: string;
  ts: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  count: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  role?: string;
  emoji?: string;
  color?: string;
  model?: string;
  temperature?: number;
  prompt?: string;
  tools?: string[];
  inChat: boolean;
}

/** Карточка модели из models/ дома (id = имя файла) */
export interface ModelInfo {
  id: string;
  kind: string;
  model?: string;
  baseUrl?: string;
  ok: boolean;
  note?: string;
  vision?: boolean;
  isDefault: boolean;
  isManager: boolean;
}

export interface ProjectHost {
  name: string;
  host: string;
}

export interface ProjectInfo {
  id: string;
  hosts: ProjectHost[];
}

/** Проект из реестра машины (projects.json в доме) — для переключения */
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
  help: string;
}

export interface StateSnapshot {
  session: { id: string; title: string; messages: ChatMessage[] };
  sessions: SessionMeta[];
  /** битый agents.json: текст ошибки (нет файла — пустая команда, ошибки нет) */
  teamError?: string | null;
  team: AgentInfo[];
  manager: { name: string; emoji: string; color: string; model?: string; temperature?: number };
  models: ModelInfo[];
  images: { id: string; ok: boolean; note?: string }[];
  profile: { name: string; role?: string; about?: string };
  projects: ProjectInfo[];
  /** текущий проект (папка запуска serve) */
  project?: { path: string; name: string };
  /** известные проекты машины — клик = переключение (rpc project.open) */
  knownProjects?: ProjectRecordInfo[];
  auto: { mode: boolean; left: number };
  settings: { width: number; language: string; margin: number; screen: boolean; runTimeoutMs: number; maxOutputChars: number; autoMessage: string };
  completion: { operations: OpHint[] };
  /** язык интерфейса и словарь переводов (русский ключ → перевод) */
  ui?: { id: string; strings: Record<string, string> };
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
  | { type: 'turn_header'; agent: { id: string; name: string; role?: string; emoji?: string; color?: string } }
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
  | { type: 'user_message'; text: string }
  | { type: 'command'; text: string }
  | { type: 'abort' }
  | { type: 'confirm_response'; id: string; approved: boolean }
  | { type: 'choose_response'; id: string; index: number | null }
  | { type: 'export_home' }
  | { type: 'export_session'; n: number }
  | { type: 'import_home'; dataB64: string }
  | { type: 'import_session'; dataB64: string }
  | { type: 'file'; name: string; dataB64: string; text?: string }
  | { type: 'rpc'; id: string; method: string; args?: Record<string, unknown> };
