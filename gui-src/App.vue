<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  authed, authNeeded, busyLabel, conn, currentStream, dispatch, feedItems,
  notices, roundActive, rpc, send, state, streaming, connectWs,
} from './stores/ws';

const inputText = ref('');
const showAuth = ref(false);
const authToken = ref('');
const autoLeft = computed(() => state.value.auto?.left ?? 0);
const autoMode = computed(() => state.value.auto?.mode ?? false);
const chatEl = ref<HTMLElement | null>(null);

function sendUser() {
  const text = inputText.value.trim();
  if (!text || roundActive.value) return;
  inputText.value = '';
  send({ type: 'user_message', text });
}
function sendCommand(text: string) {
  if (roundActive.value) return;
  send({ type: 'command', text });
}
function newSession() { if (!roundActive.value) rpc('session.new', {}); }
function toggleAuto() {
  if (roundActive.value) return;
  const cmd = autoMode.value ? '/auto off' : '/auto';
  send({ type: 'command', text: cmd });
}
function doAuth() {
  const token = authToken.value.trim();
  if (!token) return;
  localStorage.setItem('dt-token', token);
  send({ type: 'auth', token });
  showAuth.value = false;
}
function logout() {
  localStorage.removeItem('dt-token');
  location.reload();
}
function scrollToBottom() {
  requestAnimationFrame(() => { if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight; });
}
watch(() => state.value.session?.messages?.length, scrollToBottom);
watch(() => streaming.value.text, scrollToBottom);
onMounted(() => { connectWs(); scrollToBottom(); });
</script>

