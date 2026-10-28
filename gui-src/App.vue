<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch, watchEffect } from 'vue';
import type {
  AgentInfo, ChatMessage, OpHint, ProjectHost, ProjectInfo, ProjectRecordInfo,
  ModelInfo, ScheduleTaskInfo, SessionMeta,
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
const teamError = computed(() => snapshot.teamError ?? null);
const models = computed(() => (snapshot.models ?? []) as ModelInfo[]);
const projects = computed(() => (snapshot.projects ?? []) as ProjectInfo[]);
const currentProject = computed(() => snapshot.project);
const knownProjects = computed(() => (snapshot.knownProjects ?? []) as ProjectRecordInfo[]);
const scheduleTasks = computed(() => (snapshot.scheduleTasks ?? []) as ScheduleTaskInfo[]);
const manager = computed(() => snapshot.manager);
const commands = computed(() => (snapshot.completion?.operations ?? []) as OpHint[]);
const autoMode = computed(() => Boolean(snapshot.auto?.mode));
const autoLeft = computed(() => snapshot.auto?.left ?? 0);
const statusVisible = computed(() => roundActive.value || busyCount.value > 0);
const busyText = computed(() => busyLabel.value || (roundActive.value ? tr('раунд идёт…') : ''));

// ── перевод интерфейса: словарь приходит в снапшоте (snapshot.ui.strings) ────
function tr(s: string, vars?: Record<string, string | number>): string {
  let out = snapshot.ui?.strings?.[s] ?? s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

watchEffect(() => {
  const def = models.value.find((p) => p.isDefault);
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
const fmtDate = (ts: number): string => {
  const tag = { ru: 'ru-RU', en: 'en-US', zh: 'zh-CN' }[snapshot.ui?.id ?? 'ru'] ?? 'ru-RU';
  return new Date(ts).toLocaleString(tag);
};

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

// ── контекстное меню (правая кнопка) и подтверждение удаления ────────────────
// двойной клик в интерфейсе не используется: одиночный клик — основное
// действие записи, правая кнопка — меню «Изменить»/«Удалить».
type CtxItem = { label: string; fn: () => void };
const ctx = reactive({ show: false, x: 0, y: 0, items: [] as CtxItem[] });
function openCtx(e: MouseEvent, items: CtxItem[]): void {
  ctx.x = Math.min(e.clientX, window.innerWidth - 180);
  ctx.y = Math.min(e.clientY, window.innerHeight - items.length * 36 - 12);
  ctx.items = items;
  ctx.show = true;
}
function closeCtx(): void { ctx.show = false; }
function runCtx(it: CtxItem): void { closeCtx(); it.fn(); }

const delConfirm = reactive({ show: false, subject: '', fn: null as null | (() => void) });
function askDelete(subject: string, fn: () => void): void {
  delConfirm.subject = subject;
  delConfirm.fn = fn;
  delConfirm.show = true;
}
function answerDelete(yes: boolean): void {
  const fn = delConfirm.fn;
  delConfirm.show = false;
  delConfirm.fn = null;
  if (yes && fn) fn();
}

function ctxTeam(e: MouseEvent, a: AgentInfo): void {
  openCtx(e, [
    { label: tr('Изменить'), fn: () => openAgentSettings(a) },
    { label: tr('Удалить'), fn: () => delAgent(a) },
  ]);
}
function ctxModel(e: MouseEvent, p: ModelInfo): void {
  const items: CtxItem[] = [{ label: tr('Изменить'), fn: () => openModelSettings(p) }];
  if (!p.isDefault) items.push({ label: tr('Удалить'), fn: () => delModel(p) });
  openCtx(e, items);
}
function ctxSession(e: MouseEvent, id: string, title: string): void {
  openCtx(e, [
    { label: tr('Переименовать'), fn: () => openSessionRename(id) },
    { label: tr('Удалить'), fn: () => deleteSession(id, title) },
  ]);
}
function ctxSchedule(e: MouseEvent, t: ScheduleTaskInfo): void {
  openCtx(e, [
    { label: tr(t.enabled ? 'Пауза' : 'Запустить'), fn: () => scheduleToggle(t) },
    { label: tr('Удалить'), fn: () => scheduleDelete(t) },
  ]);
}
function ctxHost(e: MouseEvent, p: ProjectInfo, h: ProjectHost): void {
  openCtx(e, [{ label: tr('Удалить'), fn: () => projectHostDelete(p, h) }]);
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
  openForm(tr('Новый агент'), [
    { key: 'id', label: tr('id (латиница, цифры, ./-/_)') },
    { key: 'name', label: tr('Имя') },
    { key: 'role', label: tr('Роль (можно пропустить)') },
  ], (v) => rpcReport(rpc('agent.new', v)));
}
function openAgentSettings(a: AgentInfo): void {
  openForm(tr('Настройки агента {name}', { name: a.name }), [
    { key: 'role', label: tr('Роль'), value: a.role ?? '' },
    { key: 'model', label: tr('Модель'), value: a.model ?? '' },
    { key: 'temperature', label: tr('Температура (0–2)'), value: a.temperature != null ? String(a.temperature) : '' },
    { key: 'prompt', label: tr('Промпт'), value: a.prompt ?? '' },
    { key: 'tools', label: tr('Тулы через запятую (есть: {list})', { list: (a.tools ?? []).join(', ') || tr('нет') }) },
  ], (v) => {
    const fields: Record<string, unknown> = {};
    // модель и температура — вложенное поле model карточки ({model: {id, temperature}})
    const model: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === '' || k === 'tools') continue;
      if (k === 'model') model.id = val;
      else if (k === 'temperature') model.temperature = Number(val);
      else fields[k] = val;
    }
    if (Object.keys(model).length > 0) fields.model = model;
    if (Object.keys(fields).length > 0) rpcReport(rpc('agent.update', { id: a.id, fields }));
    // новые тулы выдаём по одному (отзыв — /agent tool delete или словом менеджеру)
    const have = new Set(a.tools ?? []);
    for (const tool of (v.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
      if (have.has(tool.toLowerCase())) continue;
      rpcReport(rpc('agent.tool.add', { agent: a.id, tool }));
    }
  });
}
function agentDelete(a: AgentInfo): void {
  askDelete(`агент «${a.name}»`, () => rpcReport(rpc('agent.delete', { id: a.id })));
}
function toggleChat(a: AgentInfo): void {
  if (roundActive.value) return;
  // событие чата придёт репликой менеджера в ленте (со state) — журнал не дублируем
  rpc(a.inChat ? 'session.agent.delete' : 'session.agent.add', { id: a.id })
    .catch((err: Error) => addFeed('error', `✗ ${err.message}`));
}
function delAgent(a: AgentInfo): void {
  if (!roundActive.value) agentDelete(a);
}

// ── модели: создать/удалить/настроить ────────────────────────────────────────
function modelCreate(): void {
  openForm(tr('Новая модель'), [
    { key: 'id', label: tr('id (латиница, цифры, ./-/_)') },
    { key: 'provider', label: tr('Провайдер (openai-compatible / anthropic-compatible / gigachat)'), value: 'openai-compatible' },
    { key: 'baseUrl', label: 'baseUrl' },
    { key: 'model', label: tr('Модель') },
    { key: 'apiKey', label: tr('Ключ API (можно пусто — для локальных API)') },
  ], (v) => rpcReport(rpc('model.new', { id: v.id, config: v })));
}
function modelDelete(p: ModelInfo): void {
  if (p.isDefault) return;
  askDelete(`модель «${p.id}»`, () => rpcReport(rpc('model.delete', { id: p.id })));
}
function setModel(p: ModelInfo): void {
  if (roundActive.value || p.isDefault) return;
  // «сделать текущей» — поле владельца: settings.update model.id=…
  rpc('settings.update', { patch: { model: { id: p.id } } })
    .catch((err: Error) => addFeed('error', `✗ ${err.message}`));
}
function delModel(p: ModelInfo): void {
  if (!roundActive.value) modelDelete(p);
}
function openModelSettings(p: ModelInfo): void {
  openForm(tr('Модель {id}', { id: p.id }), [
    { key: 'provider', label: tr('Провайдер (openai-compatible / anthropic-compatible / gigachat / mock)'), value: p.kind },
    { key: 'model', label: tr('Модель'), value: p.model ?? '' },
    { key: 'baseUrl', label: tr('baseUrl (пусто — не менять)'), value: p.baseUrl ?? '' },
    { key: 'apiKey', label: tr('Ключ API (пусто — не менять)'), value: '' },
  ], (v) => {
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== '') fields[k] = val;
    rpcReport(rpc('model.update', { id: p.id, fields }));
  });
}

// ── настройки / пользователь / менеджер ──────────────────────────────────────
function openSettingsForm(): void {
  const st = snapshot.settings;
  if (!st) return;
  openForm(tr('Настройки'), [
    { key: 'language', label: tr('Язык общения (russian / ru-RU / english…)'), value: st.language ?? '' },
    { key: 'autoMessage', label: tr('Автоответ в автономном режиме'), value: st.autoMessage ?? '' },
    { key: 'ui', label: tr('Язык интерфейса (ru / en / zh / свой из ~/.dreamteam/lang)'), value: snapshot.ui?.id ?? '' },
    { key: 'width', label: tr('Ширина экрана (40–500)'), value: st.width != null ? String(st.width) : '' },
  ], (v) => {
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== '') patch[k] = k === 'width' ? Number(val) : val;
    rpc('settings.update', { patch })
      .then(() => addFeed('notice', `· ${tr('настройки сохранены')}`))
      .catch((err: Error) => addFeed('error', `✗ ${err.message}`));
  });
}
function openUserProfileForm(): void {
  const p = profile.value;
  if (!p) return;
  openForm(tr('Пользователь'), [
    { key: 'name', label: tr('Имя'), value: p.name ?? '' },
    { key: 'role', label: tr('Роль'), value: p.role ?? '' },
    { key: 'about', label: tr('О себе'), value: p.about ?? '' },
  ], (v) => rpcReport(rpc('profile.update', v)));
}
function openManagerForm(): void {
  const mgr = manager.value;
  if (!mgr) return;
  openForm(tr('Менеджер переговорки'), [
    { key: 'name', label: tr('Имя'), value: mgr.name ?? '' },
    { key: 'emoji', label: 'Emoji', value: mgr.emoji ?? '' },
    { key: 'color', label: tr('Цвет (yellow/cyan/…)'), value: mgr.color ?? '' },
    { key: 'temperature', label: tr('Температура (0–2)'), value: mgr.temperature != null ? String(mgr.temperature) : '' },
  ], (v) => {
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== '') fields[k] = k === 'temperature' ? Number(val) : val;
    rpcReport(rpc('manager.update', { fields }));
  });
}

