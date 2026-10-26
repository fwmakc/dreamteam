import { computed, reactive, ref } from 'vue';
import type { ChatMessage, ProjectInfo, ScheduleTaskInfo, StateSnapshot, WsEvent, WsMessage } from '../types';

// ── утилиты ──────────────────────────────────────────────────────────────────
export const COLORS: Record<string, string> = {
  black: '#9aa3af', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
  gray: '#7f8790',
};
export const colorOf = (name: unknown): string =>
  COLORS[String(name ?? '').toLowerCase()] ?? '#d7dae0';
export const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/ё/g, 'е');

// ── реактивное состояние ─────────────────────────────────────────────────────
export const conn = ref<'init' | 'off' | 'on'>('init');
export const authed = ref(true);
export const authNeeded = ref(false);
export const authError = ref('');
export const logoutVisible = ref(false);
export const roundActive = ref(false);
/** Последний снапшот от сервера; частичные события (settings/manager/…) кладут свои поля. */
export const snapshot = reactive<Partial<StateSnapshot>>({});
/** Реплики чата: история сессии + оптимистичные + закрытые стримы. Чистится каждым state. */
export const messages = reactive<ChatMessage[]>([]);
/** Журнал ядра: уведомления и отчёты — переживает очередной state. */
export const feed = reactive<{ kind: 'notice' | 'error'; text: string }[]>([]);
/** Открытая реплика стрима (между turn_header и turn_end). */
export const streaming = reactive({
  open: false, id: '', name: '', role: '', emoji: '🤖', color: '', text: '',
});
const busyMap = reactive(new Map<string, string>());
export const busyLabel = computed(() => [...busyMap.values()].at(-1) ?? '');
export const busyCount = computed(() => busyMap.size);

export const confirmDialog = reactive({
  show: false, id: '', label: '', desc: '',
  whoEmoji: '🤖', whoName: '', whoColor: '',
});
export const chooseDialog = reactive({
  show: false, id: '',
  items: [] as { title: string; count: number }[],
});

// ── websocket ────────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rpcSeq = 0;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
const rpcPending = new Map<string, Pending>();

