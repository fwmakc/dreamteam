<script setup lang='ts'>
import { computed, onMounted, ref, watch, nextTick } from 'vue';
import type { ChatMessage, ProjectInfo, ScheduleTaskInfo, StateSnapshot } from './types';

// ── WS ────────────────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rpcSeq = 0;
const rpcPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const busyMap = new Map<string, string>();

export const conn = ref<'off' | 'on'>('off');
export const authed = ref(true);
export const authNeeded = ref(false);
export const roundActive = ref(false);
export const snapshot = reactive<Partial<StateSnapshot>>({});
export const streaming = reactive({ open: false, name: '', emoji: '🤖', color: '', text: '' });
export const busyText = ref('');
export const autoMode = ref(false);
export const autoLeft = ref(0);
export const feedItems = reactive<{ text: string }[]>([]);
export const chatMessages = reactive<ChatMessage[]>([]);
export const showAuth = ref(false);
export const authToken = ref('');
export const authError = ref('');
export const confirmVisible = ref(false);
export const confirmLabel = ref('');
export const confirmDesc = ref('');
export const confirmWho = ref('');
export const confirmId = ref('');
export const chooseVisible = ref(false);
export const chooseItems = ref<{ title: string; count: number }[]>([]);
export const chooseId = ref('');

function send(msg: any) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function rpc(method: string, args?: Record<string, unknown>): Promise<any> {
  const id = `rpc-${++rpcSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('таймаут')), 30_000);
    rpcPending.set(id, { resolve, reject, timer });
    send({ type: 'rpc', id, method, args: args ?? {} });
  });
}
function resolveRpc(id: string, result: unknown) {
  const p = rpcPending.get(id);
  if (p) { clearTimeout(p.timer); rpcPending.delete(id); p.resolve(result); }
}
function rejectRpc(id: string, error: string) {
  const p = rpcPending.get(id);
  if (p) { clearTimeout(p.timer); rpcPending.delete(id); p.reject(new Error(error)); }
}

function connectWs() {
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
      confirmVisible.value = true;
      confirmLabel.value = msg.label as string;
      confirmDesc.value = (msg.desc as string) ?? '';
      confirmWho.value = (msg.who as { emoji?: string; name?: string })
        ? `${(msg.who as any).emoji ?? ''} ${(msg.who as any).name ?? ''}` : '';
      confirmId.value = msg.id as string;
      break;
    case 'choose_session':
      chooseVisible.value = true;
      chooseId.value = msg.id as string;
      chooseItems.value = msg.items as { title: string; count: number }[];
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
</script>

<template>
  <!-- Auth -->
  <div v-if='showAuth' class='auth-box'>
    <h2>Токен доступа</h2>
    <input v-model='authToken' type='password' placeholder='TOKEN из ~/.dreamteam/.env' @keydown.enter='doAuth'>
    <button @click='doAuth'>Войти</button>
  </div>
  <template v-else>
    <header>
      <span class='logo'>🎬 Dream Team</span>
      <span class='badge clickable' title='Настройки пользователя' @click='openUserProfile'>👤 {{ profile.name }}</span>
      <span class='badge clickable' title='Настройки менеджера' @click='openManagerEdit'>🛎 {{ mgr.name }}</span>
      <button class='tb-btn' @click='openSettings'>⚙</button>
      <button class='tb-btn' @click='exportHome'>⬇</button>
      <button class='tb-btn' @click='pickImportFile'>⬆</button>
      <input type='file' ref='importFileEl' class='hidden' accept='.zip' @change='onImportFile'>
      <span class='spacer'></span>
      <span class='conn' :class='connState'>{{ connState }}</span>
      <button class='logout' @click='logout'>Выйти</button>
    </header>
    <div class='layout'>
      <aside class='sidebar'>
        <!-- Сессии -->
        <section>
          <div class='side-head'>
            <span class='sec-toggle'>▾</span>
            <span class='sec-name'>Сессии</span>
            <button class='sec-add' title='Новый разговор' @click='newSession'>＋</button>
          </div>
          <div class='sec-btns'>
            <button @click='exportSession'>⬇ сессия</button>
            <button @click='exportHome'>⬇ дом</button>
            <button class='import-btn' @click='pickImportFile'>⬆ импорт</button>
          </div>
          <ul>
            <li v-for='(s, i) in sessions' :key='s.id' :class="{ active: s.id === currentSessionId }"
              :title='`${s.title}\nid: ${s.id}\nсоздан: ${fmtDate(s.createdAt)}\nпоследнее: ${fmtDate(s.updatedAt)}`'
              @click='openSession(i + 1)'>
              <div class='sess-line'>
                <span class='sess-title'>{{ s.title }}</span>
                <span class='sess-del' v-if='s.id !== currentSessionId' @click.stop='deleteSession(i + 1)'>✕</span>
              </div>
              <div class='sess-sub'>создан {{ fmtDate(s.createdAt) }} · последнее {{ fmtDate(s.updatedAt) }}</div>
            </li>
          </ul>
        </section>
        <!-- Команда -->
        <section>
          <div class='side-head'>
            <span class='sec-name'>Команда</span>
            <button class='sec-add' title='Новый агент' @click='agentCreateForm'>＋</button>
          </div>
          <ul>
            <li v-for='a in team' :key='a.id' class='team-item'
              :title='`${a.inChat ? "Вывести из чата" : "Позвать в чат"} · двойной клик — настройки`'
              @click='toggleChat(a)'
              @dblclick='openAgentSettings(a)'>
              <span class='team-emoji'>{{ a.emoji }}</span>
              <span class='team-name'>{{ a.name }}</span>
              <span class='team-role'>{{ a.role }}</span>
              <span class='team-badge' :class='{ in: a.inChat }'>{{ a.inChat ? 'в чате' : '＋ чат' }}</span>
            </li>
          </ul>
        </section>
        <!-- Настройки -->
        <section>
          <div class='side-head'>
            <span class='sec-name'>Настройки</span>
            <button class='sec-add' title='Правка настроек' @click='settingsForm'>⚙</button>
          </div>
          <div class='settings-rows'>
            <div>Язык: {{ snapshot?.settings?.language ?? '—' }}</div>
            <div>Автоответ: {{ (snapshot?.settings?.autoMessage ?? '').slice(0, 20) || '—' }}</div>
            <div>👤 {{ snapshot?.profile?.name ?? '—' }} <span class='dim'>{{ snapshot?.profile?.role ?? '' }}</span></div>
            <div>{{ snapshot?.manager?.emoji ?? '🛎' }} {{ snapshot?.manager?.name ?? '' }} <span class='dim'>{{ snapshot?.manager?.provider ?? '' }}</span></div>
          </div>
        </section>
      </aside>
      <section class='chat-wrap'>
        <div class='chat-scroll' ref='chatScroll'>
          <!-- messages -->
        </div>
        <div class='feed'>
          <div v-for='(n, i) in feedItems' :key='i' class='feed-item'>{{ n }}</div>
        </div>
      </section>
      <footer class='input-bar'>
        <button class='attach-btn' title='Прикрепить файл'>📎</button>
        <input type='file' class='file-input' @change='onFilePicked'>
        <textarea v-model='draft' placeholder='Напишите команде…' @keydown='onInputKey'></textarea>
        <button class='send-btn' :disabled='roundActive' @click='sendMessage'>➤</button>
        <button class='auto-toggle' :class='{ active: autoMode }' @click='toggleAuto'>🤖 {{ autoMode ? "авто" : "авто выкл" }}</button>
      </footer>
    </div>
  </template>
</template>