// ── проекты ──────────────────────────────────────────────────────────────────
/** Открыть другой проект: имя из списка или папка на диске (смена разговоров). */
function openProjectForm(): void {
  if (roundActive.value) return;
  openForm(tr('Открыть проект'), [
    { key: 'path', label: tr('Имя из списка или путь к папке') },
  ], (v) => {
    const path = String(v.path ?? '').trim();
    if (path) rpcReport(rpc('project.open', { path }));
  });
}
/** Новый проект: дом создаст projects/<id>/ и откроет его. */
function newProjectForm(): void {
  if (roundActive.value) return;
  openForm(tr('Новый проект'), [
    { key: 'id', label: tr('id проекта (без пробелов)') },
    { key: 'path', label: tr('Рабочая папка (создастся, если нет — можно пропустить)') },
  ], (v) => {
    const id = String(v.id ?? '').trim();
    if (!id) return;
    rpcReport(rpc('project.new', { id, path: String(v.path ?? '').trim() || undefined }));
  });
}
function switchProject(p: ProjectRecordInfo): void {
  if (roundActive.value) return;
  if (currentProject.value && p.name === currentProject.value.id) return;
  rpcReport(rpc('project.open', p.path ? { path: p.path } : { id: p.name }));
}
/** Переименовать текущий проект (папка в доме + id). */
function renameProjectForm(): void {
  if (roundActive.value) return;
  openForm(tr('Переименовать проект'), [
    { key: 'name', label: tr('Новое имя (без пробелов)'), value: currentProject.value?.name ?? '' },
  ], (v) => {
    const name = String(v.name ?? '').trim();
    if (name) rpcReport(rpc('project.update', { name }));
  });
}
/** Сменить рабочую папку текущего проекта. */
function projectPathForm(): void {
  if (roundActive.value) return;
  openForm(tr('Рабочая папка проекта'), [
    { key: 'path', label: tr('Путь к папке (создастся, если нет)'), value: currentProject.value?.path ?? '' },
  ], (v) => {
    const path = String(v.path ?? '').trim();
    if (path) rpcReport(rpc('project.update', { path }));
  });
}
function ctxProjectCurrent(e: MouseEvent): void {
  if (!currentProject.value) return;
  openCtx(e, [
    { label: tr('Переименовать'), fn: renameProjectForm },
    { label: tr('Сменить рабочую папку'), fn: projectPathForm },
  ]);
}
function ctxProjectKnown(e: MouseEvent, p: ProjectRecordInfo): void {
  openCtx(e, [{ label: tr('Удалить из дома (разговоры тоже)'), fn: () =>
    askDelete(tr('проект «{name}»', { name: p.name }), () => rpcReport(rpc('project.delete', { id: p.name }))) }]);
}
/** Первый сервер проекта (когда список серверов ещё пуст): из контекстного меню. */
function projectAdd(): void {
  openForm(tr('Новый сервер проекта'), [
    { key: 'id', label: tr('id сервера (напр. prod)') },
    { key: 'host', label: tr('Хост (адрес)') },
    { key: 'user', label: tr('Пользователь (можно пропустить)') },
    { key: 'port', label: tr('Порт (можно пропустить)') },
  ], (v) => rpcReport(rpc('project.host.add', v)));
}
function projectHostAdd(p: ProjectInfo): void {
  if (roundActive.value) return;
  openForm(tr('Сервер проекта «{id}»', { id: p.id }), [
    { key: 'id', label: tr('id сервера (напр. prod)') },
    { key: 'host', label: tr('Хост (адрес)') },
    { key: 'user', label: tr('Пользователь (можно пропустить)') },
    { key: 'port', label: tr('Порт (можно пропустить)') },
  ], (v) => rpcReport(rpc('project.host.add', v)));
}
function projectHostDelete(p: ProjectInfo, h: ProjectHost): void {
  if (roundActive.value) return;
  askDelete(tr('сервер «{name}» проекта «{id}»', { name: h.name, id: p.id }), () => rpcReport(rpc('project.host.delete', { id: h.name })));
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
  openForm(tr('Задача по расписанию'), [
    { key: 'message', label: tr('Задание (уйдёт в чат как сообщение)') },
    { key: 'intervalMinutes', label: tr('Каждые N минут'), value: '10' },
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
  askDelete(tr('задача «{msg}»', { msg: t.message.slice(0, 40) }), () =>
    rpc('schedule.delete', { id: t.id }).catch((err: Error) => addFeed('error', `✗ ${err.message}`)));
}

// ── сессии ───────────────────────────────────────────────────────────────────
function openSessionRename(id: string): void {
  if (roundActive.value) return;
  const meta = sessions.value.find((s) => s.id === id);
  if (!meta) return;
  openForm(tr('Переименовать «{title}»', { title: meta.title }), [
    { key: 'name', label: tr('Новое имя (пусто — менеджер придумает)'), value: meta.title },
  ], (v) => {
    // session.update правит ТЕКУЩИЙ разговор — сначала открываем выбранный
    rpcReport(rpc('session.open', { id }).then(() => rpc('session.update', { title: v.name })));
  });
}
function newSession(): void {
  if (roundActive.value) return;
  roundActive.value = true;
  rpc('session.new', {}).catch((err: Error) => addFeed('error', `✗ ${err.message}`));
}
function openSession(id: string): void {
  if (!roundActive.value) rpc('session.open', { id }).catch(() => {});
}
function deleteSession(id: string, title: string): void {
  askDelete(tr('разговор «{title}»', { title }), () => rpcReport(rpc('session.delete', { id })));
}

// ── сворачивание секций (localStorage) ───────────────────────────────────────
const LS_COLLAPSED = 'dt-collapsed';
const DEFAULT_COLLAPSED = ['team', 'models', 'schedule', 'projects'];
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
/** Секция свёрнута? Без открытого проекта панель проектов всегда развёрнута:
 *  выбор проекта — первое действие в оболочке. */
function isCollapsed(sec: string): boolean {
  if (sec === 'projects' && !currentProject.value) return false;
  return collapsed.has(sec);
}

// ── экспорт / импорт ─────────────────────────────────────────────────────────
const importFileEl = ref<HTMLInputElement | null>(null);
type ImportKind = 'home' | 'settings' | 'project' | 'session';
let importKind: ImportKind = 'home';
/** Какое сообщение серверу соответствует каждому уровню импорта. */
const IMPORT_TYPE: Record<ImportKind, 'import_home' | 'import_settings' | 'import_project' | 'import_session'> = {
  home: 'import_home',
  settings: 'import_settings',
  project: 'import_project',
  session: 'import_session',
};
function pickImport(kind: ImportKind): void {
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
    send({ type: IMPORT_TYPE[importKind], dataB64: b64 });
    addFeed('notice', `· ${tr('Импорт из {file}…', { file: f.name })}`);
  } catch (err) {
    addFeed('error', `✗ ${(err as Error).message}`);
  }
  inp.value = '';
}
function exportHome(): void {
  if (!roundActive.value) send({ type: 'export_home' });
}
function exportSettings(): void {
  if (!roundActive.value) send({ type: 'export_settings' });
}
function exportProject(): void {
  if (!roundActive.value) send({ type: 'export_project' });
}
function exportSession(): void {
  if (currentSessionId.value && !roundActive.value) send({ type: 'export_session', id: currentSessionId.value });
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
    send({ type: 'file', name: f.name, dataB64: b64, text: tr('посмотрите файл {file}', { file: f.name }) });
    addFeed('notice', `· 📎 ${f.name} (${f.size} ${tr('Б')}) — ${tr('отправлен команде')}`);
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
    messages.push({ authorId: 'user', authorName: profile.value?.name ?? tr('Вы'), text, ts: Date.now() });
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
    modelIds: models.value.map((p) => p.id),
    managerName: manager.value?.name ?? 'Менеджер',
  };
});