export function send(msg: WsMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function rpc<T = { text: string }>(method: string, args?: Record<string, unknown>): Promise<T> {
  const id = `c${++rpcSeq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`rpc ${method}: нет ответа сервера`));
    }, 30_000);
    rpcPending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    send({ type: 'rpc', id, method, args: args ?? {} });
  });
}

export function addFeed(kind: 'notice' | 'error', text: string): void {
  feed.push({ kind, text });
}

function resolveRpc(id: string, result: unknown): void {
  const p = rpcPending.get(id);
  if (p) { rpcPending.delete(id); clearTimeout(p.timer); p.resolve(result); }
}
function rejectRpc(id: string, error: string): void {
  const p = rpcPending.get(id);
  if (p) { rpcPending.delete(id); clearTimeout(p.timer); p.reject(new Error(error)); }
}

export function connectWs(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // уже подключены (или подключаемся) — не создаём второй сокет (HMR/двойной mount)
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    conn.value = 'on';
    send({ type: 'hello' });
  };
  ws.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleAuthEvent(String(msg.type ?? ''), msg) || dispatchEvent(String(msg.type ?? ''), msg);
  };
  ws.onclose = () => {
    conn.value = 'off';
    reconnectTimer = setTimeout(connectWs, 1500);
  };
  ws.onerror = () => ws?.close();
}

// ── авторизация ──────────────────────────────────────────────────────────────
function handleAuthEvent(type: string, msg: Record<string, unknown>): boolean {
  switch (type) {
    case 'auth_required': {
      logoutVisible.value = true;
      const saved = localStorage.getItem('dt-token');
      if (saved) send({ type: 'auth', token: saved });
      else { authNeeded.value = true; authError.value = ''; }
      return true;
    }
    case 'auth_ok':
      authed.value = true;
      authNeeded.value = false;
      authError.value = '';
      logoutVisible.value = true;
      return true;
    case 'auth_failed':
      localStorage.removeItem('dt-token');
      authNeeded.value = true;
      authError.value = 'Неверный токен — попробуйте ещё раз.';
      return true;
    default:
      return false;
  }
}

/** Войти по токену из формы. */
export function submitToken(token: string): void {
  const t = token.trim();
  if (!t) return;
  localStorage.setItem('dt-token', t);
  authed.value = true;
  authNeeded.value = false;
  send({ type: 'auth', token: t });
}

export function logout(): void {
  localStorage.removeItem('dt-token');
  location.reload();
}

// ── стрим: закрыть реплику, опубликовав её текст (пустую — отбросить) ────────
function finalizeStreaming(): void {
  if (!streaming.open) return;
  if (streaming.text.trim()) {
    messages.push({
      authorId: streaming.id,
      authorName: streaming.name,
      authorRole: streaming.role || undefined,
      text: streaming.text,
      ts: Date.now(),
    });
  }
  streaming.open = false;
  streaming.id = ''; streaming.name = ''; streaming.role = '';
  streaming.emoji = '🤖'; streaming.color = ''; streaming.text = '';
}

function rebuildMessages(history: ChatMessage[] | undefined): void {
  finalizeStreaming();
  messages.splice(0, messages.length, ...(history ?? []).map((m) => ({ ...m })));
}

function hidePrompts(): void {
  confirmDialog.show = false;
  chooseDialog.show = false;
}

// ── диспетчер событий сервера ────────────────────────────────────────────────
function dispatchEvent(type: string, msg: Record<string, unknown>): void {
  switch (type as WsEvent['type']) {
    case 'state': {
      const st = msg.state as StateSnapshot;
      // merge без очистки: поля, которых в снапшоте нет (scheduleTasks), сохраняем
      Object.assign(snapshot, st);
      roundActive.value = false;
      hidePrompts();
      rebuildMessages(st?.session?.messages);
      break;
    }
    case 'session_opened': {
      snapshot.session = msg.session as StateSnapshot['session'];
      rebuildMessages((msg.session as StateSnapshot['session'])?.messages);
      break;
    }
    case 'turn_header': {
      finalizeStreaming();
      const a = (msg.agent ?? {}) as { id?: string; name?: string; role?: string; emoji?: string; color?: string };
      streaming.open = true;
      streaming.id = a.id ?? '';
      streaming.name = a.name ?? '';
      streaming.role = a.role ?? '';
      streaming.emoji = a.emoji ?? '🤖';
      streaming.color = a.color ?? '';
      streaming.text = '';
      break;
    }
    case 'delta':
      if (streaming.open) streaming.text += String(msg.text ?? '');
      break;
    case 'turn_end': {
      const full = String(msg.full ?? '');
      if (full.trim()) streaming.text = full;
      finalizeStreaming();
      break;
    }
    case 'say': {
      // реплика без стрима: в открытый заголовок (заменяя текст) или отдельным сообщением
      const text = String(msg.text ?? '');
      if (streaming.open) { streaming.text = text; finalizeStreaming(); }
      else messages.push({ authorId: '', authorName: '', text, ts: Date.now() });
      break;
    }
    case 'notice':
      finalizeStreaming();
      addFeed('notice', String(msg.text ?? ''));
      break;
    case 'error':
      finalizeStreaming();
      addFeed('error', String(msg.text ?? ''));
      break;
    case 'tool_results':
      finalizeStreaming();
      messages.push({
        authorId: 'tool', authorName: '',
        text: (msg.results as string[]).map((r) => `⚙ ${r}`).join('\n'),
        ts: Date.now(),
      });
      break;
    case 'attachment':
      finalizeStreaming();
      messages.push({
        authorId: 'session-ref', authorName: String(msg.title ?? ''),
        text: String(msg.digest ?? ''), ts: Date.now(),
      });
      break;
    case 'busy':
      busyMap.set(String(msg.id), String(msg.label ?? ''));
      break;
    case 'busy_end':
      busyMap.delete(String(msg.id));
      break;
    case 'export_data': {
      const bin = atob(String(msg.dataB64 ?? ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = String(msg.name ?? '') || 'dt-export.zip';
      a.click();
      URL.revokeObjectURL(url);
      addFeed('notice', `· Экспорт готов: ${msg.name}`);
      break;
    }
    case 'confirm': {
      const who = (msg.who ?? {}) as { name?: string; emoji?: string; color?: string };
      confirmDialog.show = true;
      confirmDialog.id = String(msg.id ?? '');
      confirmDialog.label = String(msg.label ?? '');
      confirmDialog.desc = String(msg.desc ?? '');
      confirmDialog.whoEmoji = who.emoji ?? '🤖';
      confirmDialog.whoName = who.name ?? '';
      confirmDialog.whoColor = who.color ?? '';
      break;
    }
    case 'choose_session':
      chooseDialog.show = true;
      chooseDialog.id = String(msg.id ?? '');
      chooseDialog.items = (msg.items ?? []) as { title: string; count: number }[];
      break;
    case 'projects':
      snapshot.projects = msg.projects as ProjectInfo[];
      break;
    case 'settings':
      snapshot.settings = msg.settings as StateSnapshot['settings'];
      break;
    case 'manager':
      snapshot.manager = msg.manager as StateSnapshot['manager'];
      break;
    case 'schedule':
      snapshot.scheduleTasks = msg.tasks as ScheduleTaskInfo[];
      break;
    case 'rpc_result':
      resolveRpc(String(msg.id ?? ''), msg.result);
      break;
    case 'rpc_error':
      rejectRpc(String(msg.id ?? ''), String(msg.error ?? 'ошибка rpc'));
      break;
    default:
      break;
  }
}

// ── ответы на вопросы человека ───────────────────────────────────────────────
export function answerConfirm(approved: boolean): void {
  send({ type: 'confirm_response', id: confirmDialog.id, approved });
  confirmDialog.show = false;
}
export function answerChoose(index: number | null): void {
  send({ type: 'choose_response', id: chooseDialog.id, index });
  chooseDialog.show = false;
}

/** Чтение файла как base64 чанками (для импорта и вложений). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('не удалось прочитать файл'));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      let b64 = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
      }
      resolve(b64);
    };
    reader.readAsArrayBuffer(file);
  });
}
