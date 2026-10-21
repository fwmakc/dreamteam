<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch, watchEffect } from 'vue';
import type {
  AgentInfo, ChatMessage, OpHint, ProjectHost, ProjectInfo,
  ProviderInfo, ScheduleTaskInfo, SessionMeta,
} from './types';
import {
  addFeed, answerChoose, answerConfirm, authError, authNeeded, authed, busyCount, busyLabel,
  colorOf, confirmDialog, conn, connectWs, chooseDialog, fileToBase64, feed, logout, messages,
  norm, rpc, roundActive, send, snapshot, streaming, submitToken, logoutVisible,
} from './stores/ws';

// ── проекции снапшота ────────────────────────────────────────────────────────
const profile = computed(() => snapshot.profile);
const sessions = computed(() => (snapshot.sessions ?? []) as SessionMeta[]);
const currentSessionId = computed(() => snapshot.session?.id ?? '');
const team = computed(() => (snapshot.team ?? []) as AgentInfo[]);
const providers = computed(() => (snapshot.providers ?? []) as ProviderInfo[]);
const projects = computed(() => (snapshot.projects ?? []) as ProjectInfo[]);
const scheduleTasks = computed(() => (snapshot.scheduleTasks ?? []) as ScheduleTaskInfo[]);
const manager = computed(() => snapshot.manager);
const commands = computed(() => (snapshot.completion?.operations ?? []) as OpHint[]);
const autoMode = computed(() => Boolean(snapshot.auto?.mode));
const autoLeft = computed(() => snapshot.auto?.left ?? 0);
const statusVisible = computed(() => roundActive.value || busyCount.value > 0);
const busyText = computed(() => busyLabel.value || (roundActive.value ? 'раунд идёт…' : ''));

watchEffect(() => {
  const def = providers.value.find((p) => p.isDefault);
  if (def) document.title = `Dream Team — ${def.id}`;
});

// ── текст реплики: ```блоки``` → pre, [файл.ext] → ссылка на скачивание ──────
const esc = (s: string): string => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
));
function fileLinks(escaped: string): string {
  return escaped.replace(/\[([^\[\]]+\.[A-Za-z0-9]{2,8})\]/g, (_m, name: string) => {
    const href = `/api/file?path=${encodeURIComponent(name)}`;
    return `<a class="file-link" href="${href}" download>[${name}]</a>`;
  });
}
function formatText(text: string): string {
  const parts = String(text).split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      let code = parts[i];
      const nl = code.indexOf('\n');
      if (nl !== -1 && nl <= 20) code = code.slice(nl + 1); // «язык» блока
      html += `<pre>${esc(code.replace(/\n$/, ''))}</pre>`;
    } else if (parts[i]) {
      html += `<span class="txt">${fileLinks(esc(parts[i]))}</span>`;
    }
  }
  return html || '<span class="txt"></span>';
}
function colorByAuthor(m: ChatMessage): string {
  if (m.authorId === 'manager') return colorOf(manager.value?.color);
  const a = team.value.find((x) => x.id === m.authorId);
  return colorOf(a?.color);
}
const fmtDate = (ts: number): string => new Date(ts).toLocaleString('ru-RU');

