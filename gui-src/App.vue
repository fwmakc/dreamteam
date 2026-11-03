<script setup lang="ts">
import MarkdownIt from 'markdown-it';
import { computed, nextTick, onMounted, reactive, ref, watch, watchEffect } from 'vue';
import type {
  AgentInfo, CardSchema, ChatMessage, DirListing, FieldSpec, MailInfo, MessengerInfo, OpHint,
  ProjectHost, ProjectInfo, ProjectRecordInfo, ModelInfo, ScheduleTaskInfo, SessionMeta,
  SessionUsage, LanguageInfo,
} from './types';
import {
  addFeed, answerChoose, answerConfirm, authError, authNeeded, authed, busyCount, busyLabel,
  colorOf, confirmDialog, conn, connectWs, chooseDialog, fileToBase64, feed, logout, messages,
  norm, rpc, roundActive, send, snapshot, streaming, submitToken, logoutVisible, uploadFile,
  type FeedItem,
} from './stores/ws';

// ── проекции снапшота ────────────────────────────────────────────────────────
const profile = computed(() => snapshot.profile);
const sessions = computed(() => (snapshot.sessions ?? []) as SessionMeta[]);
const currentSessionId = computed(() => snapshot.session?.id ?? '');
const team = computed(() => (snapshot.team ?? []) as AgentInfo[]);
const teamError = computed(() => snapshot.teamError ?? null);
const models = computed(() => (snapshot.models ?? []) as ModelInfo[]);
/** image-модели (генерация картинок): в общем списке сайдбара, но с меткой
 *  и своим кликом (карточка вместо «сделать основной») */
const imageModels = computed<ModelInfo[]>(() =>
  ((snapshot.images ?? []) as { id: string; ok: boolean; note?: string; kind?: string; model?: string; provider?: string }[]).map((m) => ({
    id: m.id, kind: m.kind ?? 'unconfigured', model: m.model, provider: m.provider, ok: m.ok, note: m.note,
    img: true, isDefault: false, isManager: false,
  })),
);
const projects = computed(() => (snapshot.projects ?? []) as ProjectInfo[]);
const currentProject = computed(() => snapshot.project);
const knownProjects = computed(() => (snapshot.knownProjects ?? []) as ProjectRecordInfo[]);
const scheduleTasks = computed(() => (snapshot.scheduleTasks ?? []) as ScheduleTaskInfo[]);

// ── фильтры секций сайдбара: у проектов/расписания — строка ввода в секции;
// у сессий/агентов/моделей — модальное окно («Применить»/«Отмена» закрывают,
// «Очистить» чистит и сразу применяет, не закрывая). Значок ▽ горит акцентом,
// пока фильтр секции задан ──
const sideFilter = reactive({
  projects: { open: false, text: '' },
  sessions: { open: false, text: '' },
  team: { open: false, text: '' },
  models: { open: false, text: '' },
  schedule: { open: false, text: '' },
} as Record<'projects' | 'sessions' | 'team' | 'models' | 'schedule', { open: boolean; text: string }>);
/** Применённые поля модальных фильтров (то, что реально режет список). */
const sideExt = reactive({
  sessions: { createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '' },
  team: { tools: '', chat: '' },
  models: { provider: '', kind: '', vision: '' },
});
function sideTextOn(key: 'sessions' | 'team' | 'models'): boolean {
  return sideFilter[key].text.trim().length > 0;
}
function sideOn(key: keyof typeof sideFilter): boolean {
  if (key === 'sessions') {
    const e = sideExt.sessions;
    return sideTextOn('sessions') || Boolean(e.createdFrom || e.createdTo || e.updatedFrom || e.updatedTo);
  }
  if (key === 'team') {
    const e = sideExt.team;
    return sideTextOn('team') || Boolean(e.tools.trim() || e.chat);
  }
  if (key === 'models') {
    const e = sideExt.models;
    return sideTextOn('models') || Boolean(e.provider || e.kind || e.vision);
  }
  return sideFilter[key].text.trim().length > 0;
}
function sideMatch(key: keyof typeof sideFilter, hay: string): boolean {
  const q = sideFilter[key].text.trim().toLowerCase();
  return !q || hay.toLowerCase().includes(q);
}
function sideFilterToggle(key: keyof typeof sideFilter): void {
  // у трёх секций фильтр живёт в модалке, у остальных — строка в секции
  if (key === 'sessions' || key === 'team' || key === 'models') openFilterModal(key);
  else sideFilter[key].open = !sideFilter[key].open;
}
function sideFilterEsc(key: keyof typeof sideFilter): void {
  // Esc в строке: сначала стереть текст, потом спрять строку
  if (sideFilter[key].text) sideFilter[key].text = '';
  else sideFilter[key].open = false;
}
/** Попадание времени (epoch ms) в диапазон дат 'YYYY-MM-DD' (границы включительно, пусто — без ограничения). */
function dateHit(ts: number, from: string, to: string): boolean {
  if (from && ts < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && ts > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

// ── модалка фильтров: черновик — копия применённого на момент открытия;
// «Отмена» бросает черновик, «Применить» записывает его и закрывает,
// «Очистить» чистит и сразу применяет (окно остаётся открытым) ──
const filterModal = reactive({
  show: false,
  sec: 'sessions' as 'sessions' | 'team' | 'models',
  sessions: { text: '', createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '' },
  team: { text: '', tools: '', chat: '' },
  models: { text: '', provider: '', kind: '', vision: '' },
});
const filterBox = ref<HTMLElement | null>(null);
function openFilterModal(sec: 'sessions' | 'team' | 'models'): void {
  filterModal.sec = sec;
  Object.assign(filterModal.sessions, { text: sideFilter.sessions.text, ...sideExt.sessions });
  Object.assign(filterModal.team, { text: sideFilter.team.text, ...sideExt.team });
  Object.assign(filterModal.models, { text: sideFilter.models.text, ...sideExt.models });
  filterModal.show = true;
  nextTick(() => filterBox.value?.querySelector<HTMLElement>('input, select')?.focus());
}
function commitFilterDraft(): void {
  const s = filterModal.sessions, t = filterModal.team, m = filterModal.models;
  sideFilter.sessions.text = s.text;
  Object.assign(sideExt.sessions, { createdFrom: s.createdFrom, createdTo: s.createdTo, updatedFrom: s.updatedFrom, updatedTo: s.updatedTo });
  sideFilter.team.text = t.text;
  Object.assign(sideExt.team, { tools: t.tools, chat: t.chat });
  sideFilter.models.text = m.text;
  Object.assign(sideExt.models, { provider: m.provider, kind: m.kind, vision: m.vision });
}
function applyFilter(): void {
  commitFilterDraft();
  filterModal.show = false;
}
function cancelFilter(): void {
  filterModal.show = false;
}
function clearFilter(): void {
  Object.assign(filterModal.sessions, { text: '', createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '' });
  Object.assign(filterModal.team, { text: '', tools: '', chat: '' });
  Object.assign(filterModal.models, { text: '', provider: '', kind: '', vision: '' });
  commitFilterDraft();
  nextTick(() => filterBox.value?.querySelector<HTMLElement>('input, select')?.focus());
}

/** Отфильтрованные списки. Сессии — название + диапазоны дат; агенты — имя,
 *  тулы и «в чате»; модели — id, провайдер, тип и vision. */
const sessionsView = computed(() =>
  sessions.value.filter((s) => sideMatch('sessions', s.title)
    && dateHit(s.createdAt, sideExt.sessions.createdFrom, sideExt.sessions.createdTo)
    && dateHit(s.updatedAt, sideExt.sessions.updatedFrom, sideExt.sessions.updatedTo)),
);
const teamView = computed(() => team.value.filter((a) => {
  if (!sideMatch('team', a.name)) return false;
  const e = sideExt.team;
  const q = e.tools.trim().toLowerCase();
  if (q && !a.tools?.some((tl) => tl.toLowerCase().includes(q))) return false;
  if (e.chat === 'in' && !a.inChat) return false;
  if (e.chat === 'out' && a.inChat) return false;
  return true;
}));
const modelsView = computed(() =>
  [...models.value, ...imageModels.value].filter((p) => {
    if (!sideMatch('models', p.id)) return false;
    const e = sideExt.models;
    if (e.provider && p.provider !== e.provider) return false;
    if (e.kind === 'chat' && p.img) return false;
    if (e.kind === 'image' && !p.img) return false;
    if (e.vision === 'yes' && !p.vision) return false;
    if (e.vision === 'no' && p.vision) return false;
    return true;
  }),
);
const scheduleView = computed(() => scheduleTasks.value.filter((t) => sideMatch('schedule', `${t.message} ${t.intervalMinutes}`)));
const knownProjectsView = computed(() =>
  knownProjects.value.filter((k) => k.name !== currentProject.value?.id && sideMatch('projects', `${k.name} ${k.path}`)),
);
const projectHostsView = computed(() =>
  projects.value
    .flatMap((p) => (p.hosts ?? []).map((h) => ({ p, h })))
    .filter((ph) => sideMatch('projects', `${ph.p.id} ${ph.h.name} ${ph.h.host}`)),
);

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

// ── текст реплики: markdown (md-it; html:false — сырой HTML из ответа
// экранируется, теги генерирует сама библиотека; breaks:true — одиночный
// перевод строки = <br>, как в чатах) ────────────────────────────────────────
const md = new MarkdownIt({ html: false, breaks: true, linkify: false });
// [имя.ext] — вложенный файл → ссылка /api/file (класс file-link нужен
// делегатам onChatClick/onChatContext: клик — открыть, Ctrl+клик — скачать,
// ПКМ — своё меню). Правило живёт в inline-контексте — в ```-блоках и
// `code`-спанах не срабатывает; «(?!\()» не трогает обычные [текст](url).
md.inline.ruler.before('link', 'file_link', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x5b /* [ */) return false;
  const m = /^\[([^\[\]\n]+\.[A-Za-z0-9]{2,8})\](?!\()/.exec(state.src.slice(state.pos, state.pos + 300));
  if (!m) return false;
  if (silent) return true;
  const open = state.push('link_open', 'a', 1);
  open.attrSet('href', `/api/file?path=${encodeURIComponent(m[1])}`);
  open.attrSet('class', 'file-link');
  const text = state.push('text', '', 0);
  text.content = m[0];
  state.push('link_close', 'a', -1);
  state.pos += m[0].length;
  return true;
});
// обычные ссылки — в новой вкладке (не уводим GUI), файловые — с подсказкой;
// title ставится на каждый рендер — на случай смены языка на лету
const linkOpen = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet('href') ?? '');
  if (href.startsWith('/api/file?')) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener');
    tokens[idx].attrSet('title', tr('Клик — открыть · Ctrl+клик — сохранить'));
  } else if (/^https?:/i.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener');
  }
  return linkOpen(tokens, idx, options, env, self);
};
// md-it сам триммит содержимое блоков — краевые пробелы и пустые строки
// больше не рисуются (прежние span-обёртки оставляли их в пузырях);
// trim и у html — md-it оставляет хвостовой \n после последнего блока
function formatText(text: string): string {
  return md.render(String(text).trim()).trim();
}

// ── копирование в буфер: navigator.clipboard живёт только в secure context
// (https или localhost) — по LAN его нет, фолбэк — скрытый textarea+execCommand
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
// короткий фидбек на кнопке: ✓ скопировано / ✗ не вышло, через секунду — обратно
function flashCopy(btn: HTMLElement, ok: boolean): void {
  btn.textContent = ok ? '✓' : '✗';
  setTimeout(() => { btn.textContent = '⧉'; }, 900);
}

