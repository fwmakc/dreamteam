import { computed, reactive, ref } from 'vue';
import type { ChatMessage, ScheduleTaskInfo, StateSnapshot, WsEvent, WsMessage } from '../types';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rpcSeq = 0;
const rpcPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const busyMap = new Map<string, string>();

// ── реактивное состояние (читает App.vue) ────────────────────────────────────
export const conn = ref<'off' | 'on'>('off');
export const authed = ref(true);
export const authNeeded = ref(false);
export const roundActive = ref(false);
export const snapshot = reactive<Partial<StateSnapshot>>({});
export const messages = reactive<ChatMessage[]>([]);
export const streaming = reactive({ open: false, name: '', emoji: '🤖', color: '', text: '' });
export const busyLabel = ref('');
export const autoMode = ref(false);
export const autoLeft = ref(0);
export const feed = reactive<{ text: string }[]>([]);
export const confirmDialog = reactive({
  show: false, id: '', label: '', desc: '', who: '',
});
export const chooseDialog = reactive({
  show: false, id: '',
  items: [] as { title: string; count: number }[],
});

// ── отправка ─────────────────────────────────────────────────────────────────
export function send(msg: WsMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function rpc<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T> {
  const id = `rpc-${++rpcSeq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`rpc ${method}: таймаут`));
    }, 30_000);
    rpcPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v as T); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    send({ type: 'rpc', id, method, args: args ?? {} });
  });
}

export function addFeed(text: string): void {
  feed.push({ text });
}

function resolveRpc(id: string, result: unknown): void {
  const p = rpcPending.get(id);
  if (p) { rpcPending.delete(id); clearTimeout(p.timer); p.resolve(result); }
}
function rejectRpc(id: string, error: string): void {
  const p = rpcPending.get(id);
  if (p) { rpcPending.delete(id); clearTimeout(p.timer); p.reject(new Error(error)); }
}

// ── WS-соединение и обработка сообщений ──────────────────────────────────────
export function connectWs(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    conn.value = 'on';
    const saved = localStorage.getItem('dt-token');
    if (saved) send({ type: 'auth', token: saved });
    else send({ type: 'hello' });
  };
  ws.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(e.data); } catch { return; }
    const type = String(msg.type ?? '');
    if (type === 'auth_required') { authNeeded.value = true; authed.value = false; return; }
    if (type === 'auth_ok') { authed.value = true; authNeeded.value = false; send({ type: 'hello' }); return; }
    if (type === 'auth_failed') { authed.value = false; localStorage.removeItem('dt-token'); return; }
    if (type === 'rpc_result') { resolveRpc(String(msg.id ?? ''), msg.result); return; }
    if (type === 'rpc_error') { rejectRpc(String(msg.id ?? ''), String(msg.error ?? '')); return; }
    dispatchEvent(type, msg);
  };
  ws.onclose = () => {
    conn.value = 'off';
    reconnectTimer = setTimeout(connectWs, 1500);
  };
  ws.onerror = () => ws.close();
}

function dispatchEvent(type: string, msg: Record<string, unknown>): void {
  switch (type) {
    case 'state': {
      Object.assign(snapshot, msg.state as StateSnapshot);
      if (msg.state) {
        const a = (msg.state as StateSnapshot).auto;
        if (a) { autoMode.value = a.mode; autoLeft.value = a.left; }
      }
      roundActive.value = false;
      break;
    }
    case 'notice':
      addFeed(msg.text as string);
      break;
    case 'error':
      addFeed(`✗ ${msg.text as string}`);
      break;
    case 'turn_header': {
      const agent = msg.agent as { name: string; emoji?: string; color?: string };
      streaming.open = true;
      streaming.name = agent?.name ?? '';
      streaming.emoji = agent?.emoji ?? '🤖';
      streaming.color = agent?.color ?? '';
      streaming.text = '';
      break;
    }
    case 'delta':
      streaming.text += msg.text as string;
      break;
    case 'turn_end':
      if ((msg.full as string)?.trim()) { streaming.text = msg.full as string; streaming.open = true; }
      streaming.open = false;
      break;
    case 'say':
      streaming.text = msg.text as string;
      streaming.open = true;
      break;
    case 'tool_results':
      addFeed((msg.results as string[]).join('\n'));
      break;
    case 'attachment':
      addFeed(`📎 ${msg.title as string}\n${msg.digest as string}`);
      break;
    case 'busy':
      busyMap.set(String(msg.id), msg.label as string);
      break;
    case 'busy_end':
      busyMap.delete(String(msg.id));
      break;
    case 'export_data': {
      const bin = atob(msg.dataB64 as string);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url; a.download = msg.name as string; a.click();
      URL.revokeObjectURL(url);
      addFeed(`Экспорт: ${msg.name as string}`);
      break;
    }
    case 'confirm':
      confirmDialog.show = true;
      confirmDialog.id = msg.id as string;
      confirmDialog.label = msg.label as string;
      confirmDialog.desc = (msg.desc as string) ?? '';
      confirmDialog.who = (msg.who as { emoji?: string; name?: string })
        ? `${(msg.who as any).emoji ?? ''} ${(msg.who as any).name ?? ''}` : '';
      break;
    case 'choose_session':
      chooseDialog.show = true;
      chooseDialog.id = msg.id as string;
      chooseDialog.items = msg.items as { title: string; count: number }[];
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
  }
}