<template>
  <div v-if="authNeeded && !authed" class="auth-box">
    <h2>Токен доступа</h2>
    <input v-model='authToken' type='password' placeholder='TOKEN из ~/.dreamteam/.env' @keydown.enter='doAuth'>
    <button @click='doAuth'>Войти</button>
  </div>
  <template v-else>
    <header>
      <span class='logo'>🎬 Dream Team</span>
      <span class='badge'>👤 {{ state.profile?.name ?? '—' }}</span>
      <span class='badge'>{{ conn === 'on' ? '● на связи' : '○ отключено' }}</span>
      <button class='logout' @click='logout'>Выйти</button>
    </header>
    <div class='layout'>
      <aside class='sidebar'>
        <!-- Сессии -->
        <section>
          <div class='sec-head'>
            <span class='sec-name'>Сессии</span>
            <button title='Экспорт сессии' @click="rpc('export_session', { n: 1 })">⬇</button>
            <button title='Экспорт дома'>⬇🏠</button>
            <button title='＋' @click='newSession'>＋</button>
          </div>
          <ul>
            <li v-for='(s, i) in state.sessions' :key='s.id' :class="{ active: s.id === state.session?.id }"
              :title='`${s.title}\nid: ${s.id}`' @click="rpc('session.open', { n: i + 1 })">
              <div class='sess-main'><span>{{ s.title }}</span><span class='meta'>{{ s.count }}</span></div>
              <div class='sub'>№{{ i + 1 }} · {{ new Date(s.updatedAt).toLocaleString('ru-RU') }}</div>
            </li>
          </ul>
        </section>
        <!-- Команда -->
        <section>
          <div class='sec-head'><span class='sec-name'>Команда</span></div>
          <ul>
            <li class='static'>{{ state.manager?.emoji }} {{ state.manager?.name }}
              <span class='meta'>{{ state.manager?.provider }}</span></li>
            <li v-for='a in state.team' :key='a.id'
              :title='`${a.inChat ? "Вывести из чата" : "Позвать"} · двойной клик — настройки`'
              @click="rpc(a.inChat ? 'chat.remove' : 'chat.add', { name: a.name })"
              @dblclick="rpc('agent_update', { id: a.id, fields: {} })">
              <span>{{ a.emoji }} {{ a.name }}</span>
              <span class='meta'>{{ a.role }}</span>
              <span class='tag' :class="{ in: a.inChat }">{{ a.inChat ? 'в чате' : '＋ чат' }}</span>
            </li>
          </ul>
        </section>
        <!-- Провайдеры -->
        <section>
          <div class='sec-head'><span class='sec-name'>Провайдеры</span></div>
          <ul>
            <li v-for='p in state.providers' :key='p.id' :class="{ active: p.isDefault }"
              :title='p.ok ? "" : p.note' @click="rpc('provider.set', { id: p.id })">
              <span>{{ p.ok ? "●" : "○" }} {{ p.id }}</span>
              <span class='meta'>{{ p.model }}</span>
              <span v-if='p.isManager' class='tag'>🛎</span>
              <span v-if='p.isDefault' class='tag in'>★</span>
            </li>
          </ul>
        </section>
        <!-- Настройки -->
        <section>
          <div class='sec-head'><span class='sec-name'>Настройки</span></div>
          <ul>
            <li class='static'>Язык: {{ state.settings?.language ?? '—' }}</li>
            <li class='static'>Автоответ: {{ (state.settings?.autoMessage ?? '').slice(0, 20) || '—' }}</li>
            <li class='static'>👤 {{ state.profile?.name ?? '—' }} <span class='meta'>{{ state.profile?.role ?? '' }}</span></li>
            <li class='static'>🛎 {{ state.manager?.name ?? '' }} <span class='meta'>{{ state.manager?.provider ?? '' }}</span></li>
          </ul>
        </section>
        <!-- Расписание -->
        <section>
          <div class='sec-head'><span class='sec-name'>Расписание</span></div>
          <ul>
            <li v-for='t in []' :key='t'>{{ t }}</li>
          </ul>
        </section>
        <!-- Проекты -->
        <section>
          <div class='sec-head'><span class='sec-name'>Проекты</span></div>
          <ul>
            <li v-for='p in state.projects' :key='p.id' class='static'>
              {{ p.id }} <span class='meta' v-for='h in p.hosts' :key='h.name'>{{ h.name }}:{{ h.host }}</span>
            </li>
            <li v-if='!state.projects?.length' class='static dim'>нет проектов</li>
          </ul>
        </section>
      </aside>
      <section class='chat-area'>
        <div ref='chatEl' class='chat'>
          <template v-for='(m, i) in state.session?.messages ?? []' :key='i'>
            <div v-if='m.authorId === "user"' class='msg user'>
              <div class='head'>👤 {{ m.authorName }}</div>
              <div class='txt' v-html='m.text.replace(/\[([^\]]+\.\w+)\]/g, "<a href=\"/api/file?path=$1\" download>[$1]</a>")'></div>
            </div>
            <div v-else-if='m.authorId === "tool"' class='toolblock'>{{ m.text }}</div>
            <div v-else class='msg'>
              <div class='head' :style='{ color: state.team?.find(a => a.id === m.authorId)?.color ?? "" }'>
                {{ m.authorName }} <span class='meta'>{{ m.authorRole }}</span>
              </div>
              <div class='txt' v-html='m.text.replace(/\[([^\]]+\.\w+)\]/g, "<a href=\"/api/file?path=$1\" download>[$1]</a>")'></div>
            </div>
          </template>
          <div v-if='streaming.open' class='msg'>
            <div class='head'>{{ streaming.agentEmoji }} {{ streaming.agentName }}</div>
            <div class='txt'>{{ streaming.text }}▌</div>
          </div>
        </div>
        <div class='feed'>
          <div v-for='(n, i) in notices' :key='i' class='notice'>{{ n.text }}</div>
        </div>
        <div class='statusbar'>
          <span v-if='autoMode' class='auto-badge'>🤖 авто ({{ autoLeft }})</span>
          <span v-if='busyLabel'>⏳ {{ busyLabel }}</span>
          <button v-if='roundActive' @click="send({ type: 'abort' })">⏹</button>
          <button :class='{ active: autoMode }' @click='toggleAuto'>🤖</button>
        </div>
        <div class='inputrow'>
          <textarea v-model='inputText' rows='1'
            placeholder='Напишите команде… (Enter — отправить, /help — команды)'
            @keydown.enter.exact.prevent='sendUser()'></textarea>
          <button @click='sendUser()'>➤</button>
          <label class='attach'>📎<input type='file' class='hidden' @change='(e: Event) => {
            const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
            const r = new FileReader();
            r.onload = () => send({ type: "file", name: f.name, dataB64: btoa(String.fromCharCode(...new Uint8Array(r.result as ArrayBuffer))), text: `файл ${f.name}` });
            r.readAsArrayBuffer(f);
          }'></label>
        </div>
      </section>
    </div>
  </template>