// `code` и ```fence``` — с кнопкой копирования (.code-copy): клик ловит
// делегат onChatClick; title ставится на каждый рендер — на случай смены
// языка на лету (как у file-link)
md.renderer.rules.code_inline = (tokens, idx) => {
  const title = md.utils.escapeHtml(tr('Скопировать'));
  return `<span class="codewrap"><code>${md.utils.escapeHtml(tokens[idx].content)}</code><button class="code-copy" title="${title}">⧉</button></span>`;
};
const fenceBase = md.renderer.rules.fence
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const title = md.utils.escapeHtml(tr('Скопировать'));
  return `<div class="codeblock"><button class="code-copy" title="${title}">⧉</button>${fenceBase(tokens, idx, options, env, self)}</div>`;
};
// видимый текст реплики пользователя: ведущие метки [имя] прикреплённых файлов
// уже показаны чипами (att-row) — из текста их убираем, остальное не трогаем
function attachmentsText(m: ChatMessage): string {
  const names = new Set(m.attachments ?? []);
  let out = m.text.trimStart();
  for (;;) {
    const mm = out.match(/^\[([^\[\]]+)\]\s*/);
    if (!mm || !names.has(mm[1])) break;
    out = out.slice(mm[0].length);
  }
  return out;
}
function colorByAuthor(m: ChatMessage): string {
  if (m.authorId === 'manager') return colorOf(manager.value?.color);
  const a = team.value.find((x) => x.id === m.authorId);
  return colorOf(a?.color);
}

/** Лента чата: реплики и служебные блоки ядра (notice/error), слитые по времени —
 *  заметка встаёт между репликами, в правильном хронологическом порядке. */
type ChatItem = { key: string; ts: number } & (
  | { kind: 'msg'; msg: ChatMessage }
  | { kind: 'notice'; notice: FeedItem }
);
const chatFlow = computed<ChatItem[]>(() => {
  const items: ChatItem[] = [
    ...messages.map((m, i): ChatItem => ({ key: `m${i}`, ts: m.ts, kind: 'msg', msg: m })),
    ...feed.map((n, i): ChatItem => ({ key: `n${i}`, ts: n.ts, kind: 'notice', notice: n })),
  ];
  return items.sort((a, b) => a.ts - b.ts); // сортировка стабильна: при равном ts реплики раньше
});
const fmtDate = (ts: number): string => {
  const tag = { ru: 'ru-RU', en: 'en-US', zh: 'zh-CN' }[snapshot.ui?.id ?? 'ru'] ?? 'ru-RU';
  return new Date(ts).toLocaleString(tag);
};

// ── действия под сообщением: копировать markdown · ответить с цитатой ────────
type MsgItem = Extract<ChatItem, { kind: 'msg' }>;
/** Исходный markdown реплики: у пользователя маркеры вложений уже сняты. */
function msgRaw(m: ChatMessage): string {
  return (m.authorId === 'user' ? attachmentsText(m) : m.text).trim();
}
async function msgCopy(it: MsgItem, btn: HTMLElement): Promise<void> {
  const ok = await copyText(msgRaw(it.msg));
  flashCopy(btn, ok);
}
// выделение в чате: клик по кнопке reply сбрасывает выделение — храним
// последний непустой фрагмент (текст + сообщение, где он выделен)
let selText = '';
let selKey = '';
function onSelectionChange(): void {
  const sel = document.getSelection();
  const text = (sel?.toString() ?? '').trim();
  if (!text || !sel?.anchorNode) return;
  if (!chatEl.value?.contains(sel.anchorNode)) return;
  selText = text;
  const host = (sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement)?.closest('[data-key]');
  selKey = host?.getAttribute('data-key') ?? '';
}
document.addEventListener('selectionchange', onSelectionChange);
/** Ответить с цитатой: выделение этого сообщения или весь его текст;
 *  упоминание автора (!Имя — движок матчит по имени), префикс из настроек. */
function msgReply(it: MsgItem): void {
  const quote = (selKey === it.key && selText) || msgRaw(it.msg);
  if (!quote) return;
  const fence = quote.includes('```') ? '````' : '```';
  const prefix = snapshot.settings?.quotePrefix ?? tr('Вы пишете:');
  const mention = it.msg.authorId === 'user' ? '' : `!${it.msg.authorName} `;
  const text = `${mention}${prefix}\n${fence}\n${quote}\n${fence}`;
  draft.value = draft.value ? `${draft.value.replace(/\s+$/, '')}\n${text}` : text;
  nextTick(() => {
    const el = inputEl.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autosize();
  });
}

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

// пришёл новый лимит строк ввода (state/settings) — пересчитать высоту поля
watch(
  () => snapshot.settings?.maxInputRows,
  () => nextTick(autosize),
);

// ── контекстное меню (правая кнопка) и подтверждение удаления ────────────────
// двойной клик в интерфейсе не используется: одиночный клик — основное
// действие записи, правая кнопка — меню «Изменить»/«Удалить».
type CtxItem = { label: string; fn: () => void };
const ctx = reactive({ show: false, x: 0, y: 0, items: [] as CtxItem[] });
function openCtx(e: MouseEvent, items: CtxItem[]): void {
  // клампим с двух сторон: меню не должно вылезать ни справа, ни слева
  ctx.x = Math.max(8, Math.min(e.clientX, window.innerWidth - 180));
  ctx.y = Math.max(8, Math.min(e.clientY, window.innerHeight - items.length * 42 - 16));
  ctx.items = items;
  ctx.show = true;
}
function closeCtx(): void { ctx.show = false; }
function runCtx(it: CtxItem): void { closeCtx(); it.fn(); }
// Esc закрывает меню, даже когда фокус вне его: слушаем документ, пока меню открыто
watch(
  () => ctx.show,
  (open) => {
    if (open) document.addEventListener('keydown', onCtxKey);
    else document.removeEventListener('keydown', onCtxKey);
  },
);
function onCtxKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeCtx();
}

// ── файлы в чате: клик — открыть (по умолчанию, новая вкладка),
// Ctrl+клик — скачать, ПКМ — своё меню «Открыть/Сохранить» ────────────────────
function downloadFile(href: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = ''; // тот же origin — браузер скачает, а не откроет
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function onChatClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  // кнопка на `code`/```fence```: копирует текст соседнего кода
  const btn = t.closest('button.code-copy') as HTMLElement | null;
  if (btn) {
    e.preventDefault();
    const code = btn.closest('.codeblock, .codewrap')?.querySelector('code, pre');
    void copyText(code?.textContent ?? '').then((ok) => flashCopy(btn, ok));
    return;
  }
  const a = t.closest('a.file-link');
  if (!a || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  downloadFile(a.getAttribute('href') ?? '');
}
function onChatContext(e: MouseEvent): void {
  const a = (e.target as HTMLElement).closest('a.file-link');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') ?? '';
  openCtx(e, [
    { label: tr('Открыть'), fn: () => window.open(href, '_blank', 'noopener') },
    { label: tr('Сохранить'), fn: () => downloadFile(href) },
  ]);
}

// ── мобильный вид: сайдбар — выдвижная шторка (кнопка ☰ в топбаре) ───────────
const navOpen = ref(false);
function onSidebarClick(e: MouseEvent): void {
  // шторку держим открытой, пока строки прокликаывают подряд (позвать
  // агента, сменить модель); закрываем только при смене содержимого чата —
  // выбрали разговор или проект, создали новый разговор
  const t = e.target as HTMLElement;
  if (t.closest('#sessions li, #projects .proj-row')) navOpen.value = false;
  else if (t.matches('.sec-add') && t.closest('[data-sec="sessions"]')) navOpen.value = false;
}
// долгое нажатие на строке — то же меню, что по правой кнопке: синтезируем
// contextmenu, его ловят обычные @contextmenu-обработчики строк
let lpTimer: ReturnType<typeof setTimeout> | null = null;
let lpFired = false; // меню уже открылось этим жестом — отрыв пальца гасим
const lpAt = { x: 0, y: 0 };
function onSidebarTouchStart(e: TouchEvent): void {
  const t = e.touches[0];
  if (!t) return;
  lpFired = false;
  lpAt.x = t.clientX;
  lpAt.y = t.clientY;
  const el = e.target as HTMLElement;
  lpTimer = setTimeout(() => {
    lpTimer = null;
    lpFired = true;
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: lpAt.x, clientY: lpAt.y }));
  }, 550);
}
function onSidebarTouchMove(e: TouchEvent): void {
  const t = e.touches[0];
  if (lpTimer && t && (Math.abs(t.clientX - lpAt.x) > 12 || Math.abs(t.clientY - lpAt.y) > 12)) {
    clearTimeout(lpTimer);
    lpTimer = null;
  }
}
function onSidebarTouchEnd(e: TouchEvent): void {
  if (lpTimer) {
    clearTimeout(lpTimer);
    lpTimer = null;
  } else if (lpFired) {
    // меню уже открылось этим жестом: после отрыва браузер синтезирует
    // click, тот попадёт в оверлей и тут же закроет меню — гасим его
    lpFired = false;
    e.preventDefault();
  }
}
function onSidebarTouchCancel(): void {
  if (lpTimer) {
    clearTimeout(lpTimer);
    lpTimer = null;
  }
  lpFired = false;
}