// ── автоскролл чата ──────────────────────────────────────────────────────────
const chatEl = ref<HTMLElement | null>(null);
function scrollDown(): void {
  const el = chatEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
watch(
  () => [messages.length, feed.length, streaming.text, streaming.open, confirmDialog.show],
  () => nextTick(scrollDown),
);

// ── разделение одиночного и двойного клика (250 мс) ──────────────────────────
const cliTimers = new Map<string, ReturnType<typeof setTimeout>>();
function onCliDbl(key: string, single: () => void, dbl: () => void): void {
  const t = cliTimers.get(key);
  if (t) { clearTimeout(t); cliTimers.delete(key); dbl(); return; }
  cliTimers.set(key, setTimeout(() => { cliTimers.delete(key); single(); }, 250));
}

// ── модальная форма: поля [{key,label,value,placeholder?}] ───────────────────
type FormField = { key: string; label: string; value?: string; placeholder?: string };
const modal = reactive({
  show: false, title: '', error: '',
  fields: [] as { key: string; label: string; value: string; placeholder?: string }[],
  onSave: null as null | ((v: Record<string, string>) => void),
});
const modalBox = ref<HTMLElement | null>(null);
function openForm(title: string, fields: FormField[], onSave: (v: Record<string, string>) => void): void {
  modal.title = title;
  modal.fields = fields.map((f) => ({ key: f.key, label: f.label, value: f.value ?? '', placeholder: f.placeholder }));
  modal.error = '';
  modal.onSave = onSave;
  modal.show = true;
  nextTick(() => modalBox.value?.querySelector('input')?.focus());
}
function closeForm(): void {
  modal.show = false;
  modal.onSave = null;
}
function submitForm(): void {
  if (!modal.onSave) return;
  const values: Record<string, string> = {};
  for (const f of modal.fields) values[f.key] = f.value.trim();
  try {
    modal.onSave(values);
    closeForm();
  } catch (err) {
    modal.error = (err as Error).message;
  }
}

// ── агенты: создать/удалить/настроить ────────────────────────────────────────
function rpcReport(p: Promise<{ text: string }>): void {
  p.then((r) => addFeed('notice', `· ${r.text}`))
    .catch((err: Error) => addFeed('error', `✗ ${err.message}`));
}
function openAgentCreate(): void {
  openForm('Новый агент', [
    { key: 'id', label: 'id (латиница, цифры, -/_)' },
    { key: 'name', label: 'Имя' },
    { key: 'role', label: 'Роль (можно пропустить)' },
  ], (v) => rpcReport(rpc('team.add', v)));
}
function openAgentSettings(a: AgentInfo): void {
  openForm(`Настройки агента ${a.name}`, [
    { key: 'role', label: 'Роль', value: a.role ?? '' },
    { key: 'provider', label: 'Провайдер', value: a.provider ?? '' },
    { key: 'temperature', label: 'Температура (0–2)', value: a.temperature != null ? String(a.temperature) : '' },
    { key: 'prompt', label: 'Промпт', value: a.prompt ?? '' },
    { key: 'tools', label: `Тулы через запятую (есть: ${(a.tools ?? []).join(', ') || 'нет'})` },
  ], (v) => {
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== '' && k !== 'tools') fields[k] = k === 'temperature' ? Number(val) : val;
    if (Object.keys(fields).length > 0) rpcReport(rpc('team.update', { id: a.id, fields }));
    // новые тула выдаём по одному (отзыв — руками в agents.json или словом менеджеру)
    const have = new Set(a.tools ?? []);
    for (const tool of (v.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
      if (have.has(tool.toLowerCase())) continue;
      rpcReport(rpc('team.grant', { agent: a.id, tool }));
    }
  });
}
function agentDelete(a: AgentInfo): void {
  if (!window.confirm(`Удалить агента ${a.name}? История останется, но он исчезнет из команды.`)) return;
  rpcReport(rpc('team.delete', { id: a.id }));
}
function toggleChat(a: AgentInfo): void {
  if (roundActive.value) return;
  rpcReport(rpc(a.inChat ? 'chat.remove' : 'chat.add', { name: a.name }));
}
function delAgent(a: AgentInfo): void {
  if (!roundActive.value) agentDelete(a);
}

// ── провайдеры: создать/удалить/настроить ────────────────────────────────────
function providerCreate(): void {
  openForm('Новый провайдер', [
    { key: 'id', label: 'id (латиница)' },
    { key: 'adapter', label: 'Адаптер (openai-compatible / anthropic / gigachat)', value: 'openai-compatible' },
    { key: 'baseUrl', label: 'baseUrl' },
    { key: 'model', label: 'Модель' },
    { key: 'apiKeyEnv', label: 'Имя переменной с ключом' },
  ], (v) => rpcReport(rpc('provider.add', { id: v.id, config: v })));
}
function providerDelete(p: ProviderInfo): void {
  if (p.isDefault) return;
  if (!window.confirm(`Удалить провайдера ${p.id}?`)) return;
  rpcReport(rpc('provider.delete', { id: p.id }));
}
function setProvider(p: ProviderInfo): void {
  if (roundActive.value || p.isDefault) return;
  rpc('provider.set', { id: p.id }).catch((err: Error) => addFeed('error', `✗ ${err.message}`));
}
function delProvider(p: ProviderInfo): void {
  if (!roundActive.value) providerDelete(p);
}
function openProviderSettings(p: ProviderInfo): void {
  openForm(`Провайдер ${p.id}`, [
    { key: 'baseUrl', label: 'baseUrl', value: '' },
    { key: 'model', label: 'Модель', value: p.model ?? '' },
    { key: 'apiKeyEnv', label: 'Имя переменной с ключом' },
  ], () => addFeed('notice', '· правка провайдеров пока через ~/.dreamteam/providers.json'));
}

// ── настройки / пользователь / менеджер ──────────────────────────────────────
function openSettingsForm(): void {
  const st = snapshot.settings;
  if (!st) return;
  openForm('Настройки', [
    { key: 'language', label: 'Язык общения (russian / ru-RU / english…)', value: st.language ?? '' },
    { key: 'autoMessage', label: 'Автоответ в автономном режиме', value: st.autoMessage ?? '' },
    { key: 'width', label: 'Ширина экрана (40–500)', value: st.width != null ? String(st.width) : '' },
  ], (v) => {
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== '') patch[k] = k === 'width' ? Number(val) : val;
    rpc('settings.set', { patch })
      .then(() => addFeed('notice', '· настройки сохранены'))
      .catch((err: Error) => addFeed('error', `✗ ${err.message}`));
  });
}
function openUserProfileForm(): void {
  const p = profile.value;
  if (!p) return;
  openForm('Пользователь', [
    { key: 'name', label: 'Имя', value: p.name ?? '' },
    { key: 'role', label: 'Роль', value: p.role ?? '' },
    { key: 'about', label: 'О себе', value: p.about ?? '' },
  ], (v) => rpcReport(rpc('profile.set', v)));
}
function openManagerForm(): void {
  const mgr = manager.value;
  if (!mgr) return;
  openForm('Менеджер переговорки', [
    { key: 'name', label: 'Имя', value: mgr.name ?? '' },
    { key: 'emoji', label: 'Эмодзи', value: mgr.emoji ?? '' },
    { key: 'color', label: 'Цвет (yellow/cyan/…)', value: mgr.color ?? '' },
    { key: 'temperature', label: 'Температура (0–2)', value: mgr.temperature != null ? String(mgr.temperature) : '' },
  ], (v) => {
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== '') fields[k] = k === 'temperature' ? Number(val) : val;
    rpcReport(rpc('manager.set', { fields }));
  });
}

