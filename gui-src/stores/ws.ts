import { reactive, ref } from 'vue';
import type { StateSnapshot, WsEvent, WsMessage } from '../types';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rpcSeq = 0;
const rpcPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const busyMap = reactive(new Map<string, string>());

export const state = reactive<Partial<StateSnapshot>>({});
export const conn = ref<'off' | 'on'>('off');
export const authed = ref(true);
export const authNeeded = ref(false);
export const roundActive = ref(false);
export const streaming = reactive({ open: false, agent: '', text: '' });
export const busyLabel = ref('');

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

function handleRpcResult(msg: Record<string, unknown>): void {
  const id = String(msg.id ?? '');
  const pending = rpcPending.get(id);
  if (!pending) return;
  rpcPending.delete(id);
  pending.resolve(msg.result);
}

function handleRpcError(msg: Record<string, unknown>): void {
  const id = String(msg.id ?? '');
  const pending = rpcPending.get(id);
  if (!pending) return;
  rpcPending.delete(id);
  pending.reject(new Error(String(msg.error ?? 'rpc error')));
}

const feedItems = reactive<{ text: string }[]>([]);
export { feedItems };
export function addFeed(text: string): void {
  feedItems.push({ text });
}

const notices = reactive<{ text: string }[]>([]);
export { notices };

export interface StreamMsg { agentName: string; agentEmoji: string; agentColor: string; text: string }
export const currentStream = reactive<StreamMsg>({ agentName: '', agentEmoji: '', agentColor: '', text: '' });

export function dispatch(ev: WsEvent): void {
  switch (ev.type) {
    case 'state':
      Object.assign(state, ev.state);
      roundActive.value = false;
      break;
    case 'auth_required':
      authNeeded.value = true;
      authed.value = false;
      break;
    case 'auth_ok':
      authed.value = true;
      authNeeded.value = false;
      break;
    case 'auth_failed':
      authed.value = false;
      localStorage.removeItem('dt-token');
      break;
    case 'notice':
      notices.push({ text: ev.text });
      break;
    case 'error':
      notices.push({ text: `✗ ${ev.text}` });
      break;
    case 'turn_header':
      currentStream.agentName = ev.agent.name;
      currentStream.agentEmoji = ev.agent.emoji ?? '🤖';
      currentStream.agentColor = ev.agent.color ?? '';
      currentStream.text = '';
      streaming.open = true;
      break;
    case 'delta':
      currentStream.text += ev.text;
      break;
    case 'turn_end':
      if (ev.full?.trim()) {
        currentStream.text = ev.full;
        streaming.open = true;
      }
      streaming.open = false;
      break;
    case 'say':
      currentStream.text = ev.text;
      streaming.open = true;
      break;
    case 'busy':
      busyMap.set(ev.id, ev.label);
      break;
    case 'busy_end':
      busyMap.delete(ev.id);
      break;
    case 'export_data': {
      const bin = atob(ev.dataB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url; a.download = ev.name; a.click();
      URL.revokeObjectURL(url);
      notices.push({ text: `Экспорт: ${ev.name}` });
      break;
    }
  }
  busyLabel.value = [...busyMap.values()].at(-1) ?? '';
}

export function connectWs(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    conn.value = 'on';
    send({ type: 'hello' });
  };
  ws.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleRpcResult(msg);
    handleRpcError(msg);
    dispatch(msg as unknown as WsEvent);
  };
  ws.onclose = () => {
    conn.value = 'off';
    reconnectTimer = setTimeout(connectWs, 1500);
  };
  ws.onerror = () => ws.close();
}