type CompletionData = NonNullable<typeof completionData.value>;

function mentionItems(d: CompletionData): HintItem[] {
  return [
    { label: d.managerName, hint: tr('менеджер переговорки'), insert: d.managerName + ' ' },
    ...d.team.filter((a) => a.inChat)
      .map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
    { label: 'session', hint: tr('конспект другого разговора'), insert: 'session ' },
  ];
}

function updateHints(): void {
  const el = inputEl.value;
  if (!el) { hideHints(); return; }
  const pos = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, pos);
  const d = completionData.value;
  if (!d) { hideHints(); return; }

  // @/! — попап упоминаний (менеджер, участники чата, session)
  const at = /(?:^|\s)([@!])([^\s@!]*)$/.exec(before);
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
      const last = (/(\S*)$/.exec(before) || [''])[1];
      const all = argItems(before, d);
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

/** Варианты после первого слова: подглаголы третьего уровня, глаголы или значения аргументов. */
function argItems(before: string, d: CompletionData): HintItem[] | null {
  const trailing = /\s$/.test(before);
  const parts = before.slice(1).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const group = parts[0] ?? '';
  const verbItems = (list: string[]) => list.map((v) => ({ label: v, hint: '', insert: v + ' ' }));
  const verbs = [...new Set(d.operations
    .filter((o) => o.cmd.toLowerCase().startsWith('/' + group + ' '))
    .map((o) => o.cmd.split(' ')[1] ?? ''))].filter(Boolean);
  const implicit = d.operations.find((o) => o.cmd.toLowerCase() === '/' + group);
  if (parts.length === 1) {
    if (implicit && verbs.length === 0) return argHintItems(implicit, 0, d);
    return verbItems(verbs);
  }
  // третий уровень: подглаголы (session agent add|delete, agent tool …)
  const sub = [...new Set(d.operations
    .filter((o) => o.cmd.toLowerCase().startsWith(`/${group} ${parts[1]} `))
    .map((o) => o.cmd.split(' ')[2] ?? ''))].filter(Boolean);
  const exact = parts.length >= 3
    ? d.operations.find((o) => o.cmd.toLowerCase() === `/${group} ${parts[1]} ${parts[2]}`)
    : undefined;
  if (sub.length > 0) {
    if (parts.length === 2) return verbItems(sub);
    if (exact) {
      const argPos = Math.max(0, parts.length - 3 + (trailing ? 1 : 0) - 1);
      return argHintItems(exact, argPos, d);
    }
    if (parts.length === 3) {
      return verbItems(sub.filter((v) => v.startsWith(parts[2]) && v !== parts[2]));
    }
  }
  const op = d.operations.find((o) => o.cmd.toLowerCase() === `/${group} ${parts[1]}`) ?? implicit;
  if (!op) return parts.length === 2 && !trailing ? verbItems(verbs) : null;
  const argPos = Math.max(0, parts.length - (op === implicit ? 1 : 2) + (trailing ? 1 : 0) - 1);
  return argHintItems(op, argPos, d);
}