// ── проекты ──────────────────────────────────────────────────────────────────
function projectAdd(): void {
  openForm('Новый проект', [
    { key: 'id', label: 'id проекта (латиница)' },
    { key: 'hostName', label: 'Имя сервера (напр. prod)' },
    { key: 'host', label: 'Хост (адрес)' },
    { key: 'user', label: 'Пользователь (можно пропустить)' },
    { key: 'port', label: 'Порт (можно пропустить)' },
  ], (v) => rpcReport(rpc('project.add', v)));
}
function projectHostAdd(p: ProjectInfo): void {
  if (roundActive.value) return;
  openForm(`Сервер проекта «${p.id}»`, [
    { key: 'hostName', label: 'Имя сервера (напр. prod)' },
    { key: 'host', label: 'Хост (адрес)' },
    { key: 'user', label: 'Пользователь (можно пропустить)' },
    { key: 'port', label: 'Порт (можно пропустить)' },
  ], (v) => rpcReport(rpc('project.host.add', { id: p.id, ...v })));
}
function projectHostDelete(p: ProjectInfo, h: ProjectHost): void {
  if (roundActive.value) return;
  rpcReport(rpc('project.host.delete', { id: p.id, name: h.name }));
}
function projectDelete(p: ProjectInfo): void {
  if (roundActive.value) return;
  rpc('project.delete', { id: p.id }).catch((err: Error) => addFeed('error', `✗ ${err.message}`));
}

// ── расписание ───────────────────────────────────────────────────────────────
function refreshSchedule(): Promise<void> {
  return rpc<{ tasks: ScheduleTaskInfo[] }>('schedule.list')
    .then((r) => { snapshot.scheduleTasks = r.tasks; })
    .catch(() => {});
}
function openScheduleForm(fromSection: boolean): void {
  if (roundActive.value) return;
  if (fromSection) void refreshSchedule();
  openForm('Задача по расписанию', [
    { key: 'message', label: 'Задание (уйдёт в чат как сообщение)' },
    { key: 'intervalMinutes', label: 'Каждые N минут', value: '10' },
  ], (v) => {
    rpc('schedule.add', { message: v.message, intervalMinutes: Number(v.intervalMinutes) || 10 })
      .then(() => { if (fromSection) void refreshSchedule(); })
      .catch((err: Error) => addFeed('error', `✗ ${err.message}`));
  });
}
function scheduleToggle(t: ScheduleTaskInfo): void {
  rpc('schedule.toggle', { id: t.id }).catch((err: Error) => addFeed('error', `✗ ${err.message}`));
}
function scheduleDelete(t: ScheduleTaskInfo): void {
  rpc('schedule.delete', { id: t.id }).catch((err: Error) => addFeed('error', `✗ ${err.message}`));
}

// ── сессии ───────────────────────────────────────────────────────────────────
function openSessionRename(i: number): void {
  if (roundActive.value) return;
  const meta = sessions.value[i - 1];
  if (!meta) return;
  openForm(`Переименовать «${meta.title}»`, [
    { key: 'name', label: 'Новое имя (пусто — менеджер придумает)', value: meta.title },
  ], (v) => {
    // session.rename правит ТЕКУЩИЙ разговор — сначала открываем выбранный
    rpcReport(rpc('session.open', { n: i }).then(() => rpc('session.rename', { name: v.name })));
  });
}
function newSession(): void {
  if (roundActive.value) return;
  roundActive.value = true;
  rpc('session.new', {}).catch((err: Error) => addFeed('error', `✗ ${err.message}`));
}
function openSession(i: number): void {
  if (!roundActive.value) rpc('session.open', { n: i }).catch(() => {});
}
function deleteSession(i: number, title: string): void {
  if (!window.confirm(`Удалить разговор «${title}»? Действие необратимо.`)) return;
  rpcReport(rpc('session.delete', { n: i }));
}