// ── ширина сайдбара: тянуть за правую границу, запоминать в localStorage ─────
const SB_MIN = 280;
const SB_MAX = 640;
const sbWidth = ref(Math.min(SB_MAX, Math.max(SB_MIN, Number(localStorage.getItem('dt.sbwidth')) || 280)));
let sbDrag: { x: number; w: number } | null = null;
function startSidebarResize(e: MouseEvent): void {
  sbDrag = { x: e.clientX, w: sbWidth.value };
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onSidebarResize);
  document.addEventListener('mouseup', endSidebarResize);
}
function onSidebarResize(e: MouseEvent): void {
  if (!sbDrag) return;
  sbWidth.value = Math.min(SB_MAX, Math.max(SB_MIN, sbDrag.w + e.clientX - sbDrag.x));
}
function endSidebarResize(): void {
  sbDrag = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.removeEventListener('mousemove', onSidebarResize);
  document.removeEventListener('mouseup', endSidebarResize);
  localStorage.setItem('dt.sbwidth', String(sbWidth.value));
}

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
  const items: CtxItem[] = [
    { label: tr('Изменить'), fn: () => openModelSettings(p) },
    ...(!p.img ? [{ label: tr('Статистика'), fn: () => modelUsageReport(p.id) }] : []),
  ];
  if (!p.isDefault) items.push({ label: tr('Удалить'), fn: () => delModel(p) });
  openCtx(e, items);
}
function ctxSession(e: MouseEvent, id: string, title: string): void {
  openCtx(e, [
    { label: tr('Изменить'), fn: () => openSessionEdit(id) },
    { label: tr('Статистика'), fn: () => sessionUsageReport(id, title) },
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

// ── модальная форма: поля [{key,label,value,placeholder?,type?,values?}] ─────
type FormField = {
  key: string; label: string; value?: string; placeholder?: string;
  type?: FieldSpec['type']; values?: string[];
  /** Подписи вариантов enum (по индексу values); нет — подпись = само значение */
  optionLabels?: string[];
  /** Описание поля (схема модели): мелкая строка под контролем */
  desc?: string;
  /** Сворачиваемая группа: поля без группы — верхний уровень формы */
  group?: string;
  /** Тип model: текст JSON-переопределения (селектор хранится в value) */
  json?: string;
};
const modal = reactive({
  show: false, title: '', error: '',
  fields: [] as FormField[],
  onSave: null as null | ((v: Record<string, string>) => void),
  settingsActions: false,
});
/** Свёрнутые группы текущей формы (пересобираются при каждом открытии). */
const modalCollapsed = reactive(new Set<string>());
function toggleModalGroup(title: string): void {
  if (modalCollapsed.has(title)) modalCollapsed.delete(title);
  else modalCollapsed.add(title);
}
/** Секции формы: верхний уровень (всегда открыт) + группы по порядку полей. */
type ModalSection = { title: string; collapsible: boolean; fields: FormField[] };
const modalSections = computed<ModalSection[]>(() => {
  const top: FormField[] = [];
  const map = new Map<string, FormField[]>();
  for (const f of modal.fields) {
    if (!f.group) { top.push(f); continue; }
    const arr = map.get(f.group);
    if (arr) arr.push(f);
    else map.set(f.group, [f]);
  }
  const out: ModalSection[] = [{ title: '', collapsible: false, fields: top }];
  for (const [title, fields] of map) out.push({ title, collapsible: true, fields });
  return out;
});
const modalBox = ref<HTMLElement | null>(null);
function openForm(title: string, fields: FormField[], onSave: (v: Record<string, string>) => void,
  opts?: { settingsActions?: boolean }): void {
  modal.title = title;
  modal.fields = fields.map((f) => ({
    key: f.key, label: f.label, value: f.value ?? '', placeholder: f.placeholder,
    type: f.type, values: f.values, optionLabels: f.optionLabels, desc: f.desc, group: f.group,
    // текст JSON-переопределения (тип model): без него ручной режим открывается пустым —
    // ссылка с параметрами в селектор не ложится, показывать нечего, кроме этого поля
    json: f.json ?? '',
  }));
  modal.error = '';
  modal.onSave = onSave;
  modal.settingsActions = opts?.settingsActions ?? false;
  modalCollapsed.clear();
  // группы по умолчанию свёрнуты; но группа с JSON-режимом ссылки разворачивается —
  // иначе включённый вручную JSON не виден
  for (const f of modal.fields) if (f.group && !(f.type === 'model' && f.value === '__json__')) modalCollapsed.add(f.group);
  modal.show = true;
  nextTick(() => modalBox.value?.querySelector<HTMLElement>('input, textarea, select')?.focus());
}
function closeForm(): void {
  modal.show = false;
  modal.onSave = null;
}

// ── отчёт по токенам: ПКМ «Статистика» у разговора или модели ───────────────
const report = reactive({ show: false, title: '', lines: [] as string[] });
const reportBox = ref<HTMLElement | null>(null);
function openReport(title: string, lines: string[]): void {
  report.title = title;
  report.lines = lines;
  report.show = true;
  nextTick(() => reportBox.value?.querySelector<HTMLElement>('button')?.focus());
}
function closeReport(): void {
  report.show = false;
}
/** Числа в отчётах — в локали интерфейса (неизвестный id — локаль браузера). */
const NUM_LOCALES: Record<string, string> = { ru: 'ru-RU', en: 'en-US', zh: 'zh-CN' };
function fmtNum(n: number): string {
  return n.toLocaleString(NUM_LOCALES[snapshot.ui?.id ?? '']);
}
/** Тысячи — «128k», меньше тысячи — как есть (индикатор контекста). */
function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// ── индикатор контекста: статус-бар под вводом ───────────────────────────────
/** Заполнение контекста текущего разговора: токены последнего раунда против
 *  окна модели, отвечавшей последней. Нет данных — null, бар скрыт. */
const ctxInfo = computed(() => {
  const meta = sessions.value.find((s) => s.id === currentSessionId.value);
  const tokens = meta?.contextTokens ?? 0;
  const win = meta?.contextModel
    ? models.value.find((m) => m.id === meta.contextModel)?.contextWindow
    : undefined;
  if (!tokens || !win || win <= 0) return null;
  const pct = Math.min(100, Math.round((tokens / win) * 100));
  const threshold = snapshot.settings?.compressThreshold ?? 85;
  const band = pct >= threshold ? 'bad' : pct >= threshold - 15 ? 'warn' : 'ok';
  return { pct, tokens, win, band };
});

// ── индикатор квот: рядом с индикатором контекста ────────────────────────────
/** Короткие метки окон квоты — русский ключ переводится словарём ui.strings. */
const QUOTA_LABELS: Record<string, string> = { '5h': '5ч', week: 'нед', month: 'мес', mcp: 'mcp' };
/** Лимиты тарифа дефолтной модели (z.ai coding plan и др.): остаток в %, цвет
 *  по самому низкому окну, в подсказке — тариф и время сброса. Нет данных — null. */
const quotaInfo = computed(() => {
  const quota = models.value.find((m) => m.isDefault)?.quota;
  if (!quota || quota.windows.length === 0) return null;
  const remain = (w: { usedPercent: number }): number => Math.max(0, 100 - w.usedPercent);
  const parts = quota.windows.map((w) => ({
    key: w.key,
    label: tr(QUOTA_LABELS[w.key] ?? w.key),
    pct: remain(w),
    resetAt: w.resetAt,
  }));
  const worst = Math.min(...parts.map((p) => p.pct));
  const band = worst < 20 ? 'bad' : worst < 50 ? 'warn' : 'ok';
  const title = [
    quota.plan ? `plan: ${quota.plan}` : '',
    ...parts.map((p) => `${p.label}: ${p.pct}%${p.resetAt ? ` · ${tr('сброс {time}', { time: fmtDate(p.resetAt) })}` : ''}`),
  ].filter(Boolean).join('\n');
  return { band, title, windows: parts };
});
function usageLines(u: SessionUsage): string[] {
  const pct = u.promptTokens > 0 ? Math.round((u.cachedTokens / u.promptTokens) * 100) : 0;
  return [
    tr('Раундов: {rounds}', { rounds: u.rounds }),
    tr('Вход: {in} · Выход: {out} · Из кэша: {cached} ({pct}%)', {
      in: fmtNum(u.promptTokens), out: fmtNum(u.outputTokens), cached: fmtNum(u.cachedTokens), pct,
    }),
  ];
}
/** Отчёт разговора: его итог + разбивка по моделям. */
function sessionUsageReport(id: string, title: string): void {
  const meta = sessions.value.find((s) => s.id === id);
  const u = meta?.usage;
  const lines: string[] = u && u.rounds > 0 ? usageLines(u) : [tr('Статистики пока нет — сделайте раунд с API (не mock).')];
  const byModel = Object.entries(meta?.usageByModel ?? {}).filter(([, v]) => v.rounds > 0);
  if (byModel.length > 0) {
    lines.push('', tr('По моделям:'));
    for (const [mid, v] of byModel) {
      lines.push(`• ${mid} — ${tr('{r} раунд(ов), вход {in}, выход {out}', { r: v.rounds, in: fmtNum(v.promptTokens), out: fmtNum(v.outputTokens) })}`);
    }
  }
  openReport(tr('Статистика разговора «{title}»', { title }), lines);
}
/** Отчёт модели: суммарно по всем разговорам дома (считается из state). */
function modelUsageReport(id: string): void {
  let rounds = 0, inTok = 0, outTok = 0, cached = 0, chats = 0;
  for (const s of sessions.value) {
    const u = s.usageByModel?.[id];
    if (!u || u.rounds === 0) continue;
    chats++;
    rounds += u.rounds;
    inTok += u.promptTokens;
    outTok += u.outputTokens;
    cached += u.cachedTokens;
  }
  const lines = rounds > 0
    ? [...usageLines({ rounds, promptTokens: inTok, cachedTokens: cached, outputTokens: outTok }), tr('В разговорах: {n}', { n: chats })]
    : [tr('Статистики пока нет — сделайте раунд с API (не mock).')];
  openReport(tr('Статистика модели {id} — все разговоры', { id }), lines);
}
/** Чекбокс булева поля: значение живёт строкой 'true'/'false' (пусто — не менять). */
function setBool(f: { value?: string }, ev: Event): void {
  f.value = (ev.target as HTMLInputElement).checked ? 'true' : 'false';
}

// ── Tab в текстарее модалки: отступ как в редакторе, а не перевод фокуса ─────
const TA_INDENT = '  ';
/** Tab — отступ (с многострочным выделением — всем строкам), Shift+Tab —
 *  снять уровень отступа; фокус браузером не переводится (.prevent в шаблоне). */
function taTab(ev: KeyboardEvent): void {
  const ta = ev.target as HTMLTextAreaElement;
  const v = ta.value;
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  const multiline = v.slice(a, b).includes('\n');
  const ls = v.lastIndexOf('\n', a - 1) + 1;
  let le = v.indexOf('\n', b);
  if (le === -1) le = v.length;
  if (!ev.shiftKey) {
    if (multiline) {
      const block = v.slice(ls, le);
      const indented = block.replace(/(^|\n)(?=.)/g, (m) => m + TA_INDENT);
      taReplace(ta, ls, le, indented);
      ta.setSelectionRange(ls + TA_INDENT.length, ls + indented.length);
    } else {
      taReplace(ta, a, b, TA_INDENT);
    }
    return;
  }
  const block = v.slice(ls, le);
  const dedented = block.replace(/(^|\n)(\t| {1,2})/g, '$1');
  if (dedented === block) return; // снимать нечего — но фокус всё равно не уходит
  taReplace(ta, ls, le, dedented);
  const removedBefore = v.slice(ls, a).replace(/(^|\n)(\t| {1,2})/g, '$1').length;
  const delta = block.length - dedented.length;
  ta.setSelectionRange(ls + removedBefore, Math.max(ls, b - delta));
}
/** Замена диапазона с input-событием (v-model): execCommand сохраняет Ctrl+Z. */
function taReplace(ta: HTMLTextAreaElement, start: number, end: number, text: string): void {
  ta.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const pos = start + text.length;
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
function submitForm(): void {
  if (!modal.onSave) return;
  const values: Record<string, string> = {};
  // v-model на input[type=number] кладёт в value число (looseToNumber) — возвращаем строку
  for (const f of modal.fields) {
    values[f.key] = String(f.value ?? '').trim();
    // контрол модели: JSON-режим едет отдельным ключом «<path>.json»
    if (f.type === 'model') values[`${f.key}.json`] = String(f.json ?? '');
  }
  try {
    modal.onSave(values);
    closeForm();
  } catch (err) {
    modal.error = (err as Error).message;
  }
}

// ── формы из схемы карточек: поля и типы берутся из snapshot.schemas ─────────
function schemaOf(entity: string): CardSchema | undefined {
  return snapshot.schemas?.[entity];
}
function getPath(obj: unknown, path: string): string {
  let v: unknown = obj;
  for (const part of path.split('.')) {
    if (v == null || typeof v !== 'object') return '';
    v = (v as Record<string, unknown>)[part];
  }
  return v == null ? '' : String(v);
}
/** Сырое значение по пути (object-поля показываем как JSON, не строкой) */
function getRaw(obj: unknown, path: string): unknown {
  let v: unknown = obj;
  for (const part of path.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}
/** Поля формы по готовой схеме; значения — из текущей карточки по путям;
 *  desc — описание из контракта (подпись под контролем); groupOf раскладывает
 *  поля по сворачиваемым группам. */
function fieldsFromSchema(schema: CardSchema, current: unknown,
  groupOf?: (path: string) => string | undefined): FormField[] {
  return schema.fields.map((f) => {
    // тип model: селектор («» = по умолчанию, id карточки, «__json__» = вручную);
    // ссылки без параметров показываем селектором, с параметрами — JSON-режимом
    if (f.type === 'model') {
      const v = (current ?? {}) as Record<string, unknown>;
      // корень ссылки: «model» — или «vision»/«image» у вложенных vision.id/image.id
      const ref = v[f.path.split('.')[0]];
      const extras = ref && typeof ref === 'object' && !Array.isArray(ref)
        ? Object.keys(ref as object).filter((k) => k !== 'id')
        : [];
      const pretty = ref == null || typeof ref !== 'object'
        ? (ref == null ? '' : JSON.stringify({ id: String(ref) }, null, 2))
        : JSON.stringify(ref, null, 2);
      return {
        key: f.path, label: tr(f.label),
        value: extras.length > 0 ? '__json__' : String((ref as { id?: string } | undefined)?.id ?? ''),
        json: pretty,
        type: f.type,
        placeholder: f.placeholder ? tr(f.placeholder) : undefined,
        desc: f.desc ? tr(f.desc) : undefined,
        group: groupOf?.(f.path),
      };
    }
    const raw = getRaw(current, f.path);
    const value = f.type === 'object' && raw != null && typeof raw === 'object' && !Array.isArray(raw)
      ? JSON.stringify(raw, null, 2) // карта тулов и иже — читаемым JSON, не «[object Object]»
      : getPath(current, f.path);
    return {
      key: f.path, label: tr(f.label), value,
      type: f.type, values: f.values ? [...f.values] : undefined,
      placeholder: f.placeholder ? tr(f.placeholder) : undefined,
      desc: f.desc ? tr(f.desc) : undefined,
      group: groupOf?.(f.path),
    };
  });
}
/** Группы формы агента: ссылки на модели — сворачиваемые секции. */
function agentGroupOf(path: string): string | undefined {
  if (path.startsWith('vision.')) return tr('Модель зрения');
  if (path.startsWith('image.')) return tr('Модель генерации изображений');
  return undefined;
}
// верхний уровень формы модели: провайдер, имя/адрес/ключ, температура, зрение;
// остальной контракт (размышления, кэш, окна, доп. поля…) — «Расширенные»
const MODEL_PRIMARY = new Set(['provider', 'model', 'baseUrl', 'apiKey', 'clientSecret', 'clientId', 'temperature', 'vision']);
function modelGroupOf(path: string): string | undefined {
  return MODEL_PRIMARY.has(path) ? undefined : tr('Расширенные настройки');
}
/** Подпись модели в селекторе: id — имя у API, ◉ — зрячая. */
function modelOption(m: ModelInfo): string {
  return `${m.id} — ${m.model ?? m.kind}${m.vision ? ' ◉' : ''}`;
}
/** Ссылки на модели — один контрол (тип model): селектор + «вручную (JSON)…».
 *  Варианты собирает сюда GUI: сама модель — все карточки (пусто = основная
 *  модель дома), vision.id — только зрячие, image.id — image-модели
 *  (пусто = «не менять»: форма пустое не шлёт). */
function withModelSelects(fields: FormField[]): FormField[] {
  const manual = tr('вручную (JSON)…');
  return fields.map((f) => {
    if (f.type !== 'model') return f;
    if (f.key === 'model') {
      return {
        ...f,
        values: ['', ...models.value.map((m) => m.id), '__json__'],
        optionLabels: [tr('— по умолчанию (основная модель дома) —'), ...models.value.map(modelOption), manual],
      };
    }
    if (f.key === 'vision.id') {
      const vis = models.value.filter((m) => m.vision);
      return {
        ...f,
        values: ['', ...vis.map((m) => m.id), '__json__'],
        optionLabels: [tr('— не менять —'), ...vis.map((m) => `${m.id} — ${m.model ?? m.kind}`), manual],
      };
    }
    if (f.key === 'image.id') {
      const imgs = (snapshot.images ?? []) as { id: string; ok: boolean }[];
      return {
        ...f,
        values: ['', ...imgs.map((m) => m.id), '__json__'],
        optionLabels: [tr('— не менять —'), ...imgs.map((m) => `${m.id}${m.ok ? '' : ' ⚠'}`), manual],
      };
    }
    return f;
  });
}
/** Поля формы по схеме сущности (agent/session/project — snapshot.schemas). */
function schemaFields(entity: string, current: unknown,
  groupOf?: (path: string) => string | undefined): FormField[] {
  const schema = schemaOf(entity);
  if (!schema) return [];
  return fieldsFromSchema(schema, current, groupOf);
}
/** Значения формы → вложенный объект по путям схемы (пусто — поле не менять). */
function fieldsFromForm(schema: CardSchema, values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema.fields) {
    if (f.type === 'model') continue; // контрол ссылки целиком — разбирает вызывающий
    const raw = (values[f.path] ?? '').trim();
    if (!raw) continue;
    if (f.type === 'boolean') {
      out[f.path] = raw === 'true';
      continue;
    }
    if (f.type === 'object') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(tr('поле «{path}»: жду JSON', { path: f.path }));
      }
      if (parsed === null || typeof parsed !== 'object') {
        throw new Error(tr('поле «{path}»: жду JSON', { path: f.path }));
      }
      out[f.path] = parsed;
      continue;
    }
    const num = Number(raw);
    if (f.type === 'number' && !Number.isFinite(num)) continue;
    const v: unknown = f.type === 'number' ? num : raw;
    const parts = f.path.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (node[k] === null || typeof node[k] !== 'object') node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = v;
  }
  return out;
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
    { key: 'description', label: tr('Описание (можно пропустить)') },
  ], (v) => rpcReport(rpc('agent.new', v)));
}
async function openAgentSettings(a: AgentInfo): Promise<void> {
  const schema = schemaOf('agent');
  if (!schema) return;
  // полная карточка (rpc agent.get) — в снапшоте команды её вложенных полей нет
  let card: Record<string, unknown> = {};
  try {
    const r = await rpc<{ card: Record<string, unknown> }>('agent.get', { id: a.id });
    card = r.card ?? {};
  } catch (err) {
    addFeed('error', `✗ ${(err as Error).message}`);
    return;
  }
  openForm(tr('Настройки агента {name}', { name: a.name }), [
    ...withModelSelects(schemaFields('agent', card, agentGroupOf)),
  ], (v) => {
    const fields = fieldsFromForm(schema, v);
    // модель — один контрол: '' → сброс к умолчаниям; id → {"id": …}; '__json__' →
    // JSON-объект целиком (пустой текст — тоже сброс); null сервер понимает как «убрать»
    const mode = String(v['model'] ?? '');
    const jsonText = String(v['model.json'] ?? '').trim();
    const same = (obj: unknown) => JSON.stringify(obj ?? {}) === JSON.stringify(card.model ?? {});
    if (mode === '__json__') {
      if (jsonText) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          throw new Error(tr('поле «Модель»: жду JSON-объект'));
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(tr('поле «Модель»: жду JSON-объект'));
        }
        if (!same(parsed)) fields.model = parsed;
      } else if (card.model !== undefined) {
        fields.model = null;
      }
    } else if (mode === '') {
      if (card.model !== undefined) fields.model = null;
    } else if (!same({ id: mode })) {
      fields.model = { id: mode };
    }
    // зрение и картинки — тот же контрол: '' — не менять; id → {"id": …};
    // '__json__' → объект целиком (пустой текст — убрать ссылку; без "id" —
    // ошибка: ссылка обязана назвать модель, параметров «в никуда» не бывает)
    for (const key of ['vision', 'image'] as const) {
      const cur = card[key];
      const mode = String(v[`${key}.id`] ?? '');
      const jsonText = String(v[`${key}.id.json`] ?? '').trim();
      const bad = key === 'vision'
        ? tr('поле «Модель зрения»: жду JSON-объект с "id"')
        : tr('поле «Модель генерации изображений»: жду JSON-объект с "id"');
      const same = (obj: unknown) => JSON.stringify(obj ?? {}) === JSON.stringify(cur ?? {});
      if (mode === '__json__') {
        if (jsonText) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(jsonText);
          } catch {
            throw new Error(bad);
          }
          const id = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as { id?: unknown }).id
            : undefined;
          if (typeof id !== 'string' || !id.trim()) throw new Error(bad);
          if (!same(parsed)) fields[key] = parsed;
        } else if (cur !== undefined) {
          fields[key] = ''; // сервер: пустая строка — убрать ссылку
        }
      } else if (mode && !same({ id: mode })) {
        fields[key] = { id: mode };
      }
    }
    if (Object.keys(fields).length > 0) rpcReport(rpc('agent.update', { id: a.id, fields }));
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
  // селектор провайдеров: встроенные + кастомные (снапшот; старый сервер —
  // без поля — прежний короткий список)
  const providers = (snapshot.providers as string[] | undefined) ?? ['openai-compatible', 'anthropic-compatible', 'zai-coding-plan', 'gigachat', 'mock'];
  openForm(tr('Новая модель'), [
    { key: 'id', label: tr('id (латиница, цифры, ./-/_)') },
    { key: 'provider', label: tr('Провайдер'), type: 'enum', value: 'openai-compatible', values: providers },
    { key: 'baseUrl', label: tr('Адрес API') },
    { key: 'model', label: tr('Модель (имя у API)') },
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
/** Клик по модели в списке: обычная — «сделать основной», image-модель — карточка. */
function clickModel(p: ModelInfo): void {
  if (p.img) openModelSettings(p);
  else setModel(p);
}
function delModel(p: ModelInfo): void {
  if (!roundActive.value) modelDelete(p);
}
async function openModelSettings(p: ModelInfo): Promise<void> {
  // схема и карточка приходят парой: поля модели — это контракт её провайдера
  let card: Record<string, unknown> = {};
  let schema: CardSchema | undefined;
  try {
    const r = await rpc<{ card: Record<string, unknown>; schema: CardSchema }>('model.get', { id: p.id });
    card = r.card ?? {};
    schema = r.schema;
  } catch (err) {
    addFeed('error', `✗ ${(err as Error).message}`);
    return;
  }
  if (!schema) return;
  openForm(tr('Модель {id}', { id: p.id }), fieldsFromSchema(schema, card, modelGroupOf), (v) => {
    rpcReport(rpc('model.update', { id: p.id, fields: fieldsFromForm(schema, v) }));
  });
}

// ── настройки / пользователь / менеджер ──────────────────────────────────────
function openSettingsForm(): void {
  const st = snapshot.settings;
  if (!st) return;
  // селектор языка: системные (ru/en/zh) + свои из lang/ дома; без списка
  // (старый сервер) — прежнее текстовое поле
  const langs: LanguageInfo[] = snapshot.ui?.languages ?? [];
  const uiField: FormField = langs.length
    ? {
        key: 'ui', label: tr('Язык интерфейса'), value: snapshot.ui?.id ?? '', type: 'enum',
        values: langs.map((l) => l.id),
        optionLabels: langs.map((l) => `${l.id} — ${l.name}${l.builtIn ? '' : ` (${tr('свой')})`}`),
      }
    : { key: 'ui', label: tr('Язык интерфейса'), value: snapshot.ui?.id ?? '' };
  openForm(tr('Настройки'), [
    { key: 'language', label: tr('Язык общения (russian / ru-RU / english…)'), value: st.language ?? '', placeholder: tr('пусто — как язык интерфейса') },
    { key: 'autoMessage', label: tr('Автоответ в автономном режиме'), value: st.autoMessage ?? '' },
    { key: 'quotePrefix', label: tr('Сообщение для цитирования'), value: st.quotePrefix ?? '', placeholder: tr('Вы пишете:') },
    uiField,
    { key: 'width', label: tr('Ширина экрана (40–500)'), value: st.width != null ? String(st.width) : '' },
    { key: 'maxInputRows', label: tr('Максимум строк поля ввода (1–20)'), value: st.maxInputRows != null ? String(st.maxInputRows) : '' },
    { key: 'compressThreshold', label: tr('Порог автосжатия контекста, % (10–99)'), value: st.compressThreshold != null ? String(st.compressThreshold) : '' },
  ], (v) => {
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== '') patch[k] = k === 'width' || k === 'maxInputRows' || k === 'compressThreshold' ? Number(val) : val;
    rpc('settings.update', { patch })
      .then(() => addFeed('notice', `· ${tr('настройки сохранены')}`))
      .catch((err: Error) => addFeed('error', `✗ ${err.message}`));
  }, { settingsActions: true });
}
function openUserProfileForm(): void {
  const p = profile.value;
  if (!p) return;
  openForm(tr('Пользователь'), [
    { key: 'name', label: tr('Имя'), value: p.name ?? '' },
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
/** Новый проект: id можно оставить пустым (из папки или штамп как у разговоров). */
function newProjectForm(): void {
  if (roundActive.value) return;
  projNew.id = '';
  projNew.path = '';
  dirBrowse.open = false;
  projNew.show = true;
  nextTick(() => newProjBox.value?.querySelector<HTMLElement>('input')?.focus());
}
function createProjectNew(): void {
  if (!projNew.show) return;
  const id = projNew.id.trim();
  const path = projNew.path.trim();
  projNew.show = false;
  rpcReport(rpc('project.new', { id: id || undefined, path: path || undefined }));
}
function switchProject(p: ProjectRecordInfo): void {
  if (roundActive.value) return;
  if (currentProject.value && p.name === currentProject.value.id) return;
  rpcReport(rpc('project.open', p.path ? { path: p.path } : { id: p.name }));
}
// ── настройки текущего проекта: имя, рабочая папка (браузер путей), ──────────
// ── серверы/ящики/боты; реестры живут в снапшоте (сервер маскирует секреты) ──
const projSettings = reactive({ show: false, name: '', path: '' });
/** Новый проект: свой диалог с тем же браузером путей. */
const projNew = reactive({ show: false, id: '', path: '' });
const newProjBox = ref<HTMLElement | null>(null);
/** Браузер папок сервера (fs.dirs) — общий для настроек проекта и нового проекта. */
const dirBrowse = reactive({
  open: false, path: '', parent: null as string | null,
  dirs: [] as { name: string; path: string }[], drives: [] as string[],
  error: '',
});
let dirBrowseTarget: ((p: string) => void) | null = null;
function browseOpen(target: (p: string) => void, start?: string): void {
  dirBrowseTarget = target;
  browseTo(start);
}
/** Реестры текущего проекта из снапшота (сервер отдаёт один элемент — текущий). */
const curReg = computed(() => projects.value.find((p) => p.id === currentProject.value?.id));
function openProjectSettings(): void {
  if (roundActive.value || !currentProject.value) return;
  projSettings.name = currentProject.value.name;
  projSettings.path = currentProject.value.path;
  dirBrowse.open = false;
  projSettings.show = true;
}
/** Листинг каталога с сервера (fs.dirs); без path — домашний каталог пользователя. */
function browseTo(path?: string): void {
  dirBrowse.error = '';
  rpc<DirListing>('fs.dirs', path ? { path } : {})
    .then((r) => {
      dirBrowse.path = r.path;
      dirBrowse.parent = r.parent;
      dirBrowse.dirs = r.dirs;
      dirBrowse.drives = r.drives;
      dirBrowse.open = true;
    })
    .catch((err: Error) => {
      dirBrowse.error = err.message;
      dirBrowse.open = true;
    });
}
function browseUp(): void { if (dirBrowse.parent) void browseTo(dirBrowse.parent); }
function browsePick(): void {
  const picked = dirBrowse.path;
  dirBrowse.open = false;
  dirBrowseTarget?.(picked);
}
function saveProjectSettings(): void {
  const cur = currentProject.value;
  if (!cur) return;
  const name = projSettings.name.trim();
  const path = projSettings.path.trim();
  const args: Record<string, string> = {};
  if (name && name !== cur.name) args.name = name;
  if (path && path !== cur.path) args.path = path;
  projSettings.show = false;
  if (!Object.keys(args).length) return;
  rpcReport(rpc('project.update', args));
}
function ctxProjectCurrent(e: MouseEvent): void {
  if (!currentProject.value) return;
  openCtx(e, [{ label: tr('Настройки проекта…'), fn: openProjectSettings }]);
}
function ctxProjectKnown(e: MouseEvent, p: ProjectRecordInfo): void {
  openCtx(e, [{ label: tr('Удалить из дома (разговоры тоже)'), fn: () =>
    askDelete(tr('проект «{name}»', { name: p.name }), () => rpcReport(rpc('project.delete', { id: p.name }))) }]);
}
/** Новый сервер проекта: ＋ в сайдбаре и ＋ в разделе диалога настроек. */
function projectHostAdd(p: ProjectInfo): void {
  if (roundActive.value) return;
  openForm(tr('Сервер проекта «{id}»', { id: p.id }), [
    { key: 'id', label: tr('id сервера (напр. prod)') },
    { key: 'host', label: tr('Хост (адрес)') },
    { key: 'user', label: tr('Пользователь (можно пропустить)') },
    { key: 'password', label: tr('Пароль (можно пропустить)'), type: 'password' },
    { key: 'port', label: tr('Порт (можно пропустить)') },
    { key: 'dir', label: tr('Папка на сервере (можно пропустить)') },
  ], (v) => {
    if (!v.id) throw new Error(tr('Жду id сервера'));
    const args: Record<string, unknown> = { id: v.id, host: v.host };
    if (v.user) args.user = v.user;
    if (v.password) args.password = v.password;
    if (v.port) args.port = Number(v.port);
    if (v.dir) args.dir = v.dir;
    rpcReport(rpc('project.host.add', args));
  });
}
function projectHostEdit(h: ProjectHost): void {
  if (roundActive.value) return;
  openForm(tr('Сервер «{name}»', { name: h.name }), [
    { key: 'host', label: tr('Хост (адрес)'), value: h.host },
    { key: 'user', label: tr('Пользователь (можно пропустить)'), value: h.user ?? '' },
    { key: 'password', label: tr('Пароль (пусто — не менять)'), type: 'password' },
    { key: 'port', label: tr('Порт (можно пропустить)'), value: h.port ? String(h.port) : '' },
    { key: 'dir', label: tr('Папка на сервере (можно пропустить)'), value: h.dir ?? '' },
  ], (v) => {
    const args: Record<string, unknown> = { id: h.name, host: v.host };
    if (v.user) args.user = v.user;
    if (v.password) args.password = v.password;
    if (v.port) args.port = Number(v.port);
    if (v.dir) args.dir = v.dir;
    rpcReport(rpc('project.host.update', args));
  });
}
function projectHostDelete(p: ProjectInfo, h: ProjectHost): void {
  if (roundActive.value) return;
  askDelete(tr('сервер «{name}» проекта «{id}»', { name: h.name, id: p.id }), () => rpcReport(rpc('project.host.delete', { id: h.name })));
}
function projectMailAdd(p: ProjectInfo): void {
  if (roundActive.value) return;
  openForm(tr('Ящик проекта «{id}»', { id: p.id }), [
    { key: 'id', label: tr('id ящика (напр. support)') },
    { key: 'user', label: tr('Логин') },
    { key: 'password', label: tr('Пароль'), type: 'password' },
    { key: 'imap', label: tr('IMAP-сервер') },
    { key: 'smtp', label: tr('SMTP-сервер') },
    { key: 'port', label: tr('IMAP-порт (можно пропустить)') },
    { key: 'smtpPort', label: tr('SMTP-порт (можно пропустить)') },
  ], (v) => {
    if (!v.id) throw new Error(tr('Жду id ящика'));
    const args: Record<string, unknown> = { id: v.id };
    if (v.user) args.user = v.user;
    if (v.password) args.password = v.password;
    if (v.imap) args.imap = v.imap;
    if (v.smtp) args.smtp = v.smtp;
    if (v.port) args.port = Number(v.port);
    if (v.smtpPort) args.smtpPort = Number(v.smtpPort);
    rpcReport(rpc('project.mail.add', args));
  });
}
function projectMailEdit(m: MailInfo): void {
  if (roundActive.value) return;
  openForm(tr('Ящик «{id}»', { id: m.id }), [
    { key: 'user', label: tr('Логин'), value: m.user },
    { key: 'password', label: tr('Пароль (пусто — не менять)'), type: 'password' },
    { key: 'imap', label: tr('IMAP-сервер'), value: m.imap },
    { key: 'smtp', label: tr('SMTP-сервер'), value: m.smtp },
    { key: 'port', label: tr('IMAP-порт (можно пропустить)'), value: m.port ? String(m.port) : '' },
    { key: 'smtpPort', label: tr('SMTP-порт (можно пропустить)'), value: m.smtpPort ? String(m.smtpPort) : '' },
  ], (v) => {
    const fields: Record<string, unknown> = {};
    if (v.user) fields.user = v.user;
    if (v.password) fields.password = v.password;
    if (v.imap) fields.imap = v.imap;
    if (v.smtp) fields.smtp = v.smtp;
    if (v.port) fields.port = Number(v.port);
    if (v.smtpPort) fields.smtpPort = Number(v.smtpPort);
    if (!Object.keys(fields).length) throw new Error(tr('Нечего менять: заполните хотя бы одно поле'));
    rpcReport(rpc('project.mail.update', { id: m.id, fields }));
  });
}
function projectMailDelete(m: MailInfo): void {
  if (roundActive.value) return;
  askDelete(tr('ящик «{id}»', { id: m.id }), () => rpcReport(rpc('project.mail.delete', { id: m.id })));
}
function projectBotAdd(p: ProjectInfo): void {
  if (roundActive.value) return;
  openForm(tr('Бот проекта «{id}»', { id: p.id }), [
    { key: 'key', label: tr('Тип бота'), type: 'enum', values: ['telegram', 'max'] },
    { key: 'token', label: tr('Токен'), type: 'password' },
  ], (v) => {
    if (!v.token) throw new Error(tr('Жду токен бота'));
    rpcReport(rpc('project.messenger.add', { key: v.key, token: v.token }));
  });
}
function projectBotEdit(b: MessengerInfo): void {
  if (roundActive.value) return;
  openForm(tr('Бот {key}', { key: b.key }), [
    { key: 'token', label: tr('Новый токен'), type: 'password' },
  ], (v) => {
    // сервер трактует пустой token как «убрать поле» — из формы пустым не шлём
    if (!v.token) throw new Error(tr('Пустой токен удалил бы токен бота — заполните поле'));
    rpcReport(rpc('project.messenger.update', { key: b.key, token: v.token }));
  });
}
function projectBotDelete(b: MessengerInfo): void {
  if (roundActive.value) return;
  askDelete(tr('бота «{key}»', { key: b.key }), () => rpcReport(rpc('project.messenger.delete', { key: b.key })));
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
function openSessionEdit(id: string): void {
  if (roundActive.value) return;
  const meta = sessions.value.find((s) => s.id === id);
  if (!meta) return;
  const schema = schemaOf('session');
  if (!schema) return;
  openForm(tr('Изменить разговор «{title}»', { title: meta.title }), schemaFields('session', meta), (v) => {
    const fields = fieldsFromForm(schema, v);
    if (!fields.title) return;
    // session.update правит ТЕКУЩИЙ разговор — сначала открываем выбранный
    rpcReport(rpc('session.open', { id }).then(() => rpc('session.update', { title: fields.title })));
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
/** Импорт настроек из окна настроек: форма закрывается — поля держат копию
 *  значений на момент открытия, «Сохранить» по ним откатил бы импорт. */
function importSettingsForm(): void {
  if (roundActive.value) return;
  closeForm();
  pickImport('settings');
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

// ── вложение: чипы над вводом, уходят вместе со следующим сообщением ─────────
// 📎 сразу льёт файл в inbox по POST /api/upload (потоком, размер не ограничен),
// 🔗 прикрепляет файл, уже лежащий на сервере, по пути — без передачи
interface StagedFile { name: string; size?: number; path?: string }
const stagedFiles = ref<StagedFile[]>([]);
const attachFileEl = ref<HTMLInputElement | null>(null);
function pickAttach(): void {
  attachFileEl.value?.click();
}
async function onAttachFile(e: Event): Promise<void> {
  const inp = e.target as HTMLInputElement;
  const files = [...(inp.files ?? [])];
  inp.value = '';
  for (const f of files) {
    try {
      await uploadFile(f);
      stagedFiles.value.push({ name: f.name, size: f.size });
      addFeed('notice', `· 📎 ${f.name} (${f.size} ${tr('Б')}) — ${tr('прикреплён к сообщению')}`);
    } catch (err) {
      addFeed('error', `✗ ${f.name}: ${(err as Error).message}`);
    }
  }
}
const refVisible = ref(false);
const refInput = ref('');
const refEl = ref<HTMLInputElement | null>(null);
function pickRef(): void {
  refVisible.value = true;
  nextTick(() => refEl.value?.focus());
}
function stageRef(): void {
  const p = refInput.value.trim();
  refVisible.value = false;
  refInput.value = '';
  if (!p) return;
  const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  stagedFiles.value.push({ name, path: p });
  addFeed('notice', `· 🔗 ${p} — ${tr('прикреплён к сообщению')}`);
}
function cancelRef(): void {
  refVisible.value = false;
  refInput.value = '';
}
function removeStaged(i: number): void {
  stagedFiles.value.splice(i, 1);
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
  // лимит строк из настроек дома (maxInputRows): строки × высота строки + рамка/паддинг
  const rows = Math.max(1, snapshot.settings?.maxInputRows ?? 8);
  const cs = getComputedStyle(el);
  const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 22;
  const frame =
    parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
    parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const max = Math.round(rows * lineH + frame);
  // пустое поле свернуто в две строки и растёт с текстом до max, дальше — скролл
  const min = Math.min(Math.round(2 * lineH + frame), max);
  el.style.maxHeight = `${max}px`;
  el.style.height = 'auto';
  // высоту пустого поля по scrollHeight не меряем: хром включает в него
  // переносы плейсхолдера, и поле стартует в несколько строк
  const need = el.value ? el.scrollHeight : min;
  el.style.height = `${Math.max(min, Math.min(need, max))}px`;
  // под лимитом скролла не место: округление scrollHeight даёт лишний пиксель
  el.style.overflowY = el.value && el.scrollHeight > max ? 'auto' : 'hidden';
}

// ── история отправленных: ↑/↓ на краю ввода, как в TUI (editor.ts) ───────────
const sentHistory: string[] = [];
let histIdx: number | null = null;
let histDraft = '';
/** Запись при отправке: как набрано; пустые и подряд-дубли не пишутся. */
function histRecord(text: string): void {
  if (!text.trim() || sentHistory[sentHistory.length - 1] === text) return;
  sentHistory.push(text);
}
function histSet(text: string): void {
  draft.value = text;
  hideHints();
  autosize();
  nextTick(() => {
    const el = inputEl.value;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  });
}
function histPrev(): void {
  if (histIdx === null) {
    histDraft = draft.value;
    histIdx = sentHistory.length;
  }
  if (histIdx > 0) {
    histIdx--;
    histSet(sentHistory[histIdx]);
  }
}
function histNext(): void {
  if (histIdx === null) return;
  histIdx++;
  if (histIdx >= sentHistory.length) {
    histIdx = null;
    histSet(histDraft);
  } else {
    histSet(sentHistory[histIdx]);
  }
}
function sendUserMessage(): void {
  const text = draft.value.trim();
  if ((!text && stagedFiles.value.length === 0) || roundActive.value || !authed.value) return;
  histRecord(draft.value);
  histIdx = null;
  draft.value = '';
  autosize();
  hideHints();
  roundActive.value = true;
  // 🔗-файлы сервер копирует в inbox сам (без передачи); загруженные через 📎
  // уже там — осталось послать текст с метками [имя] и списком аттачей
  const attachNames = stagedFiles.value.map((f) => f.name);
  const names = attachNames.map((n) => `[${n}]`).join(' ');
  for (const f of stagedFiles.value) {
    if (f.path) send({ type: 'file_ref', name: f.name, path: f.path, defer: true });
  }
  stagedFiles.value = [];
  if (text.startsWith('/')) {
    // команда: исполняет ядро, отчёты придут notice-событиями в журнал
    send({ type: 'command', text });
  } else {
    const full = names ? `${names} ${text}`.trim() : text;
    const msg: ChatMessage = { authorId: 'user', authorName: profile.value?.name ?? tr('Вы'), text: full, ts: Date.now() };
    if (attachNames.length) msg.attachments = attachNames;
    messages.push(msg);
    send({ type: 'user_message', text: full, ...(attachNames.length ? { attachments: attachNames } : {}) });
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
      .map((a) => ({ label: a.name, hint: a.description, insert: a.name + ' ' })),
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
    return ['files', 'shell', 'git', 'arch', 'ssh', 'look', 'image', 'docs', 'ocr', 'web', 'mail', 'telegram', 'max']
      .map((t) => ({ label: t, hint: '', insert: t + ' ' }));
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
  // ↑/↓ на краю ввода — история отправленных; внутри многострочного текста
  // стрелки ходят по строкам (дефолт браузера), как в TUI (editor.ts)
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const el = inputEl.value;
    if (!el) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const atFirst = draft.value.lastIndexOf('\n', a - 1) === -1;
    const atLast = draft.value.indexOf('\n', b) === -1;
    if (e.key === 'ArrowUp' && atFirst && sentHistory.length > 0) {
      e.preventDefault();
      histPrev();
    } else if (e.key === 'ArrowDown' && atLast && histIdx !== null) {
      e.preventDefault();
      histNext();
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
    <!-- на телефоне каркас не помещается: ☰ выдвигает сайдбар шторкой -->
    <button id="btn-menu" class="tb-btn" :title="tr('Разделы')" @click="navOpen = !navOpen">☰</button>
    <span id="logo">🎬 Dream Team</span>
    <span
      v-if="profile?.name"
      class="badge clickable"
      :title="`${profile.name} — ${tr('клик: настройки')}`"
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

  <main id="layout" :class="{ 'drawer-open': navOpen }">
    <!-- ── сайдбар ────────────────────────────────────────────────────────── -->
    <aside
      id="sidebar"
      :style="{ width: sbWidth + 'px' }"
      @click="onSidebarClick"
      @touchstart.passive="onSidebarTouchStart"
      @touchmove.passive="onSidebarTouchMove"
      @touchend="onSidebarTouchEnd"
      @touchcancel.passive="onSidebarTouchCancel"
    >
      <section class="side-sec" :class="{ collapsed: isCollapsed('projects') }" data-sec="projects">
        <div class="side-head" @click="toggleSec('projects')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Проекты') }}</span>
          <button class="sec-filter" :class="{ on: sideOn('projects') }" :title="tr('Фильтр')" @click.stop="sideFilterToggle('projects')">▽</button>
          <button class="sec-add" :title="tr('Новый проект')" @click.stop="newProjectForm">📁＋</button>
          <button class="sec-add" :title="tr('Открыть проект (имя или папка)')" @click.stop="openProjectForm">📂</button>
        </div>
        <div v-if="sideFilter.projects.open" class="sec-frow" @click.stop>
          <input v-model="sideFilter.projects.text" :placeholder="tr('фильтр: имя или путь')" @keydown.esc="sideFilterEsc('projects')">
        </div>
        <div class="sec-btns">
          <button :title="tr('Экспорт текущего проекта в zip (project.json и разговоры)')" @click="exportProject">⬇ {{ tr('проект') }}</button>
          <button :title="tr('Импорт проекта из zip')" @click="pickImport('project')">⬆ {{ tr('импорт') }}</button>
        </div>
        <ul id="projects">
          <li
            class="proj-current"
            data-project-current
            :title="tr('Текущий проект — его данные в доме, projects/<id>/ · правая кнопка — настройки проекта')"
            @contextmenu.prevent="ctxProjectCurrent($event)"
          >
            <span>📁 {{ currentProject?.name ?? tr('не выбран — выберите или создайте') }}</span><span class="meta">{{ currentProject?.path }}</span>
          </li>
          <li
            v-for="p in knownProjectsView"
            :key="p.name"
            class="proj-row"
            :title="p.path + ' — ' + tr('переключиться · правая кнопка — удалить из дома')"
            @click.stop="switchProject(p)"
            @contextmenu.prevent="ctxProjectKnown($event, p)"
          >
            <span>{{ p.name }}</span><span class="meta">{{ p.path }}</span>
          </li>
          <li
            v-for="ph in projectHostsView"
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

      <section class="side-sec" :class="{ collapsed: collapsed.has('sessions') }" data-sec="sessions">
        <div class="side-head" @click="toggleSec('sessions')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Сессии') }}</span>
          <button class="sec-filter" :class="{ on: sideOn('sessions') }" :title="tr('Фильтр')" @click.stop="sideFilterToggle('sessions')">▽</button>
          <button class="sec-add" :title="tr('Новый разговор')" @click.stop="newSession">＋</button>
        </div>
        <div class="sec-btns">
          <button :title="tr('Экспорт текущего разговора в zip')" @click="exportSession">⬇ {{ tr('сессия') }}</button>
          <button :title="tr('Импорт разговора из zip')" @click="pickImport('session')">⬆ {{ tr('импорт') }}</button>
        </div>
        <ul id="sessions">
          <li
            v-for="s in sessionsView"
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
          <li v-if="sideOn('sessions') && !sessionsView.length" class="no-match">{{ tr('нет совпадений') }}</li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('team') }" data-sec="team">
        <div class="side-head" @click="toggleSec('team')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Агенты') }}</span>
          <button class="sec-filter" :class="{ on: sideOn('team') }" :title="tr('Фильтр')" @click.stop="sideFilterToggle('team')">▽</button>
          <button class="sec-add" :title="tr('Новый агент')" @click.stop="openAgentCreate">＋</button>
        </div>
        <div v-if="teamError" class="errline side-err">agents.json: {{ teamError }}</div>
        <ul id="team">
          <li
            v-for="a in teamView"
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
              <div class="sub">{{ a.description ?? '' }}</div>
            </div>
            <span class="del" :title="tr('Удалить агента')" @click.stop="delAgent(a)">✕</span>
          </li>
          <li v-if="sideOn('team') && !teamView.length" class="no-match">{{ tr('нет совпадений') }}</li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('models') }" data-sec="models">
        <div class="side-head" @click="toggleSec('models')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Модели') }}</span>
          <button class="sec-filter" :class="{ on: sideOn('models') }" :title="tr('Фильтр')" @click.stop="sideFilterToggle('models')">▽</button>
          <button class="sec-add" :title="tr('Новая модель')" @click.stop="modelCreate">＋</button>
        </div>
        <ul id="models">
          <li
            v-for="p in modelsView"
            :key="p.id"
            :title="p.img
              ? tr('клик — изменить карточку · правая кнопка — изменить/удалить') + (p.ok ? '' : ` · ${tr('проблема:')} ${p.note ?? ''}`)
              : (p.isDefault ? tr('Модель по умолчанию') : tr('Сделать основным (для агентов)'))
                + (p.isDefault ? '' : ` · ${tr('клик — сделать основным')} · ${tr('правая кнопка — изменить/удалить')}`)
                + (p.vision ? ` · ${tr('◉ зрение')}` : '')
                + (p.ok ? '' : ` · ${tr('проблема:')} ${p.note ?? ''}`)"
            @click="clickModel(p)"
            @contextmenu.prevent="ctxModel($event, p)"
          >
            <div class="content">
              <div class="sess-main">
                <span><span :class="p.ok ? 'st-ok' : 'st-warn'">{{ p.ok ? '✓' : '⚠' }}</span> {{ p.id }}<template v-if="p.vision"><span class="vision">◉</span></template></span>
                <span v-if="p.isDefault" class="tag in">{{ tr('основная') }}</span>
                <span v-if="p.img" class="tag img">{{ tr('картинки') }}</span>
              </div>
              <div class="sub">{{ p.ok ? (p.model ?? p.kind ?? '') : (p.note ?? '') }}</div>
            </div>
            <span v-if="!p.isDefault" class="del" :title="tr('Удалить модель')" @click.stop="delModel(p)">✕</span>
          </li>
          <li v-if="sideOn('models') && !modelsView.length" class="no-match">{{ tr('нет совпадений') }}</li>
        </ul>
      </section>

      <section class="side-sec" :class="{ collapsed: collapsed.has('schedule') }" data-sec="schedule">
        <div class="side-head" @click="toggleSec('schedule')">
          <span class="sec-toggle" :title="tr('Свернуть/развернуть')">▾</span>
          <span class="sec-name">{{ tr('Расписание') }}</span>
          <button class="sec-filter" :class="{ on: sideOn('schedule') }" :title="tr('Фильтр')" @click.stop="sideFilterToggle('schedule')">▽</button>
          <button class="sec-add" :title="tr('Новая задача')" @click.stop="openScheduleForm(true)">＋</button>
        </div>
        <div v-if="sideFilter.schedule.open" class="sec-frow" @click.stop>
          <input v-model="sideFilter.schedule.text" :placeholder="tr('фильтр: текст задачи')" @keydown.esc="sideFilterEsc('schedule')">
        </div>
        <ul id="schedule-list">
          <li class="static" :title="tr('Добавить задачу по расписанию')" @click="openScheduleForm(false)">
            <span class="tag">＋ {{ tr('задача') }}</span>
          </li>
          <li
            v-for="t in scheduleView"
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
          <li v-if="sideOn('schedule') && !scheduleView.length" class="no-match">{{ tr('нет совпадений') }}</li>
        </ul>
      </section>

    </aside>

    <!-- на телефоне затемняет чат под выдвинутой шторкой; клик — закрыть -->
    <div id="sb-backdrop" :class="{ show: navOpen }" @click="navOpen = false"></div>

    <!-- ширина сайдбара меняется перетаскиванием этой границы -->
    <div id="sb-resize" :title="tr('Потянуть — изменить ширину')" @mousedown.prevent="startSidebarResize"></div>

    <!-- ── чат ────────────────────────────────────────────────────────────── -->
    <section id="chatwrap">
      <div id="chat" ref="chatEl" @click="onChatClick" @contextmenu="onChatContext">
        <div id="msgs">
          <template v-for="it in chatFlow" :key="it.key">
            <div v-if="it.kind === 'notice'" class="sysline" :class="it.notice.kind">{{ it.notice.text }}</div>
            <div v-else-if="it.msg.authorId === 'user'" class="msg user" :data-key="it.key">
              <div class="head">👤 {{ it.msg.authorName }}</div>
              <div v-if="it.msg.attachments?.length" class="att-row">
                <a
                  v-for="(name, i) in it.msg.attachments"
                  :key="`${name}:${i}`"
                  class="file-link att-chip"
                  :href="`/api/file?path=${encodeURIComponent(name)}`"
                  target="_blank"
                  rel="noopener"
                >📎 {{ name }}</a>
              </div>
              <!-- eslint-disable-next-line vue/no-v-html — контент экранируется в formatText -->
              <div class="txt" v-html="formatText(attachmentsText(it.msg))"></div>
              <div class="msg-actions">
                <button class="msg-act" :title="tr('Копировать сообщение')" @click="msgCopy(it, $event.currentTarget as HTMLElement)">⧉</button>
                <button class="msg-act" :title="tr('Ответить с цитатой')" @click="msgReply(it)">↩</button>
              </div>
            </div>
            <div v-else-if="it.msg.authorId === 'tool'" class="toolblock">{{ it.msg.text }}</div>
            <div v-else-if="it.msg.authorId === 'session-ref'" class="attachment">
              <b>📎 {{ it.msg.authorName }}</b>
              <div class="digest">{{ it.msg.text }}</div>
            </div>
            <div v-else class="msg" :data-key="it.key">
              <div class="head" :style="{ color: colorByAuthor(it.msg) }">
                {{ it.msg.authorName }}
              </div>
              <!-- eslint-disable-next-line vue/no-v-html — контент экранируется в formatText -->
              <div class="txt" v-html="formatText(it.msg.text)"></div>
              <div class="msg-actions">
                <button class="msg-act" :title="tr('Копировать сообщение')" @click="msgCopy(it, $event.currentTarget as HTMLElement)">⧉</button>
                <button class="msg-act" :title="tr('Ответить с цитатой')" @click="msgReply(it)">↩</button>
              </div>
            </div>
          </template>
          <div v-if="streaming.open" class="msg">
            <div class="head" :style="{ color: colorOf(streaming.color) }">
              {{ streaming.emoji }} {{ streaming.name }}
            </div>
            <!-- eslint-disable-next-line vue/no-v-html — контент экранируется в formatText -->
            <div class="txt" v-html="formatText(streaming.text)"></div>
          </div>
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

      <div v-if="refVisible" id="refrow">
        <input
          ref="refEl"
          v-model="refInput"
          :placeholder="tr('путь на сервере, например /srv/data/report.pdf')"
          @keydown.enter.prevent="stageRef"
          @keydown.esc.prevent="cancelRef"
          @blur="stageRef"
        >
      </div>
      <div id="inputrow">
        <div v-if="stagedFiles.length" id="staged">
          <span v-for="(f, i) in stagedFiles" :key="`${f.name}:${i}`" class="chip" :title="f.path">
            📎 {{ f.path ?? `${f.name} (${f.size} ${tr('Б')})` }}
            <button :title="tr('убрать')" @click="removeStaged(i)">✕</button>
          </span>
        </div>
        <textarea
          id="input"
          ref="inputEl"
          v-model="draft"
          rows="2"
          :placeholder="tr('Напишите агентам… (Enter — отправить, Shift+Enter — новая строка, ↑/↓ — история, @имя — участнику, /help — команды)')"
          @keydown="onInputKey"
          @input="autosize(); updateHints()"
          @click="updateHints"
        ></textarea>
        <div class="input-bar">
          <div class="input-tools">
            <button id="btn-attach" :title="tr('Прикрепить файл (загрузится в inbox проекта)')" @click="pickAttach">📎</button>
            <button id="btn-ref" :title="tr('Прикрепить по пути на сервере (файл не передаётся через браузер)')" @click="pickRef">🔗</button>
            <input ref="attachFileEl" type="file" multiple class="hidden" @change="onAttachFile">
          </div>
          <button id="btn-send" :title="tr('Отправить')" :disabled="roundActive" @click="sendUserMessage">↑</button>
        </div>
      </div>
      <div v-if="ctxInfo || quotaInfo" id="metricsbar">
        <div
          v-if="ctxInfo"
          id="ctxbar"
          :class="ctxInfo.band"
          :title="tr('Контекст: {t} из {w} ({pct}%)', { t: fmtNum(ctxInfo.tokens), w: fmtNum(ctxInfo.win), pct: ctxInfo.pct })"
        >
          <span class="meter"><span class="fill" :style="{ width: ctxInfo.pct + '%' }"></span></span>
          <span>{{ ctxInfo.pct }}% · {{ fmtK(ctxInfo.tokens) }} / {{ fmtK(ctxInfo.win) }}</span>
        </div>
        <div v-if="quotaInfo" id="quotabar" :class="quotaInfo.band" :title="quotaInfo.title">
          <span class="qcap">Q</span>
          <span v-for="w in quotaInfo.windows" :key="w.key" class="qwin">{{ w.label }}<span class="meter"><span class="fill" :style="{ width: w.pct + '%' }"></span></span>{{ w.pct }}%</span>
        </div>
      </div>
    </section>
  </main>

  <!-- ── модальная форма ─────────────────────────────────────────────────── -->
  <div v-if="modal.show" id="modal" @keydown.esc="closeForm" @keydown.enter.prevent="submitForm">
    <div class="modal-box" ref="modalBox">
      <h2>{{ modal.title }}</h2>
      <div>
        <div
          v-for="sec in modalSections"
          :key="sec.title || '_top'"
          class="fld-sec"
          :class="{ collapsed: sec.collapsible && modalCollapsed.has(sec.title) }"
        >
          <button
            v-if="sec.collapsible"
            type="button"
            class="fld-group-head"
            :title="tr('Свернуть/развернуть')"
            @click="toggleModalGroup(sec.title)"
          ><span class="sec-toggle">▾</span> {{ sec.title }}</button>
          <div v-for="f in sec.fields" :key="f.key" class="fld" :class="{ 'fld-chk': f.type === 'boolean' }">
            <label>{{ f.label }}</label>
            <!-- enter.stop — перенос строки в textarea, а не submit формы (enter с root);
                 tab.prevent+taTab — отступ, а не перевод фокуса -->
            <textarea
              v-if="f.type === 'text' || f.type === 'object'"
              v-model="f.value"
              :class="{ mono: f.type === 'object' }"
              :placeholder="f.placeholder"
              rows="4"
              @keydown.enter.stop
              @keydown.tab.prevent="taTab"
            ></textarea>
            <template v-else-if="f.type === 'model'">
              <select v-model="f.value">
                <option v-for="(ov, i) in f.values" :key="ov" :value="ov">{{ f.optionLabels?.[i] ?? ov }}</option>
              </select>
              <textarea
                v-if="f.value === '__json__'"
                v-model="f.json"
                class="mono"
                rows="6"
                placeholder='{"id": "модель", "temperature": 0.3}'
                @keydown.enter.stop
                @keydown.tab.prevent="taTab"
              ></textarea>
            </template>
            <input v-else-if="f.type === 'boolean'" type="checkbox" class="chk" :checked="f.value === 'true'" @change="setBool(f, $event)">
            <select v-else-if="f.type === 'enum'" v-model="f.value">
              <option v-for="(v, i) in f.values" :key="v" :value="v">{{ f.optionLabels?.[i] ?? v }}</option>
            </select>
            <input v-else-if="f.type === 'password'" v-model="f.value" type="password" :placeholder="f.placeholder" autocomplete="new-password">
            <input v-else v-model="f.value" :type="f.type === 'number' ? 'number' : 'text'" :placeholder="f.placeholder" :step="f.type === 'number' ? 'any' : undefined">
            <div v-if="f.desc" class="fld-desc">{{ f.desc }}</div>
          </div>
        </div>
      </div>
      <div v-if="modal.error" class="errline">{{ modal.error }}</div>
      <div v-if="modal.settingsActions" class="row">
        <button :title="tr('Экспорт настроек (без проектов)')" @click="exportSettings">⬇ {{ tr('экспорт настроек') }}</button>
        <button :title="tr('Импорт настроек из zip (проекты не трогаются)')" @click="importSettingsForm">⬆ {{ tr('импорт настроек') }}</button>
      </div>
      <div class="row">
        <button @click="submitForm">{{ tr('Сохранить') }}</button>
        <button @click="closeForm">{{ tr('Отмена') }}</button>
      </div>
    </div>
  </div>

  <!-- ── отчёт по токенам: ПКМ «Статистика» у разговора или модели ─────────── -->
  <div v-if="report.show" id="modal" @keydown.esc="closeReport">
    <div class="modal-box" ref="reportBox">
      <h2>{{ report.title }}</h2>
      <div v-for="(l, i) in report.lines" :key="i" class="repline" :class="{ 'repline-gap': l === '' }">{{ l }}</div>
      <div class="row">
        <button @click="closeReport">{{ tr('Закрыть') }}</button>
      </div>
    </div>
  </div>

  <!-- ── фильтры сайдбара (сессии/агенты/модели): «Применить» и «Отмена» ────── -->
  <!-- ── закрывают окно, «Очистить» чистит и применяет на живом списке ─────── -->
  <div v-if="filterModal.show" id="modal" @keydown.esc="cancelFilter" @keydown.enter.prevent="applyFilter">
    <div class="modal-box" ref="filterBox">
      <h2>{{ tr('Фильтры') }}</h2>
      <template v-if="filterModal.sec === 'sessions'">
        <div class="fld"><label>{{ tr('Название') }}</label><input v-model="filterModal.sessions.text"></div>
        <div class="fld">
          <label>{{ tr('Создан') }}</label>
          <div class="range"><input type="date" v-model="filterModal.sessions.createdFrom"><span>—</span><input type="date" v-model="filterModal.sessions.createdTo"></div>
        </div>
        <div class="fld">
          <label>{{ tr('Последнее сообщение') }}</label>
          <div class="range"><input type="date" v-model="filterModal.sessions.updatedFrom"><span>—</span><input type="date" v-model="filterModal.sessions.updatedTo"></div>
        </div>
      </template>
      <template v-else-if="filterModal.sec === 'team'">
        <div class="fld"><label>{{ tr('Имя') }}</label><input v-model="filterModal.team.text"></div>
        <div class="fld"><label>{{ tr('Тулы') }}</label><input v-model="filterModal.team.tools" placeholder="shell, files…"></div>
        <div class="fld">
          <label>{{ tr('В чате') }}</label>
          <select v-model="filterModal.team.chat">
            <option value="">{{ tr('любой') }}</option>
            <option value="in">{{ tr('в чате') }}</option>
            <option value="out">{{ tr('не в чате') }}</option>
          </select>
        </div>
      </template>
      <template v-else>
        <div class="fld"><label>id</label><input v-model="filterModal.models.text"></div>
        <div class="fld">
          <label>{{ tr('Провайдер') }}</label>
          <select v-model="filterModal.models.provider">
            <option value="">{{ tr('любой') }}</option>
            <option v-for="p in snapshot.providers ?? []" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div class="fld">
          <label>{{ tr('Тип') }}</label>
          <select v-model="filterModal.models.kind">
            <option value="">{{ tr('любой') }}</option>
            <option value="chat">{{ tr('обычная') }}</option>
            <option value="image">{{ tr('изображение') }}</option>
          </select>
        </div>
        <div class="fld">
          <label>vision</label>
          <select v-model="filterModal.models.vision">
            <option value="">{{ tr('любой') }}</option>
            <option value="yes">{{ tr('есть') }}</option>
            <option value="no">{{ tr('нет') }}</option>
          </select>
        </div>
      </template>
      <div class="row">
        <button @click="applyFilter">{{ tr('Применить') }}</button>
        <button @click="clearFilter">{{ tr('Очистить') }}</button>
        <button @click="cancelFilter">{{ tr('Отмена') }}</button>
      </div>
    </div>
  </div>

  <!-- ── новый проект: id можно оставить пустым (из папки или штамп), ──────── -->
  <!-- ── рабочая папка — через браузер папок сервера (как в настройках) ────── -->
  <div v-if="projNew.show" id="projnew" @keydown.esc="projNew.show = false">
    <div class="modal-box proj-box" ref="newProjBox">
      <h2>{{ tr('Новый проект') }}</h2>

      <div class="fld"><label>{{ tr('id проекта (можно пропустить — из папки или штамп)') }}</label><input v-model="projNew.id"></div>
      <div class="fld">
        <label>{{ tr('Рабочая папка (можно пропустить — данные будут в доме)') }}</label>
        <div class="pathline">
          <input v-model="projNew.path">
          <button :title="tr('Обзор папок компьютера')" @click="browseOpen((p) => (projNew.path = p), projNew.path || undefined)">📂</button>
        </div>
      </div>

      <div v-if="dirBrowse.open" id="dirbrowse">
        <div class="dirnav">
          <button :title="tr('Домашний каталог')" @click="browseTo()">🏠</button>
          <button :disabled="!dirBrowse.parent" :title="tr('На уровень выше')" @click="browseUp">↑</button>
          <span class="meta">{{ dirBrowse.path }}</span>
        </div>
        <div v-if="dirBrowse.drives.length" class="dirdrives">
          <button v-for="d in dirBrowse.drives" :key="d" @click="browseTo(d)">{{ d }}</button>
        </div>
        <div v-if="dirBrowse.error" class="errline">{{ dirBrowse.error }}</div>
        <ul v-else class="dirlist">
          <li v-for="d in dirBrowse.dirs" :key="d.path" @click="browseTo(d.path)">📁 {{ d.name }}</li>
          <li v-if="!dirBrowse.dirs.length" class="reg-empty">{{ tr('подпапок нет') }}</li>
        </ul>
        <div class="row">
          <button @click="browsePick">{{ tr('Выбрать эту папку') }}</button>
          <button @click="dirBrowse.open = false">{{ tr('Скрыть обзор') }}</button>
        </div>
      </div>

      <div class="row">
        <button @click="createProjectNew">{{ tr('Создать') }}</button>
        <button @click="projNew.show = false">{{ tr('Отмена') }}</button>
      </div>
    </div>
  </div>

  <!-- ── настройки проекта: имя, рабочая папка (браузер путей с сервера), ──── -->
  <!-- ── серверы/ящики/боты; секреты в списке замаскированы (🔑 = задан) ──── -->
  <div v-if="projSettings.show" id="projdlg" @keydown.esc="projSettings.show = false">
    <div class="modal-box proj-box">
      <h2>{{ tr('Настройки проекта «{name}»', { name: currentProject?.name ?? '' }) }}</h2>

      <div class="fld"><label>{{ tr('Имя') }}</label><input v-model="projSettings.name"></div>
      <div class="fld">
        <label>{{ tr('Рабочая папка') }}</label>
        <div class="pathline">
          <input v-model="projSettings.path">
          <button :title="tr('Обзор папок компьютера')" @click="browseOpen((p) => (projSettings.path = p), projSettings.path || undefined)">📂</button>
        </div>
      </div>

      <div v-if="dirBrowse.open" id="dirbrowse">
        <div class="dirnav">
          <button :title="tr('Домашний каталог')" @click="browseTo()">🏠</button>
          <button :disabled="!dirBrowse.parent" :title="tr('На уровень выше')" @click="browseUp">↑</button>
          <span class="meta">{{ dirBrowse.path }}</span>
        </div>
        <div v-if="dirBrowse.drives.length" class="dirdrives">
          <button v-for="d in dirBrowse.drives" :key="d" @click="browseTo(d)">{{ d }}</button>
        </div>
        <div v-if="dirBrowse.error" class="errline">{{ dirBrowse.error }}</div>
        <ul v-else class="dirlist">
          <li v-for="d in dirBrowse.dirs" :key="d.path" @click="browseTo(d.path)">📁 {{ d.name }}</li>
          <li v-if="!dirBrowse.dirs.length" class="reg-empty">{{ tr('подпапок нет') }}</li>
        </ul>
        <div class="row">
          <button @click="browsePick">{{ tr('Выбрать эту папку') }}</button>
          <button @click="dirBrowse.open = false">{{ tr('Скрыть обзор') }}</button>
        </div>
      </div>

      <div class="proj-secs">
        <section>
          <h3>{{ tr('Серверы') }} <button class="sec-add" :title="tr('Добавить сервер в проект')" @click="curReg && projectHostAdd(curReg)">＋</button></h3>
          <ul class="reglist">
            <li v-for="h in curReg?.hosts ?? []" :key="h.name">
              <span>{{ h.name }}</span>
              <span class="meta">{{ h.host }}{{ h.user ? ' · ' + h.user : '' }}{{ h.port ? ':' + h.port : '' }}{{ h.hasPassword ? ' · 🔑' : '' }}</span>
              <span class="del" :title="tr('Изменить сервер')" @click="projectHostEdit(h)">✎</span>
              <span class="del" :title="tr('Удалить сервер')" @click="curReg && projectHostDelete(curReg, h)">✕</span>
            </li>
            <li v-if="!(curReg?.hosts ?? []).length" class="reg-empty">{{ tr('пока пусто — «＋» добавит запись') }}</li>
          </ul>
        </section>
        <section>
          <h3>{{ tr('Почтовые ящики') }} <button class="sec-add" :title="tr('Добавить ящик в проект')" @click="curReg && projectMailAdd(curReg)">＋</button></h3>
          <ul class="reglist">
            <li v-for="m in curReg?.mails ?? []" :key="m.id">
              <span>{{ m.id }}</span>
              <span class="meta">{{ m.user }}{{ m.imap ? ' · ' + m.imap : '' }}{{ m.smtp ? ' · ' + m.smtp : '' }}{{ m.hasPassword ? ' · 🔑' : '' }}</span>
              <span class="del" :title="tr('Изменить ящик')" @click="projectMailEdit(m)">✎</span>
              <span class="del" :title="tr('Удалить ящик')" @click="projectMailDelete(m)">✕</span>
            </li>
            <li v-if="!(curReg?.mails ?? []).length" class="reg-empty">{{ tr('пока пусто — «＋» добавит запись') }}</li>
          </ul>
        </section>
        <section>
          <h3>{{ tr('Боты') }} <button class="sec-add" :title="tr('Добавить бота в проект')" @click="curReg && projectBotAdd(curReg)">＋</button></h3>
          <ul class="reglist">
            <li v-for="b in curReg?.messengers ?? []" :key="b.key">
              <span>{{ b.key }}</span>
              <span class="meta">{{ b.hasToken ? tr('токен задан 🔑') : tr('токена нет') }}</span>
              <span class="del" :title="tr('Изменить бота')" @click="projectBotEdit(b)">✎</span>
              <span class="del" :title="tr('Удалить бота')" @click="projectBotDelete(b)">✕</span>
            </li>
            <li v-if="!(curReg?.messengers ?? []).length" class="reg-empty">{{ tr('пока пусто — «＋» добавит запись') }}</li>
          </ul>
        </section>
      </div>

      <div class="row">
        <button @click="saveProjectSettings">{{ tr('Сохранить') }}</button>
        <button @click="projSettings.show = false">{{ tr('Отмена') }}</button>
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