/** Значения аргумента по машиночитаемой подсказке манифеста (id, тулы, shared). */
function argHintItems(op: OpHint, argPos: number, d: CompletionData): HintItem[] | null {
  const hints = op.hints ?? [];
  const hint = hints[Math.min(argPos, Math.max(hints.length - 1, 0))] ?? '';
  if (hint === 'sessions') {
    return d.sessions.map((s) => ({ label: s.id, hint: s.title, insert: s.id + ' ' }));
  }
  if (hint === 'agents') {
    return d.team.map((a) => ({ label: a.id, hint: a.name, insert: a.id + ' ' }));
  }
  if (hint === 'chat') {
    return d.team.filter((a) => a.inChat).map((a) => ({ label: a.id, hint: a.name, insert: a.id + ' ' }));
  }
  if (hint === 'models') {
    return d.modelIds.map((id) => ({ label: id, hint: '', insert: id + ' ' }));
  }
  // память: «кого|shared» из имени аргумента; тулы — тоже из имени
  const args = (op.args ?? '').split(' ');
  const argName = args[Math.min(argPos, args.length - 1)] ?? '';
  if (argName.includes('shared')) {
    return [
      ...d.team.map((a) => ({ label: a.id, hint: a.name, insert: a.id + ' ' })),
      { label: 'shared', hint: tr('общая память'), insert: 'shared ' },
    ];
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
      :title="`${profile.name}${profile.role ? ` · ${profile.role}` : ''} — ${tr('клик: настройки')}`"
      @click="openUserProfileForm()"
    >👤 {{ profile.name }}</span>
    <span
      v-if="manager?.name"
      class="badge clickable"
      :title="`${manager.name} (${manager.model ?? ''}) — ${tr('клик: настройки менеджера')}`"
      @click="openManagerForm()"
    >{{ manager.emoji ?? '🛎' }} {{ manager.name }}</span>
    <button class="tb-btn" :title="tr('Настройки')" @click="openSettingsForm()">⚙</button>
    <button class="tb-btn" :title="tr('Экспорт всего приложения (дом и все проекты, без .env)')" @click="exportHome">⬇</button>
    <button class="tb-btn" :title="tr('Импорт всего приложения из zip')" @click="pickImport('home')">⬆</button>
    <button class="tb-btn" :title="tr('Экспорт настроек (без проектов)')" @click="exportSettings">⬇⚙</button>
    <button class="tb-btn" :title="tr('Импорт настроек из zip (проекты не трогаются)')" @click="pickImport('settings')">⬆⚙</button>
    <input ref="importFileEl" type="file" accept=".zip" class="hidden" @change="onImportFile">
    <span class="spacer"></span>
    <span class="conn" :class="{ on: conn === 'on', off: conn !== 'on' }">
      {{ conn === 'on' ? tr('на связи') : conn === 'off' ? tr('отключено — переподключаюсь…') : tr('подключение…') }}
    </span>
    <button v-if="logoutVisible" class="tb-btn" :title="tr('Забыть токен доступа на этом устройстве')" @click="logout">{{ tr('Выйти') }}</button>
  </header>

  <!-- ── доступ по токену ────────────────────────────────────────────────── -->
  <div v-if="authNeeded" id="auth">
    <div class="auth-box">
      <h2>{{ tr('Доступ к Dream Team') }}</h2>
      <p class="dim">{{ tr('Введите токен доступа (TOKEN из ~/.dreamteam/.env сервера).') }}</p>
      <input
        v-model="authToken"
        type="password"
        :placeholder="tr('токен')"
        autocomplete="current-password"
        @keydown.enter="doAuth"
      >
      <div v-if="authError" class="errline">{{ authError }}</div>
      <button @click="doAuth">{{ tr('Войти') }}</button>
    </div>
  </div>

  <main id="layout">
    <!-- ── сайдбар ────────────────────────────────────────────────────────── -->
    <aside id="sidebar">
      <section class="side-sec" :class="{ collapsed: collapsed.has('sessions') }" data-sec="sessions">
        <div class="side-head" @click="toggleSec('sessions')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Сессии') }}</span>
          <button class="sec-add" :title="tr('Новый разговор')" @click.stop="newSession">＋</button>
        </div>
        <div class="sec-btns">
          <button :title="tr('Экспорт текущего разговора в zip')" @click="exportSession">⬇ {{ tr('сессия') }}</button>
          <button :title="tr('Импорт разговора из zip')" @click="pickImport('session')">⬆ {{ tr('импорт') }}</button>
        </div>
        <ul id="sessions">
          <li
            v-for="s in sessions"
            :key="s.id"
            :class="{ active: s.id === currentSessionId }"
            :title="`${s.title}\nid: ${s.id}\n${tr('сообщений:')} ${s.count}\n${tr('создан:')} ${fmtDate(s.createdAt)}\n${tr('последнее сообщение:')} ${fmtDate(s.updatedAt)}`"
            @click="openSession(s.id)"
            @contextmenu.prevent="ctxSession($event, s.id, s.title)"
          >
            <div class="content">
              <div class="sess-main"><span>{{ s.title }}</span></div>
              <div class="sub">{{ tr('создан') }} {{ fmtDate(s.createdAt) }}</div>
              <div class="sub">{{ tr('последнее') }} {{ fmtDate(s.updatedAt) }}</div>
            </div>
            <span
              v-if="s.id !== currentSessionId"
              class="del" :title="tr('Удалить разговор')"
              @click.stop="deleteSession(s.id, s.title)"
            >✕</span>
          </li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('team') }" data-sec="team">
        <div class="side-head" @click="toggleSec('team')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Команда') }}</span>
          <button class="sec-add" :title="tr('Новый агент')" @click.stop="openAgentCreate">＋</button>
        </div>
        <div v-if="teamError" class="errline side-err">agents.json: {{ teamError }}</div>
        <ul id="team">
          <li
            v-for="a in team"
            :key="a.id"
            :title="`${a.inChat ? tr('Вывести из чата') : tr('Позвать в чат')} · ${tr('правая кнопка — изменить/удалить')}`"
            @click="toggleChat(a)"
            @contextmenu.prevent="ctxTeam($event, a)"
          >
            <div class="content">
              <div class="sess-main">
                <span>{{ a.emoji }} {{ a.name }}</span>
                <span class="tag" :class="{ in: a.inChat }">{{ a.inChat ? tr('в чате') : '＋ ' + tr('чат') }}</span>
              </div>
              <div class="sub">{{ a.role ?? '' }}</div>
            </div>
            <span class="del" :title="tr('Удалить агента')" @click.stop="delAgent(a)">✕</span>
          </li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('models') }" data-sec="models">
        <div class="side-head" @click="toggleSec('models')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Модели') }}</span>
          <button class="sec-add" :title="tr('Новая модель')" @click.stop="modelCreate">＋</button>
        </div>
        <ul id="models">
          <li
            v-for="p in models"
            :key="p.id"
            :title="(p.isDefault ? tr('Модель по умолчанию') : tr('Сделать основной (для агентов)'))
              + (p.isDefault ? '' : ` · ${tr('клик — сделать основным')} · ${tr('правая кнопка — изменить/удалить')}`)
              + (p.ok ? '' : ` · ${tr('проблема:')} ${p.note ?? ''}`)"
            @click="setModel(p)"
            @contextmenu.prevent="ctxModel($event, p)"
          >
            <div class="content">
              <div class="sess-main">
                <span>{{ p.ok ? '●' : '○' }} {{ p.id }}</span>
                <span v-if="p.isDefault" class="tag in">{{ tr('основная') }}</span>
              </div>
              <div class="sub">{{ p.model ?? p.kind ?? '' }}{{ p.ok ? '' : ` · ${p.note ?? ''}` }}</div>
            </div>
            <span v-if="!p.isDefault" class="del" :title="tr('Удалить модель')" @click.stop="delModel(p)">✕</span>
          </li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('schedule') }" data-sec="schedule">
        <div class="side-head" @click="toggleSec('schedule')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Расписание') }}</span>
          <button class="sec-add" :title="tr('Новая задача')" @click.stop="openScheduleForm(true)">＋</button>
        </div>
        <ul id="schedule-list">
          <li class="static" :title="tr('Добавить задачу по расписанию')" @click="openScheduleForm(false)">
            <span class="tag">＋ {{ tr('задача') }}</span>
          </li>
          <li
            v-for="t in scheduleTasks"
            :key="t.id"
            :title="`${t.message} — ${tr('каждые {n} мин', { n: t.intervalMinutes })} · ${tr('клик — пауза/пуск')} · ${tr('правая кнопка — удалить')}`"
            @click="scheduleToggle(t)"
            @contextmenu.prevent="ctxSchedule($event, t)"
          >
            <span class="tag" :class="{ in: t.enabled }">{{ t.enabled ? '▶' : '⏸' }}</span>
            <span class="meta">{{ t.intervalMinutes }} {{ tr('мин') }}</span>
            <span>{{ t.message.slice(0, 40) }}</span>
            <span class="del" :title="tr('Удалить задачу')" @click.stop="scheduleDelete(t)">✕</span>
          </li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: isCollapsed('projects') }" data-sec="projects">
        <div class="side-head" @click="toggleSec('projects')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Проекты') }}</span>
          <button class="sec-add" :title="tr('Новый проект')" @click.stop="newProjectForm">📁＋</button>
          <button class="sec-add" :title="tr('Открыть проект (имя или папка)')" @click.stop="openProjectForm">📂</button>
        </div>
        <div class="sec-btns">
          <button :title="tr('Экспорт текущего проекта в zip (project.json и разговоры)')" @click="exportProject">⬇ {{ tr('проект') }}</button>
          <button :title="tr('Импорт проекта из zip')" @click="pickImport('project')">⬆ {{ tr('импорт') }}</button>
        </div>
        <ul id="projects">
          <li
            class="proj-current"
            data-project-current
            :title="tr('Текущий проект — его данные в доме, projects/<id>/ · правая кнопка — переименовать/папка')"
            @contextmenu.prevent="ctxProjectCurrent($event)"
          >
            <span>📁 {{ currentProject?.name ?? tr('не выбран — выберите или создайте') }}</span><span class="meta">{{ currentProject?.path }}</span>
          </li>
          <li
            v-for="p in knownProjects.filter((k) => k.name !== currentProject?.id)"
            :key="p.name"
            class="proj-row"
            :title="p.path + ' — ' + tr('переключиться · правая кнопка — удалить из дома')"
            @click.stop="switchProject(p)"
            @contextmenu.prevent="ctxProjectKnown($event, p)"
          >
            <span>{{ p.name }}</span><span class="meta">{{ p.path }}</span>
          </li>
          <li
            v-for="ph in projects.flatMap((p) => (p.hosts ?? []).map((h) => ({ p, h })))"
            :key="ph.p.id + ':' + ph.h.name"
            title="✕ — удалить сервер · ＋ — добавить сервер · правая кнопка — удалить"
            @contextmenu.prevent="ctxHost($event, ph.p, ph.h)"
          >
            <span>{{ ph.p.id }}</span><span class="meta">{{ ph.h.name }}: {{ ph.h.host }}</span>
            <span class="del" :title="tr('Добавить сервер в проект')" @click.stop="projectHostAdd(ph.p)">＋</span>
            <span class="del" :title="tr('Удалить сервер')" @click.stop="projectHostDelete(ph.p, ph.h)">✕</span>
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
          {{ tr('просит разрешение:') }} {{ confirmDialog.label }}
        </div>
        <div class="dim">{{ confirmDialog.desc }}</div>
        <div class="row">
          <button class="ok" @click="answerConfirm(true)">✓ {{ tr('Разрешить') }}</button>
          <button class="bad" @click="answerConfirm(false)">✗ {{ tr('Отказать') }}</button>
        </div>
      </div>

      <div v-if="chooseDialog.show" id="choose" class="panel">
        <div class="side-head">{{ tr('Какой разговор приложить?') }}</div>
        <ul id="choose-list">
          <li v-for="(it, i) in chooseDialog.items" :key="i" @click="answerChoose(i)">
            {{ i + 1 }}. {{ it.title }} <span class="dim">— {{ tr('{n} сообщ.', { n: it.count }) }}</span>
          </li>
        </ul>
        <div class="row"><button @click="answerChoose(null)">{{ tr('Никакой') }}</button></div>
      </div>

      <div id="statusbar" :class="{ hidden: !statusVisible }">
        <span id="busy-label">{{ busyText }}</span>
        <button v-show="roundActive" id="btn-abort" :title="tr('Прервать раунд (Esc в терминале)')" @click="abortRound">⏹ {{ tr('Прервать') }}</button>
        <button
          id="btn-auto"
          :class="{ in: autoMode }"
          :title="autoMode
            ? `Автономный режим вкл (осталось ${autoLeft} ходов). Клик — выключить.`
            : 'Автономный режим: агенты решают вопросы сами. Клик — включить.'"
          @click="toggleAuto"
        >🤖 {{ tr('Авто') }}{{ autoMode ? ` (${autoLeft})` : '' }}</button>
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
        <button id="btn-attach" :title="tr('Прикрепить файл (положится в inbox проекта)')" @click="pickAttach">📎</button>
        <input ref="attachFileEl" type="file" class="hidden" @change="onAttachFile">
        <textarea
          id="input"
          ref="inputEl"
          v-model="draft"
          rows="1"
          :placeholder="tr('Напишите команде… (Enter — отправить, Shift+Enter — новая строка, @имя — участнику, /help — команды)')"
          @keydown="onInputKey"
          @input="autosize(); updateHints()"
          @click="updateHints"
        ></textarea>
        <button id="btn-send" :title="tr('Отправить')" :disabled="roundActive" @click="sendUserMessage">➤</button>
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
        <button @click="submitForm">{{ tr('Сохранить') }}</button>
        <button @click="closeForm">{{ tr('Отмена') }}</button>
      </div>
    </div>
  </div>

  <!-- ── контекстное меню (правая кнопка) ───────────────────────────────────── -->
  <template v-if="ctx.show">
    <div class="ctx-overlay" @click="closeCtx" @contextmenu.prevent="closeCtx"></div>
    <div class="ctx-menu" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }">
      <button v-for="(it, i) in ctx.items" :key="i" @click="runCtx(it)">{{ it.label }}</button>
    </div>
  </template>

  <!-- ── подтверждение удаления ──────────────────────────────────────────────── -->
  <div v-if="delConfirm.show" id="modal" @click.self="answerDelete(false)">
    <div class="modal-box">
      <h2>{{ tr('Вы точно хотите удалить запись?') }}</h2>
      <p class="confirm-subject">{{ delConfirm.subject }}</p>
      <div class="row">
        <button class="bad" @click="answerDelete(true)">{{ tr('Да') }}</button>
        <button @click="answerDelete(false)">{{ tr('Нет') }}</button>
      </div>
    </div>
  </div>
</template>