// ── сворачивание секций (localStorage) ───────────────────────────────────────
const LS_COLLAPSED = 'dt-collapsed';
const DEFAULT_COLLAPSED = ['team', 'providers', 'schedule', 'projects'];
const collapsed = reactive(new Set<string>((() => {
  try {
    const saved = localStorage.getItem(LS_COLLAPSED);
    if (saved !== null) return JSON.parse(saved) as string[];
  } catch { /* битый JSON — используем дефолт */ }
  return DEFAULT_COLLAPSED;
})()));
function toggleSec(sec: string): void {
  if (collapsed.has(sec)) collapsed.delete(sec);
  else collapsed.add(sec);
  localStorage.setItem(LS_COLLAPSED, JSON.stringify([...collapsed]));
}

// ── экспорт / импорт ─────────────────────────────────────────────────────────
const importFileEl = ref<HTMLInputElement | null>(null);
let importKind: 'home' | 'session' = 'home';
function pickImport(kind: 'home' | 'session'): void {
  if (roundActive.value) return;
  importKind = kind;
  importFileEl.value?.click();
}
async function onImportFile(e: Event): Promise<void> {
  const inp = e.target as HTMLInputElement;
  const f = inp.files?.[0];
  if (!f) return;
  try {
    const b64 = await fileToBase64(f);
    send({ type: importKind === 'home' ? 'import_home' : 'import_session', dataB64: b64 });
    addFeed('notice', `· Импорт ${importKind === 'home' ? 'настроек' : 'разговора'} из ${f.name}…`);
  } catch (err) {
    addFeed('error', `✗ ${(err as Error).message}`);
  }
  inp.value = '';
}
function exportHome(): void {
  if (!roundActive.value) send({ type: 'export_home' });
}
function exportSession(): void {
  const cur = sessions.value.findIndex((s) => s.id === currentSessionId.value) + 1;
  if (cur > 0 && !roundActive.value) send({ type: 'export_session', n: cur });
}

// ── вложение ─────────────────────────────────────────────────────────────────
const attachFileEl = ref<HTMLInputElement | null>(null);
function pickAttach(): void {
  attachFileEl.value?.click();
}
async function onAttachFile(e: Event): Promise<void> {
  const inp = e.target as HTMLInputElement;
  const f = inp.files?.[0];
  if (!f || roundActive.value) { inp.value = ''; return; }
  try {
    const b64 = await fileToBase64(f);
    roundActive.value = true;
    send({ type: 'file', name: f.name, dataB64: b64, text: `посмотрите файл ${f.name}` });
    addFeed('notice', `· 📎 ${f.name} (${f.size} Б) — отправлен команде`);
  } catch (err) {
    addFeed('error', `✗ ${(err as Error).message}`);
  }
  inp.value = '';
}

// ── авто-режим и статус ──────────────────────────────────────────────────────
function toggleAuto(): void {
  if (roundActive.value) return;
  send({ type: 'command', text: autoMode.value ? '/auto off' : '/auto on' });
}
function abortRound(): void {
  send({ type: 'abort' });
}

// ── авторизация ──────────────────────────────────────────────────────────────
const authToken = ref('');
function doAuth(): void {
  submitToken(authToken.value);
  authToken.value = '';
}

// ── отправка ─────────────────────────────────────────────────────────────────
const draft = ref('');
const inputEl = ref<HTMLTextAreaElement | null>(null);
function autosize(): void {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}
function sendUserMessage(): void {
  const text = draft.value.trim();
  if (!text || roundActive.value || !authed.value) return;
  draft.value = '';
  autosize();
  hideHints();
  roundActive.value = true;
  if (text.startsWith('/')) {
    // команда: исполняет ядро, отчёты придут notice-событиями в журнал
    send({ type: 'command', text });
  } else {
    messages.push({ authorId: 'user', authorName: profile.value?.name ?? 'Вы', text, ts: Date.now() });
    send({ type: 'user_message', text });
  }
}

// ── автодополнение: @-попап и /-подсказки ────────────────────────────────────
interface HintItem { label: string; hint?: string; insert: string }
const hint = reactive({
  kind: '' as '' | 'at' | 'cmd' | 'arg',
  items: [] as HintItem[],
  sel: 0, from: 0, insertSuffix: '', prefix: '',
});
const hintActive = computed(() => hint.items.length > 0);

const completionData = computed(() => {
  if (!snapshot.completion) return null;
  return {
    operations: commands.value,
    sessions: sessions.value,
    team: team.value,
    providerIds: providers.value.map((p) => p.id),
    managerName: manager.value?.name ?? 'Менеджер',
  };
});

type CompletionData = NonNullable<typeof completionData.value>;

function mentionItems(d: CompletionData): HintItem[] {
  return [
    { label: d.managerName, hint: 'менеджер переговорки', insert: d.managerName + ' ' },
    ...d.team.filter((a) => a.inChat)
      .map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
    { label: 'session', hint: 'конспект другого разговора', insert: 'session ' },
  ];
}

