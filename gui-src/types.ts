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
  provider?: string;
  temperature?: number;
  prompt?: string;
  inChat: boolean;
}

export interface ProviderInfo {
  id: string;
  kind: string;
  model?: string;
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

export interface ScheduleTaskInfo {
  id: string;
  message: string;
  intervalMinutes: number;
  enabled: boolean;
}

export interface CommandSpec {
  cmd: string;
  args?: string;
  help: string;
  aliases?: string[];
  tuiOnly?: boolean;
}

export interface StateSnapshot {
  session: { id: string; title: string; messages: ChatMessage[] };
  sessions: SessionMeta[];
  team: AgentInfo[];
  manager: { name: string; emoji: string; color: string; provider: string; temperature?: number };
  providers: ProviderInfo[];
  images: { id: string; ok: boolean; note?: string }[];
  profile: { name: string; role?: string; about?: string };
  projects: ProjectInfo[];
  auto: { mode: boolean; left: number };
  settings: { width: number; language: string; margin: number; screen: boolean; runTimeoutMs: number; maxOutputChars: number; autoMessage: string };
  completion: { commands: CommandSpec[] };
  /** кэш последнего события schedule (в снапшот state не входит) */
  scheduleTasks?: ScheduleTaskInfo[];
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
  | { type: 'schedule_get' }
  | { type: 'file'; name: string; dataB64: string; text?: string }
  | { type: 'rpc'; id: string; method: string; args?: Record<string, unknown> };