</template>

<style>
:root { --bg: #16181d; --panel: #1e222a; --panel2: #242933; --border: #2e3542; --text: #d7dae0; --dim: #8a919e; --accent: #61afef; --ok: #98c379; --bad: #e06c75; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
header { display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: var(--panel); border-bottom: 1px solid var(--border); }
.logo { font-weight: 600; }
.badge { background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 1px 10px; font-size: 12px; color: var(--dim); }
.logout { margin-left: auto; }
.layout { display: flex; height: calc(100vh - 41px); }
.sidebar { width: 280px; min-width: 280px; overflow-y: auto; background: var(--panel); border-right: 1px solid var(--border); padding: 10px; }
.sidebar section { margin-bottom: 14px; }
.sec-head { display: flex; align-items: center; gap: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); margin-bottom: 6px; }
.sec-head .sec-name { flex: 1; }
.sec-head button { background: none; border: none; color: var(--dim); cursor: pointer; font-size: 13px; padding: 0 2px; }
.sec-head button:hover { color: var(--accent); }
.sidebar ul { list-style: none; margin: 0; padding: 0; }
.sidebar li { padding: 5px 8px; border-radius: 6px; cursor: pointer; overflow: hidden; }
.sidebar li:hover { background: var(--panel2); }
.sidebar li.active { background: var(--panel2); border-left: 2px solid var(--accent); }
.sidebar li.static { cursor: default; }
.sidebar .meta { color: var(--dim); font-size: 12px; }
.sidebar .tag { font-size: 10px; border: 1px solid var(--border); border-radius: 8px; padding: 0 6px; color: var(--dim); }
.sidebar .tag.in { color: var(--ok); border-color: var(--ok); }
.chat-area { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.chat { flex: 1; overflow-y: auto; padding: 14px 18px; }
.msg { margin-bottom: 12px; max-width: 860px; }
.msg .head { font-weight: 600; margin-bottom: 2px; }
.msg .txt { white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.user .txt { background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; display: inline-block; }
.toolblock { font: 12px/1.6 Consolas, monospace; color: var(--dim); border-left: 2px solid var(--border); padding-left: 10px; margin-bottom: 10px; white-space: pre-wrap; }
.feed { padding: 0 18px; }
.notice { color: var(--dim); font-style: italic; margin-bottom: 4px; white-space: pre-wrap; }
.statusbar { display: flex; align-items: center; gap: 8px; padding: 4px 18px; color: var(--dim); font-size: 13px; }
.auto-badge { color: var(--ok); }
.inputrow { display: flex; gap: 8px; padding: 10px 18px 14px; align-items: flex-end; }
.inputrow textarea { flex: 1; resize: none; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit; max-height: 160px; }
.inputrow button { padding: 8px 14px; cursor: pointer; }
.attach { cursor: pointer; padding: 8px 4px; }
.hidden { display: none !important; }
.auth-box { position: fixed; inset: 0; background: var(--bg); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; z-index: 10; }
.auth-box input { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font: inherit; }
.meta { color: var(--dim); font-size: 12px; }
a.file-link { color: var(--accent); }
button { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; }
button:hover { border-color: var(--accent); }
button.active { border-color: var(--ok); color: var(--ok); }
.errline { color: var(--bad); }
</style>