function updateHints(): void {
  const el = inputEl.value;
  if (!el) { hideHints(); return; }
  const pos = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, pos);
  const d = completionData.value;
  if (!d) { hideHints(); return; }

  // @/№ — попап упоминаний (менеджер, участники чата, session)
  const at = /(?:^|\s)([@№])([^\s@№]*)$/.exec(before);
  if (at) {
    const items = mentionItems(d).filter((it) => norm(it.label).startsWith(norm(at[2])));
    if (items.length > 0) {
      Object.assign(hint, {
        kind: 'at', items, sel: 0,
        from: pos - at[1].length - at[2].length,
        insertSuffix: ' ', prefix: at[1],
      });
      return;
    }
    hideHints();
    return;
  }

  // /… — операции и их аргументы
  if (before.startsWith('/')) {
    const sp = before.indexOf(' ');
    if (sp === -1) {
      const frag = before.slice(1);
      const items = d.operations
        .filter((c) => norm(c.cmd).startsWith(norm('/' + frag)))
        .map((c) => ({
          label: c.cmd + (c.args ? ' ' + c.args : ''),
          hint: c.help,
          insert: c.cmd.slice(1) + ' ',
        }));
      if (items.length > 0) {
        Object.assign(hint, { kind: 'cmd', items, sel: 0, from: 1, insertSuffix: '', prefix: '/' });
        return;
      }
    } else {
      const cmdName = before.slice(0, sp);
      const tail = before.slice(sp + 1);
      const last = (/(\S*)$/.exec(tail) || [''])[1];
      const all = argItems(cmdName, d);
      if (all) {
        const items = all.filter((o) => norm(o.label).startsWith(norm(last)));
        if (items.length > 0) {
          Object.assign(hint, { kind: 'arg', items, sel: 0, from: pos - last.length, insertSuffix: '', prefix: '' });
          return;
        }
      }
    }
    hideHints();
    return;
  }

  hideHints();
}

function hideHints(): void {
  hint.kind = '';
  hint.items = [];
  hint.sel = 0;
}

/** Варианты после группы: глаголы операций или значения аргумента (hint манифеста). */
function argItems(cmdName: string, d: CompletionData): HintItem[] | null {
  const parts = cmdName.slice(1).toLowerCase().split(/\s+/).filter(Boolean);
  const group = parts[0] ?? '';
  const verbs = [...new Set(d.operations
    .filter((o) => o.cmd.startsWith('/' + group + ' '))
    .map((o) => o.cmd.split(' ')[1] ?? ''))].filter(Boolean);
  const implicit = d.operations.find((o) => o.cmd === '/' + group);
  if (parts.length === 1) {
    if (implicit && verbs.length === 0) return argHintItems(implicit, 0, d);
    return verbs.map((v) => ({ label: v, hint: '', insert: v + ' ' }));
  }
  const verb = parts[1] ?? '';
  const op = d.operations.find((o) => o.cmd === `/${group} ${verb}`) ?? implicit;
  if (!op) return null;
  const typed = parts.length - (verb && !implicit || op.cmd !== '/' + group ? 1 : 0) - 1;
  return argHintItems(op, Math.max(0, typed), d);
}

/** Значения аргумента по подсказке из манифеста: номера, имена, id, shared. */
function argHintItems(op: OpHint, argPos: number, d: CompletionData): HintItem[] | null {
  const m = /\[([^\]]+)\]/.exec((op.args ?? '').split(' ')[Math.min(argPos, (op.args ?? '').split(' ').length - 1)] ?? '');
  const argName = m?.[1] ?? '';
  if (argName === 'номер' && op.cmd.includes('session')) {
    return d.sessions.map((s, i) => ({ label: String(i + 1), hint: s.title, insert: (i + 1) + ' ' }));
  }
  if (argName === 'номер' || argName === 'имя|номер') {
    return [
      ...d.team.map((a, i) => ({ label: String(i + 1), hint: a.name, insert: (i + 1) + ' ' })),
      ...d.team.map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
      ...(argName === 'имя|номер' ? [] : []),
    ];
  }
  if (argName === 'кого|shared') {
    return [
      ...d.team.map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
      { label: 'shared', hint: 'общая память', insert: 'shared ' },
    ];
  }
  if (argName === 'id' && op.cmd.startsWith('/provider')) {
    return d.providerIds.map((id) => ({ label: id, hint: '', insert: id + ' ' }));
  }
  if (argName === 'тул') {
    return ['files', 'shell', 'ssh', 'look', 'image'].map((t) => ({ label: t, hint: '', insert: t + ' ' }));
  }
  return null;
}

/** Подсказка команды: голова до первого пробела выделяется .cmd, хвост — обычным. */
function cmdHead(label: string): string {
  const i = label.indexOf(' ');
  return i === -1 ? label : label.slice(0, i);
}
function cmdTail(label: string): string {
  const i = label.indexOf(' ');
  return i === -1 ? '' : label.slice(i);
}

function applyHintItem(it: HintItem): void {
  const el = inputEl.value;
  if (!el) return;
  const pos = el.selectionStart ?? el.value.length;
  const text = hint.kind === 'at' ? hint.prefix + it.label + hint.insertSuffix : it.insert;
  el.value = el.value.slice(0, hint.from) + text + el.value.slice(pos);
  draft.value = el.value;
  const np = hint.from + text.length;
  el.setSelectionRange(np, np);
  hideHints();
  autosize();
  updateHints(); // после вставки может открыться следующий уровень
}

function onInputKey(e: KeyboardEvent): void {
  if (hintActive.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      hint.sel = (hint.sel + 1) % hint.items.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      hint.sel = (hint.sel - 1 + hint.items.length) % hint.items.length;
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideHints();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && hint.kind === 'at')) {
      e.preventDefault();
      applyHintItem(hint.items[hint.sel]);
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendUserMessage();
  }
}

onMounted(connectWs);
</script>

<template>
  <!-- ── топбар ──────────────────────────────────────────────────────────── -->
  <header id="topbar">
    <span id="logo">🎬 Dream Team</span>
    <span
      v-if="profile?.name"
      class="badge clickable"
      :title="`${profile.name}${profile.role ? ` · ${profile.role}` : ''} — клик: настройки`"
      @click="openUserProfileForm()"
    >👤 {{ profile.name }}</span>
    <span
      v-if="manager?.name"
      class="badge clickable"
      :title="`${manager.name} (${manager.provider}) — клик: настройки менеджера`"
      @click="openManagerForm()"
    >{{ manager.emoji ?? '🛎' }} {{ manager.name }}</span>
    <button class="tb-btn" title="Настройки" @click="openSettingsForm()">⚙</button>
    <button class="tb-btn" title="Экспорт дома (настройки + история, без .env)" @click="exportHome">⬇</button>
    <button class="tb-btn" title="Импорт дома из zip" @click="pickImport('home')">⬆</button>
    <input ref="importFileEl" type="file" accept=".zip" class="hidden" @change="onImportFile">
    <span class="spacer"></span>
    <span class="conn" :class="{ on: conn === 'on', off: conn !== 'on' }">
      {{ conn === 'on' ? 'на связи' : conn === 'off' ? 'отключено — переподключаюсь…' : 'подключение…' }}
    </span>
    <button v-if="logoutVisible" class="tb-btn" title="Забыть токен доступа на этом устройстве" @click="logout">Выйти</button>
  </header>

  <!-- ── доступ по токену ────────────────────────────────────────────────── -->
  <div v-if="authNeeded" id="auth">
    <div class="auth-box">
      <h2>Доступ к Dream Team</h2>
      <p class="dim">Введите токен доступа (TOKEN из ~/.dreamteam/.env сервера).</p>
      <input
        v-model="authToken"
        type="password"
        placeholder="токен"
        autocomplete="current-password"
        @keydown.enter="doAuth"
      >
      <div v-if="authError" class="errline">{{ authError }}</div>
      <button @click="doAuth">Войти</button>
    </div>
  </div>

  <main id="layout">
    <!-- ── сайдбар ────────────────────────────────────────────────────────── -->
    <aside id="sidebar">
      <section class="side-sec" :class="{ collapsed: collapsed.has('sessions') }" data-sec="sessions">
        <div class="side-head" @click="toggleSec('sessions')">
          <span class="sec-toggle" title="Свернуть/развернуть">▾</span>
          <span class="sec-name">Сессии</span>
          <button class="sec-add" title="Новый разговор" @click.stop="newSession">＋</button>
        </div>
        <div class="sec-btns">
          <button title="Экспорт текущего разговора в zip" @click="exportSession">⬇ сессия</button>
          <button title="Импорт разговора из zip" @click="pickImport('session')">⬆ импорт</button>
        </div>
        <ul id="sessions">
          <li
            v-for="(s, i) in sessions"
            :key="s.id"
            :class="{ active: s.id === currentSessionId }"
            :title="`${s.title}\nid: ${s.id}\nсообщений: ${s.count}\nсоздан: ${fmtDate(s.createdAt)}\nпоследнее сообщение: ${fmtDate(s.updatedAt)}`"
            @click="openSession(i + 1)"
            @dblclick="openSessionRename(i + 1)"
          >
            <div class="content">
              <div class="sess-main"><span>{{ s.title }}</span></div>
              <div class="sub">создан {{ fmtDate(s.createdAt) }}</div>
              <div class="sub">последнее {{ fmtDate(s.updatedAt) }}</div>
            </div>
            <span
              v-if="s.id !== currentSessionId"
              class="del" title="Удалить разговор"
              @click.stop="deleteSession(i + 1, s.title)"
            >✕</span>
          </li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('team') }" data-sec="team">
        <div class="side-head" @click="toggleSec('team')">
          <span class="sec-toggle" title="Свернуть/развернуть">▾</span>
          <span class="sec-name">Команда</span>
          <button class="sec-add" title="Новый агент" @click.stop="openAgentCreate">＋</button>
        </div>
        <ul id="team">
          <li
            v-for="a in team"
            :key="a.id"
            :title="`${a.inChat ? 'Вывести из чата' : 'Позвать в чат'} · двойной клик — настройки`"
            @click="onCliDbl('team:' + a.id, () => toggleChat(a), () => openAgentSettings(a))"
          >
            <div class="content">
              <div class="sess-main">
                <span>{{ a.emoji }} {{ a.name }}</span>
                <span class="tag" :class="{ in: a.inChat }">{{ a.inChat ? 'в чате' : '＋ чат' }}</span>
              </div>
              <div class="sub">{{ a.role ?? '' }}</div>
            </div>
            <span class="del" title="Удалить агента" @click.stop="delAgent(a)">✕</span>
          </li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('providers') }" data-sec="providers">
        <div class="side-head" @click="toggleSec('providers')">
          <span class="sec-toggle" title="Свернуть/развернуть">▾</span>
          <span class="sec-name">Провайдеры</span>
          <button class="sec-add" title="Новый провайдер" @click.stop="providerCreate">＋</button>
        </div>
        <ul id="providers">
          <li
            v-for="p in providers"
            :key="p.id"
            :title="(p.isDefault ? 'Провайдер по умолчанию' : 'Сделать основным (для агентов)')
              + (p.isDefault ? '' : ' · двойной клик — настройки')
              + (p.ok ? '' : ` · проблема: ${p.note ?? ''}`)"
            @click="onCliDbl('provider:' + p.id, () => setProvider(p), () => { if (!p.isDefault) openProviderSettings(p) })"
          >
            <div class="content">
              <div class="sess-main">
                <span>{{ p.ok ? '●' : '○' }} {{ p.id }}</span>
                <span v-if="p.isDefault" class="tag in">основной</span>
              </div>
              <div class="sub">{{ p.model ?? p.kind ?? '' }}{{ p.ok ? '' : ` · ${p.note ?? ''}` }}</div>
            </div>
            <span v-if="!p.isDefault" class="del" title="Удалить провайдера" @click.stop="delProvider(p)">✕</span>
          </li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('schedule') }" data-sec="schedule">
        <div class="side-head" @click="toggleSec('schedule')">
          <span class="sec-toggle" title="Свернуть/развернуть">▾</span>
          <span class="sec-name">Расписание</span>
          <button class="sec-add" title="Новая задача" @click.stop="openScheduleForm(true)">＋</button>
        </div>
        <ul id="schedule-list">
          <li class="static" title="Добавить задачу по расписанию" @click="openScheduleForm(false)">
            <span class="tag">＋ задача</span>
          </li>
          <li
            v-for="t in scheduleTasks"
            :key="t.id"
            :title="`${t.message} — каждые ${t.intervalMinutes} мин`"
            @click="scheduleToggle(t)"
          >
            <span class="tag" :class="{ in: t.enabled }">{{ t.enabled ? '▶' : '⏸' }}</span>
            <span class="meta">{{ t.intervalMinutes }} мин</span>
            <span>{{ t.message.slice(0, 40) }}</span>
            <span class="del" title="Удалить задачу" @click.stop="scheduleDelete(t)">✕</span>
          </li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('projects') }" data-sec="projects">
        <div class="side-head" @click="toggleSec('projects')">
          <span class="sec-toggle" title="Свернуть/развернуть">▾</span>
          <span class="sec-name">Проекты</span>
          <button class="sec-add" title="Новый проект" @click.stop="projectAdd">＋</button>
        </div>
        <ul id="projects">
          <li
            v-for="ph in projects.flatMap((p) => (p.hosts ?? []).map((h) => ({ p, h })))"
            :key="ph.p.id + ':' + ph.h.name"
            title="Двойной клик — удалить проект целиком · ✕ — удалить сервер"
            @dblclick="projectDelete(ph.p)"
          >
            <span>{{ ph.p.id }}</span><span class="meta">{{ ph.h.name }}: {{ ph.h.host }}</span>
            <span class="del" title="Добавить сервер в проект" @click.stop="projectHostAdd(ph.p)">＋</span>
            <span class="del" title="Удалить сервер" @click.stop="projectHostDelete(ph.p, ph.h)">✕</span>
          </li>
        </ul>
      </section>
    </aside>

    <!-- ── чат ────────────────────────────────────────────────────────────── -->
    <section id="chatwrap">
      <div id="chat" ref="chatEl">
        <div id="msgs">
          <template v-for="(m, i) in messages" :key="i">
            <div v-if="m.authorId === 'user'" class="msg user">
              <div class="head">👤 {{ m.authorName }}</div>
              <!-- eslint-disable-next-line vue/no-v-html — контент экранируется в formatText -->
              <div class="txt" v-html="formatText(m.text)"></div>
            </div>
            <div v-else-if="m.authorId === 'tool'" class="toolblock">{{ m.text }}</div>
            <div v-else-if="m.authorId === 'session-ref'" class="attachment">
              <b>📎 {{ m.authorName }}</b>
              <div class="digest">{{ m.text }}</div>
            </div>
            <div v-else class="msg">
              <div class="head" :style="{ color: colorByAuthor(m) }">
                {{ m.authorName }} <span v-if="m.authorRole" class="role">{{ m.authorRole }}</span>
              </div>
              <!-- eslint-disable-next-line vue/no-v-html — контент экранируется в formatText -->
              <div class="txt" v-html="formatText(m.text)"></div>
            </div>
          </template>
          <div v-if="streaming.open" class="msg">
            <div class="head" :style="{ color: colorOf(streaming.color) }">
              {{ streaming.emoji }} {{ streaming.name }}
              <span v-if="streaming.role" class="role">{{ streaming.role }}</span>
            </div>
            <div class="txt">{{ streaming.text }}</div>
          </div>
        </div>
        <div id="feed">
          <div v-for="(n, i) in feed" :key="i" :class="n.kind">{{ n.text }}</div>
        </div>
      </div>

      <div v-if="confirmDialog.show" id="confirm" class="panel">
        <div>
          <b :style="{ color: colorOf(confirmDialog.whoColor) }">{{ confirmDialog.whoEmoji }} {{ confirmDialog.whoName }}</b>
          просит разрешение: {{ confirmDialog.label }}
        </div>
        <div class="dim">{{ confirmDialog.desc }}</div>
        <div class="row">
          <button class="ok" @click="answerConfirm(true)">✓ Разрешить</button>
          <button class="bad" @click="answerConfirm(false)">✗ Отказать</button>
        </div>
      </div>

      <div v-if="chooseDialog.show" id="choose" class="panel">
        <div class="side-head">Какой разговор приложить?</div>
        <ul id="choose-list">
          <li v-for="(it, i) in chooseDialog.items" :key="i" @click="answerChoose(i)">
            {{ i + 1 }}. {{ it.title }} <span class="dim">— {{ it.count }} сообщ.</span>
          </li>
        </ul>
        <div class="row"><button @click="answerChoose(null)">Никакой</button></div>
      </div>

      <div id="statusbar" :class="{ hidden: !statusVisible }">
        <span id="busy-label">{{ busyText }}</span>
        <button v-show="roundActive" id="btn-abort" title="Прервать раунд (Esc в терминале)" @click="abortRound">⏹ Прервать</button>
        <button
          id="btn-auto"
          :class="{ in: autoMode }"
          :title="autoMode
            ? `Автономный режим вкл (осталось ${autoLeft} ходов). Клик — выключить.`
            : 'Автономный режим: агенты решают вопросы сами. Клик — включить.'"
          @click="toggleAuto"
        >🤖 Авто{{ autoMode ? ` (${autoLeft})` : '' }}</button>
      </div>

      <div v-if="hintActive" id="hints">
        <div
          v-for="(it, i) in hint.items"
          :key="i"
          class="row"
          :class="{ sel: i === hint.sel }"
          @click="applyHintItem(it); inputEl?.focus()"
        >
          <template v-if="hint.kind === 'at'">
            <b>{{ hint.prefix + it.label }}</b>
            <span v-if="it.hint" class="dim"> — {{ it.hint }}</span>
          </template>
          <template v-else>
            <span class="cmd">{{ cmdHead(it.label) }}</span>{{ cmdTail(it.label) }}<span v-if="it.hint" class="dim">  — {{ it.hint }}</span>
          </template>
        </div>
      </div>

      <div id="inputrow">
        <button id="btn-attach" title="Прикрепить файл (положится в inbox проекта)" @click="pickAttach">📎</button>
        <input ref="attachFileEl" type="file" class="hidden" @change="onAttachFile">
        <textarea
          id="input"
          ref="inputEl"
          v-model="draft"
          rows="1"
          placeholder="Напишите команде… (Enter — отправить, Shift+Enter — новая строка, @имя — участнику, /help — команды)"
          @keydown="onInputKey"
          @input="autosize(); updateHints()"
          @click="updateHints"
        ></textarea>
        <button id="btn-send" title="Отправить" :disabled="roundActive" @click="sendUserMessage">➤</button>
      </div>
    </section>
  </main>

  <!-- ── модальная форма ─────────────────────────────────────────────────── -->
  <div v-if="modal.show" id="modal" @keydown.esc="closeForm" @keydown.enter.prevent="submitForm">
    <div class="modal-box" ref="modalBox">
      <h2>{{ modal.title }}</h2>
      <div>
        <div v-for="f in modal.fields" :key="f.key" class="fld">
          <label>{{ f.label }}</label>
          <input v-model="f.value" :placeholder="f.placeholder">
        </div>
      </div>
      <div v-if="modal.error" class="errline">{{ modal.error }}</div>
      <div class="row">
        <button @click="submitForm">Сохранить</button>
        <button @click="closeForm">Отмена</button>
      </div>
    </div>
  </div>
</template>
