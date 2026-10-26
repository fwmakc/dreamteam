/**
 * Dream Team — веб-оболочка (vanilla JS, без сборки).
 * Клиент протокола serve.ts: один WS на /ws, события рисуются в чат,
 * состояние приходит снапшотами (state) и перерисовывает всё целиком.
 * Команды `/…` уходят типом command (ядро исполняет их так же, как терминал),
 * автодополнение — по словарю из state (completion.operations + панели).
 */
'use strict';

(() => {
  // ── элементы ─────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const chatEl = $('chat');
  const msgsEl = $('msgs');
  const feedEl = $('feed');
  const inputEl = $('input');
  const sessionsEl = $('sessions');
  const teamEl = $('team');
  const modelsEl = $('models');
  const connEl = $('conn');
  const statusbarEl = $('statusbar');
  const busyLabelEl = $('busy-label');
  const btnAbort = $('btn-abort');
  const btnSend = $('btn-send');
  const confirmEl = $('confirm');
  const confirmTextEl = $('confirm-text');
  const confirmDescEl = $('confirm-desc');
  const chooseEl = $('choose');
  const chooseListEl = $('choose-list');
  const hintsEl = $('hints');
  const authEl = $('auth');
  const authInput = $('auth-token');
  const authError = $('auth-error');
  const authEnter = $('auth-enter');
  const btnLogout = $('btn-logout');
  const modalEl = $('modal');
  const modalTitle = $('modal-title');
  const modalFields = $('modal-fields');
  const modalError = $('modal-error');
  const projectsEl = $('projects');
  const scheduleListEl = $('schedule-list');
  const importFile = $('import-file');
  const btnExportHome = $('btn-export-home');
  const btnExportSession = $('btn-export-session');
  const btnImportHome = $('btn-import-home');
  const btnImportSession = $('btn-import-session');
  const btnAuto = $('btn-auto');
  const btnAttach = $('btn-attach');
  const attachFile = $('attach-file');

  // ── состояние клиента ────────────────────────────────────────
  let ws = null;
  let state = null;            // последний снапшот от сервера
  let roundActive = false;     // между отправкой и ближайшим state
  let currentMsg = null;       // открытая реплика стрима {el, body, text, open}
  const busyMap = new Map();   // busy id → label
  const pendingRpc = new Map(); // rpc id → {resolve, reject}
  let rpcSeq = 0;
  let retryTimer = null;
  // сервер без TOKEN шлёт state сразу — клиент считает себя «в системе»;
  // auth_required переводит в ложь до успешного auth
  let authed = true;

  const COLORS = {
    black: '#9aa3af', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
    gray: '#7f8790',
  };
  const colorOf = (name) => COLORS[String(name ?? '').toLowerCase()] ?? '#d7dae0';
  const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');

  // ── перевод интерфейса: словарь приходит в state.ui (русский → перевод) ──
  function tr(s, vars) {
    let out = (state?.ui?.strings?.[s]) ?? s;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
    return out;
  }

  /** Статические надписи index.html: переписываем по таблице после каждого state. */
  function applyStaticI18n() {
    if (!state?.ui || state.ui.id === 'ru') return;
    const set = (sel, attr, key, vars) => {
      const el = document.querySelector(sel);
      if (!el) return;
      if (attr === 'text') el.textContent = tr(key, vars);
      else el.setAttribute(attr, tr(key, vars));
    };
    set('#btn-settings-top', 'title', 'Настройки');
    set('#btn-export-home', 'title', 'Экспорт дома (настройки + история, без .env)');
    set('#btn-import-home', 'title', 'Импорт дома из zip');
    set('#btn-logout', 'title', 'Забыть токен доступа на этом устройстве');
    set('#btn-logout', 'text', 'Выйти');
    set('#auth h2', 'text', 'Доступ к Dream Team');
    set('#auth .dim', 'text', 'Введите токен доступа (TOKEN из ~/.dreamteam/.env сервера).');
    set('#auth-token', 'placeholder', 'токен');
    set('#auth-enter', 'text', 'Войти');
    document.querySelectorAll('.sec-toggle').forEach((el) => el.setAttribute('title', tr('Свернуть/развернуть')));
    set('[data-sec="sessions"] .sec-name', 'text', 'Сессии');
    set('[data-sec="sessions"] .sec-add', 'title', 'Новый разговор');
    set('#btn-export-session', 'title', 'Экспорт текущего разговора в zip');
    set('#btn-export-session', 'text', `⬇ ${tr('сессия')}`);
    set('#btn-import-session', 'title', 'Импорт разговора из zip');
    set('#btn-import-session', 'text', `⬆ ${tr('импорт')}`);
    set('[data-sec="team"] .sec-name', 'text', 'Команда');
    set('[data-sec="team"] .sec-add', 'title', 'Новый агент');
    set('[data-sec="models"] .sec-name', 'text', 'Модели');
    set('[data-sec="models"] .sec-add', 'title', 'Новая модель');
    set('[data-sec="schedule"] .sec-name', 'text', 'Расписание');
    set('[data-sec="schedule"] .sec-add', 'title', 'Новая задача');
    set('[data-sec="projects"] .sec-name', 'text', 'Проекты');
    set('[data-sec="projects"] .sec-add', 'title', 'Новый проект');
    set('#confirm-yes', 'text', `✓ ${tr('Разрешить')}`);
    set('#confirm-no', 'text', `✗ ${tr('Отказать')}`);
    set('#choose .side-head', 'text', 'Какой разговор приложить?');
    set('#choose-cancel', 'text', 'Никакой');
    set('#btn-abort', 'title', 'Прервать раунд (Esc в терминале)');
    set('#btn-abort', 'text', `⏹ ${tr('Прервать')}`);
    set('#btn-attach', 'title', 'Прикрепить файл (положится в inbox проекта)');
    set('#input', 'placeholder', 'Напишите команде… (Enter — отправить, Shift+Enter — новая строка, @имя — участнику, /help — команды)');
    set('#btn-send', 'title', 'Отправить');
    set('#modal-ok', 'text', 'Сохранить');
    set('#modal-cancel', 'text', 'Отмена');
    set('#del-modal h2', 'text', 'Вы точно хотите удалить запись?');
    set('#del-yes', 'text', 'Да');
    set('#del-no', 'text', 'Нет');
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /** Текст реплики: ```блоки``` → <pre>, остальное — экранированный текст. */
  /** [имя.расширение] → ссылка на скачивание из workspace. */
  function fileLinks(escaped) {
    return escaped.replace(/\[([^\[\]]+\.[A-Za-z0-9]{2,8})\]/g, (_m, name) => {
      const href = `/api/file?path=${encodeURIComponent(name)}`;
      return `<a class="file-link" href="${href}" download>[${name}]</a>`;
    });
  }

  function formatText(text) {
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

  function scrollDown() { chatEl.scrollTop = chatEl.scrollHeight; }

  // ── websocket ────────────────────────────────────────────────
  function connect() {
    clearTimeout(retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      connEl.textContent = tr('на связи');
      connEl.className = 'conn on';
      send({ type: 'hello' });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      dispatch(msg);
    };
    ws.onclose = () => {
      connEl.textContent = tr('отключено — переподключаюсь…');
      connEl.className = 'conn off';
      retryTimer = setTimeout(connect, 1500);
    };
    ws.onerror = () => ws.close();
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendAuth(token) {
    send({ type: 'auth', token });
  }

  function tryStoredToken() {
    const saved = localStorage.getItem('dt-token');
    if (saved) {
      sendAuth(saved);
      return true;
    }
    return false;
  }

  // ── модальная форма: поля [{key,label,value,placeholder?}] ────
  let modalOnSave = null;
  function openForm(title, fields, onSave) {
    modalTitle.textContent = title;
    modalFields.innerHTML = '';
    for (const f of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'fld';
      const label = document.createElement('label');
      label.textContent = f.label ?? f.key;
      wrap.appendChild(label);
      const input = document.createElement('input');
      input.dataset.key = f.key;
      input.value = f.value ?? '';
      if (f.placeholder) input.placeholder = f.placeholder;
      wrap.appendChild(input);
      modalFields.appendChild(wrap);
    }
    modalError.classList.add('hidden');
    modalOnSave = onSave;
    modalEl.classList.remove('hidden');
    modalFields.querySelector('input')?.focus();
  }
  function closeForm() {
    modalEl.classList.add('hidden');
    modalOnSave = null;
  }
  function submitForm() {
    if (!modalOnSave) return;
    const values = {};
    for (const input of modalFields.querySelectorAll('input')) values[input.dataset.key] = input.value.trim();
    try {
      modalOnSave(values);
      closeForm();
    } catch (err) {
      modalError.textContent = err.message;
      modalError.classList.remove('hidden');
    }
  }
  $('modal-ok').onclick = submitForm;
  $('modal-cancel').onclick = closeForm;
  modalEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeForm();
    if (e.key === 'Enter') submitForm();
  });

  // ── контекстное меню (правая кнопка) и подтверждение удаления ─
  // двойной клик в интерфейсе не используется: одиночный клик — основное
  // действие записи, правая кнопка — меню «Изменить»/«Удалить».
  const ctxOverlay = document.createElement('div');
  ctxOverlay.className = 'ctx-overlay hidden';
  const ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu hidden';
  document.body.appendChild(ctxOverlay);
  document.body.appendChild(ctxMenu);
  ctxOverlay.addEventListener('click', closeCtx);
  ctxOverlay.addEventListener('contextmenu', (e) => { e.preventDefault(); closeCtx(); });
  function closeCtx() {
    ctxOverlay.classList.add('hidden');
    ctxMenu.classList.add('hidden');
    ctxMenu.innerHTML = '';
  }
  function openCtx(e, items) {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.textContent = it.label;
      b.onclick = () => { closeCtx(); it.fn(); };
      ctxMenu.appendChild(b);
    }
    ctxOverlay.classList.remove('hidden');
    ctxMenu.classList.remove('hidden');
    const r = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 8)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 8)) + 'px';
  }

  let delFn = null;
  function askDelete(subject, fn) {
    $('del-subject').textContent = subject;
    delFn = fn;
    $('del-modal').classList.remove('hidden');
  }
  function answerDelete(yes) {
    const fn = delFn;
    $('del-modal').classList.add('hidden');
    delFn = null;
    if (yes && fn) fn();
  }
  $('del-yes').onclick = () => answerDelete(true);
  $('del-no').onclick = () => answerDelete(false);
  $('del-modal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') answerDelete(false);
  });

  // ── агенты: создать/удалить/настроить ─────────────────────────
  function openAgentCreate() {
    openForm(tr('Новый агент'), [
      { key: 'id', label: tr('id (латиница, цифры, -/_)') },
      { key: 'name', label: tr('Имя') },
      { key: 'role', label: tr('Роль (можно пропустить)') },
    ], (v) => {
      rpc('team.add', v)
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }
  function openAgentSettings(a) {
    openForm(tr('Настройки агента {name}', { name: a.name }), [
      { key: 'role', label: tr('Роль'), value: a.role ?? '' },
      { key: 'model', label: tr('Модель'), value: a.model ?? '' },
      { key: 'temperature', label: tr('Температура (0–2)'), value: a.temperature ?? '' },
      { key: 'prompt', label: tr('Промпт'), value: a.prompt ?? '' },
      { key: 'tools', label: tr('Тулы через запятую (есть: {list})', { list: (a.tools ?? []).join(', ') || tr('нет') }) },
    ], (v) => {
      const fields = {};
      for (const [k, val] of Object.entries(v)) if (val !== '' && k !== 'tools') fields[k] = k === 'temperature' ? Number(val) : val;
      const report = (r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`);
      const fail = (err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`);
      const chain = Object.keys(fields).length > 0 ? rpc('team.update', { id: a.id, fields }).then(report).catch(fail) : Promise.resolve();
      const have = new Set(a.tools ?? []);
      for (const tool of (v.tools || '').split(',').map((t) => t.trim()).filter(Boolean)) {
        if (have.has(tool.toLowerCase())) continue;
        chain.then(() => rpc('team.grant', { agent: a.id, tool }).then(report).catch(fail));
      }
    });
  }
  function agentDelete(a) {
    askDelete(tr('агент «{name}»', { name: a.name }), () => {
      rpc('team.delete', { id: a.id })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  // ── модели: создать/удалить ──────────────────────────────────
  function modelCreate() {
    openForm(tr('Новая модель'), [
      { key: 'id', label: tr('id (латиница)') },
      { key: 'adapter', label: tr('Адаптер (openai-compatible / anthropic / gigachat)'), value: 'openai-compatible' },
      { key: 'baseUrl', label: 'baseUrl' },
      { key: 'model', label: tr('Модель') },
      { key: 'apiKey', label: tr('Ключ API (можно пусто — для локальных API)') },
    ], (v) => {
      rpc('model.add', { id: v.id, config: v })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }
  function modelDelete(p) {
    if (p.isDefault) return;
    askDelete(tr('модель «{id}»', { id: p.id }), () => {
      rpc('model.delete', { id: p.id })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  // ── расписание: список задач, добавить/удалить/вкл-выкл ───────
  function renderSchedule(tasks) {
    scheduleListEl.innerHTML = '';
    const addLi = document.createElement('li');
    addLi.innerHTML = `<span class="tag">＋ ${tr('задача')}</span>`;
    addLi.onclick = () => openForm(tr('Задача по расписанию'), [
      { key: 'message', label: tr('Задание (уйдёт в чат как сообщение)') },
      { key: 'intervalMinutes', label: tr('Каждые N минут'), value: '10' },
    ], (v) => {
      rpc('schedule.add', { message: v.message, intervalMinutes: Number(v.intervalMinutes) || 10 })
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
    scheduleListEl.appendChild(addLi);

    for (const t of tasks ?? []) {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="tag ${t.enabled ? 'in' : ''}">${t.enabled ? '▶' : '⏸'}</span>` +
        `<span class="meta">${t.intervalMinutes} ${tr('мин')}</span>` +
        `<span>${esc(t.message.slice(0, 40))}</span>` +
        `<span class="del" title="${esc(tr('Удалить задачу'))}">✕</span>`;
      li.title = `${t.message} — ${tr('каждые {n} мин', { n: t.intervalMinutes })} · ${tr('клик — пауза/пуск')} · ${tr('правая кнопка — удалить')}`;
      li.querySelector('.del').onclick = (e) => {
        e.stopPropagation();
        askDelete(tr('задача «{msg}»', { msg: t.message.slice(0, 40) }), () => {
          rpc('schedule.delete', { id: t.id })
            .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
        });
      };
      li.oncontextmenu = (e) => openCtx(e, [
        { label: tr(t.enabled ? 'Пауза' : 'Запустить'), fn: () => rpc('schedule.toggle', { id: t.id }) },
        { label: tr('Удалить'), fn: () => {
          askDelete(tr('задача «{msg}»', { msg: t.message.slice(0, 40) }), () => {
            rpc('schedule.delete', { id: t.id })
              .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
          });
        } },
      ]);
      li.onclick = () => rpc('schedule.toggle', { id: t.id });
      scheduleListEl.appendChild(li);
    }
  }

  // ── авто-режим: тоггл (кнопка шлёт /auto через command) ───────
  function renderAuto() {
    const auto = state?.auto;
    const on = Boolean(auto?.mode);
    btnAuto.textContent = on ? `🤖 ${tr('Авто')} (${auto?.left ?? 0})` : `🤖 ${tr('Авто')}`;
    btnAuto.classList.toggle('in', on);
    btnAuto.title = on
      ? tr('Автономный режим вкл (осталось {n} ходов). Клик — выключить.', { n: auto?.left ?? 0 })
      : tr('Автономный режим: агенты решают вопросы сами. Клик — включить.');
  }

  // ── настройки: форма правки ──────────────────────────────────
  function openSettingsForm() {
    const st = state.settings;
    if (!st) return;
    openForm(tr('Настройки'), [
      { key: 'language', label: tr('Язык общения (russian / ru-RU / english…)'), value: st.language ?? '' },
      { key: 'autoMessage', label: tr('Автоответ в автономном режиме'), value: st.autoMessage ?? '' },
      { key: 'ui', label: tr('Язык интерфейса (ru / en / zh / свой из ~/.dreamteam/lang)'), value: state.ui?.id ?? '' },
      { key: 'width', label: tr('Ширина экрана (40–500)'), value: st.width ?? '' },
    ], (v) => {
      const patch = {};
      for (const [k, val] of Object.entries(v)) if (val !== '') patch[k] = k === 'width' ? Number(val) : val;
      rpc('settings.set', { patch })
        .then(() => addFeed(`<div class="notice">· ${esc(tr('настройки сохранены'))}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  // ── пользователь: форма правки ────────────────────────────────
  function openUserProfileForm() {
    const p = state.profile;
    if (!p) return;
    openForm(tr('Пользователь'), [
      { key: 'name', label: tr('Имя'), value: p.name ?? '' },
      { key: 'role', label: tr('Роль'), value: p.role ?? '' },
      { key: 'about', label: tr('О себе'), value: p.about ?? '' },
    ], (v) => {
      rpc('profile.set', v)
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  // ── менеджер: форма правки ───────────────────────────────────
  function openManagerForm() {
    const mgr = state.manager;
    if (!mgr) return;
    openForm(tr('Менеджер переговорки'), [
      { key: 'name', label: tr('Имя'), value: mgr.name ?? '' },
      { key: 'emoji', label: tr('Эмодзи'), value: mgr.emoji ?? '' },
      { key: 'color', label: tr('Цвет (yellow/cyan/…)'), value: mgr.color ?? '' },
      { key: 'temperature', label: tr('Температура (0–2)'), value: mgr.temperature ?? '' },
    ], (v) => {
      const fields = {};
      for (const [k, val] of Object.entries(v)) if (val !== '') fields[k] = k === 'temperature' ? Number(val) : val;
      rpc('manager.set', { fields })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  // ── проекты: добавить сервер/удалить ──────────────────────────
  function projectAdd() {
    openForm(tr('Новый проект'), [
      { key: 'id', label: tr('id проекта (латиница)') },
      { key: 'hostName', label: tr('Имя сервера (напр. prod)') },
      { key: 'host', label: tr('Хост (адрес)') },
      { key: 'user', label: tr('Пользователь (можно пропустить)') },
      { key: 'port', label: tr('Порт (можно пропустить)') },
    ], (v) => {
      rpc('project.host.add', v)
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }
  function projectHostDelete(p, h) {
    askDelete(tr('сервер «{name}» проекта «{id}»', { name: h.name, id: p.id }), () => {
      rpc('project.host.delete', { name: h.name })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  function showAuthForm(errorText) {
    authed = false;
    authEl.classList.remove('hidden');
    authError.textContent = errorText ?? '';
    authError.classList.toggle('hidden', !errorText);
    authInput.value = '';
    authInput.focus();
  }

  function enterWithToken() {
    const token = authInput.value.trim();
    if (!token) return;
    localStorage.setItem('dt-token', token);
    authed = true;
    sendAuth(token);
    authEl.classList.add('hidden');
  }

  function rpc(method, args) {
    return new Promise((resolve, reject) => {
      const id = `c${++rpcSeq}`;
      pendingRpc.set(id, { resolve, reject });
      send({ type: 'rpc', id, method, args });
    });
  }

  // ── диспетчер событий сервера ────────────────────────────────
  function dispatch(msg) {
    switch (msg.type) {
      case 'export_data': {
        const bin = atob(msg.dataB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = msg.name || 'dt-export.zip';
        a.click();
        URL.revokeObjectURL(url);
        addFeed(`<div class="notice">· ${tr('Экспорт готов: {name}', { name: msg.name })}</div>`);
        break;
      }
      case 'auth_required': {
        authed = false;
        btnLogout.classList.remove('hidden');
        if (!tryStoredToken()) showAuthForm();
        break;
      }
      case 'auth_ok':
        authed = true;
        authEl.classList.add('hidden');
        btnLogout.classList.remove('hidden');
        break;
      case 'auth_failed':
        localStorage.removeItem('dt-token');
        showAuthForm(tr('Неверный токен — попробуйте ещё раз.'));
        break;
      case 'state':
        roundActive = false;
        state = msg.state;
        hidePrompts();
        authEl.classList.add('hidden');
        renderAll();
        renderStatus();
        applyStaticI18n();
        break;
      case 'session_opened':
        state = state ?? {};
        state.session = msg.session;
        clearMsgs();
        renderHistory(msg.session.messages);
        renderSidebar();
        break;
      case 'turn_header': {
        closeStreaming();
        const el = document.createElement('div');
        el.className = 'msg';
        el.innerHTML =
          `<div class="head" style="color:${colorOf(msg.agent.color)}">` +
          `${esc(msg.agent.emoji ?? '🤖')} ${esc(msg.agent.name)}` +
          (msg.agent.role ? ` <span class="role">${esc(msg.agent.role)}</span>` : '') +
          `</div><div class="txt dim"></div>`;
        msgsEl.appendChild(el);
        currentMsg = { el, body: el.querySelector('.txt'), text: '', open: true };
        scrollDown();
        break;
      }
      case 'delta':
        if (currentMsg?.open) {
          currentMsg.text += msg.text;
          currentMsg.body.textContent = currentMsg.text;
          currentMsg.body.classList.remove('dim');
          scrollDown();
        }
        break;
      case 'turn_end':
        if (currentMsg) {
          if (msg.full && msg.full.trim()) {
            currentMsg.body.innerHTML = formatText(msg.full);
          } else if (!currentMsg.text) {
            currentMsg.el.remove(); // заголовок без слов (ошибка уже показана)
          }
          currentMsg.open = false;
          currentMsg = null;
          scrollDown();
        }
        break;
      case 'say':
        // реплика без стрима: в открытый заголовок или отдельным сообщением
        if (currentMsg?.open) {
          currentMsg.body.innerHTML = formatText(msg.text);
          currentMsg.body.classList.remove('dim');
          currentMsg.open = false;
          currentMsg = null;
        } else {
          addMsg(`<div class="msg"><div class="txt">${formatText(msg.text)}</div></div>`);
        }
        scrollDown();
        break;
      case 'notice':
        closeStreaming();
        addFeed(`<div class="notice">· ${esc(msg.text)}</div>`);
        break;
      case 'error':
        closeStreaming();
        addFeed(`<div class="errline">✗ ${esc(msg.text)}</div>`);
        break;
      case 'tool_results':
        closeStreaming();
        addMsg(`<div class="toolblock">${msg.results.map((r) => `⚙ ${esc(r)}`).join('\n')}</div>`);
        break;
      case 'attachment':
        closeStreaming();
        addMsg(`<div class="attachment"><b>📎 ${esc(msg.title)}</b>` +
          `<div class="digest">${esc(msg.digest)}</div></div>`);
        break;
      case 'busy':
        busyMap.set(msg.id, msg.label);
        renderStatus();
        break;
      case 'busy_end':
        busyMap.delete(msg.id);
        renderStatus();
        break;
      case 'projects':
        renderProjects(msg.projects);
        break;
      case 'settings':
        state = state ?? {};
        state.settings = msg.settings;
        break;
      case 'manager':
        state = state ?? {};
        state.manager = msg.manager;
        renderTopbar();
        break;
      case 'schedule':
        renderSchedule(msg.tasks);
        break;
      case 'confirm':
        showConfirm(msg);
        break;
      case 'choose_session':
        showChoose(msg);
        break;
      case 'rpc_result':
        pendingRpc.get(msg.id)?.resolve(msg.result);
        pendingRpc.delete(msg.id);
        break;
      case 'rpc_error':
        pendingRpc.get(msg.id)?.reject(new Error(msg.error));
        pendingRpc.delete(msg.id);
        break;
      default:
        break;
    }
  }

  function appendHtml(target, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    target.appendChild(tpl.content.firstChild);
    scrollDown();
  }

  /** Реплики и результаты — в перерисовываемую часть (state их заменяет). */
  function addMsg(html) { appendHtml(msgsEl, html); }

  /** Журнал: уведомления ядра и отчёты команд — переживают очередной state. */
  function addFeed(html) { appendHtml(feedEl, html); }

  /** Заголовок без реплики на момент следующего события — закрываем тихо. */
  function closeStreaming() {
    if (currentMsg) {
      if (!currentMsg.text) currentMsg.el.remove();
      currentMsg.open = false;
      currentMsg = null;
    }
  }

  function clearMsgs() {
    closeStreaming();
    msgsEl.innerHTML = '';
  }

  // ── вопросы человеку ─────────────────────────────────────────
  function showConfirm(msg) {
    const who = msg.who ?? {};
    confirmTextEl.innerHTML =
      `<b style="color:${colorOf(who.color)}">${esc(who.emoji ?? '🤖')} ${esc(who.name ?? '')}</b>` +
      ` ${tr('просит разрешение:')} ${esc(msg.label)}`;
    confirmDescEl.textContent = msg.desc ?? '';
    confirmEl.classList.remove('hidden');
    confirmEl.dataset.id = msg.id;
    scrollDown();
  }

  function answerConfirm(approved) {
    send({ type: 'confirm_response', id: confirmEl.dataset.id, approved });
    confirmEl.classList.add('hidden');
  }

  function showChoose(msg) {
    chooseListEl.innerHTML = '';
    msg.items.forEach((it, i) => {
      const li = document.createElement('li');
      li.innerHTML = `${i + 1}. ${esc(it.title)} <span class="dim">— ${it.count} ${tr('сообщ.')}</span>`;
      li.onclick = () => {
        send({ type: 'choose_response', id: msg.id, index: i });
        chooseEl.classList.add('hidden');
      };
      chooseListEl.appendChild(li);
    });
    chooseEl.classList.remove('hidden');
    chooseEl.dataset.id = msg.id;
  }

  function hidePrompts() {
    confirmEl.classList.add('hidden');
    chooseEl.classList.add('hidden');
  }

  // ── рендер состояния ─────────────────────────────────────────
  function renderAll() {
    if (!state) return;
    renderSidebar();
    renderTeam();
    renderModels();
    renderProjects(state.projects);
    renderAuto();
    renderTopbar();
    clearMsgs();
    renderHistory(state.session.messages);
  }

  function renderTopbar() {
    const def = state.models.find((p) => p.isDefault);
    const badgeUser = $('badge-user');
    const badgeMgr = $('badge-manager');
    const who = state.profile?.name;
    if (who) {
      badgeUser.innerHTML = `👤 ${esc(who)}`;
      badgeUser.title = `${who}${state.profile?.role ? ` · ${state.profile.role}` : ''} — ${tr('клик: настройки')}`;
    }
    if (state.manager?.name) {
      badgeMgr.innerHTML = `${esc(state.manager.emoji ?? '🛎')} ${esc(state.manager.name)}`;
      badgeMgr.title = `${state.manager.name} (${state.manager.model ?? ""}) — ${tr('клик: настройки менеджера')}`;
    }
    if (def) {
      document.title = `Dream Team — ${def.id}`;
    }
  }

  function renderSidebar() {
    sessionsEl.innerHTML = '';
    (state.sessions ?? []).forEach((s, i) => {
      const li = document.createElement('li');
      const active = state.session && s.id === state.session.id;
      if (active) li.className = 'active';
      const created = new Date(s.createdAt).toLocaleString('ru-RU');
      const updated = new Date(s.updatedAt).toLocaleString('ru-RU');
      li.title = `${s.title}\nid: ${s.id}\n${tr('сообщений:')} ${s.count}\n${tr('создан:')} ${created}\n${tr('последнее сообщение:')} ${updated}`;
      li.innerHTML =
        `<div class="content">` +
        `<div class="sess-main"><span>${esc(s.title)}</span></div>` +
        `<div class="sub">${tr('создан')} ${esc(created)}</div>` +
        `<div class="sub">${tr('последнее')} ${esc(updated)}</div>` +
        `</div>` +
        (active ? '' : `<span class="del" title="${esc(tr('Удалить разговор'))}">✕</span>`);
      li.onclick = (e) => {
        if (e.target.classList.contains('del')) {
          e.stopPropagation();
          if (!roundActive) deleteSession(i + 1, s.title);
          return;
        }
        if (!roundActive) rpc('session.open', { n: i + 1 }).catch(() => {});
      };
      li.oncontextmenu = (e) => openCtx(e, [
        {
          label: tr('Переименовать'),
          fn: () => {
            if (roundActive) return;
            openForm(tr('Переименовать «{name}»', { name: s.title }), [
              { key: 'name', label: tr('Новое имя (пусто — менеджер придумает)'), value: s.title },
            ], (v) => {
              rpc('session.open', { n: i + 1 })
                .then(() => rpc('session.rename', { name: v.name }))
                .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
                .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
            });
          },
        },
        { label: tr('Удалить'), fn: () => { if (!roundActive) deleteSession(i + 1, s.title); } },
      ]);
      sessionsEl.appendChild(li);
    });
  }

  function deleteSession(n, title) {
    askDelete(tr('разговор «{title}»', { title }), () => {
      rpc('session.delete', { n })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  function renderTeam() {
    teamEl.innerHTML = '';

    // битый agents.json: ошибка вместо молчаливой пустой команды
    if (state?.teamError) {
      const err = document.createElement('li');
      err.className = 'errline';
      err.textContent = `agents.json: ${state.teamError}`;
      teamEl.appendChild(err);
    }

    for (const a of state.team ?? []) {
      const li = document.createElement('li');
      li.title = `${a.inChat ? tr('Вывести из чата') : tr('Позвать в чат')} · ${tr('правая кнопка — изменить/удалить')}`;
      li.innerHTML =
        `<div class="content">` +
        `<div class="sess-main"><span>${esc(a.emoji)} ${esc(a.name)}</span>` +
        `<span class="tag ${a.inChat ? 'in' : ''}">${a.inChat ? tr('в чате') : `＋ ${tr('чат')}`}</span></div>` +
        `<div class="sub">${esc(a.role ?? '')}</div>` +
        `</div>` +
        `<span class="del" title="${esc(tr('Удалить агента'))}">✕</span>`;
      li.onclick = () => {
        if (roundActive) return;
        const method = a.inChat ? 'chat.remove' : 'chat.add';
        // событие чата придёт репликой менеджера в ленте (со state) — журнал не дублируем
        rpc(method, { name: a.name })
          .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
      };
      li.querySelector('.del').onclick = (e) => {
        e.stopPropagation();
        if (!roundActive) agentDelete(a);
      };
      li.oncontextmenu = (e) => openCtx(e, [
        { label: tr('Изменить'), fn: () => openAgentSettings(a) },
        { label: tr('Удалить'), fn: () => { if (!roundActive) agentDelete(a); } },
      ]);
      teamEl.appendChild(li);
    }
  }

  function renderModels() {
    modelsEl.innerHTML = '';
    for (const p of state.models ?? []) {
      const li = document.createElement('li');
      li.title = (p.isDefault ? tr('Модель по умолчанию') : tr('Сделать основной (для агентов)'))
        + (p.isDefault ? '' : ` · ${tr('клик — сделать основным')} · ${tr('правая кнопка — изменить/удалить')}`);
      li.innerHTML =
        `<div class="content">` +
        `<div class="sess-main"><span>${p.ok ? '●' : '○'} ${esc(p.id)}</span>` +
        (p.isDefault ? `<span class="tag in">${tr('основная')}</span>` : '') + `</div>` +
        `<div class="sub">${esc(p.model ?? p.kind ?? '')}${p.ok ? '' : ` · ${esc(p.note ?? '')}`}</div>` +
        `</div>` +
        (p.isDefault ? '' : `<span class="del" title="${esc(tr('Удалить модель'))}">✕</span>`);
      if (!p.ok) li.title += ` · ${tr('проблема:')} ${p.note ?? ''}`;
      li.onclick = () => {
        if (roundActive || p.isDefault) return;
        rpc('model.set', { id: p.id })
          .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
      };
      li.oncontextmenu = (e) => {
        const items = [{ label: tr('Изменить'), fn: () => openModelSettings(p) }];
        if (!p.isDefault) items.push({ label: tr('Удалить'), fn: () => { if (!roundActive) modelDelete(p); } });
        openCtx(e, items);
      };
      const del = li.querySelector('.del');
      if (del) del.onclick = (e) => {
        e.stopPropagation();
        if (!roundActive) modelDelete(p);
      };
      modelsEl.appendChild(li);
    }
  }

  function openModelSettings(p) {
    openForm(tr('Модель {id}', { id: p.id }), [
      { key: 'adapter', label: tr('Адаптер (openai-compatible / anthropic / gigachat / mock)'), value: p.kind },
      { key: 'model', label: tr('Модель'), value: p.model ?? '' },
      { key: 'baseUrl', label: tr('baseUrl (пусто — не менять)'), value: p.baseUrl ?? '' },
      { key: 'apiKey', label: tr('Ключ API (пусто — не менять)'), value: '' },
    ], (v) => {
      const fields = {};
      for (const [k, val] of Object.entries(v)) if (val !== '') fields[k] = val;
      rpc('model.update', { id: p.id, fields })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  function renderProjects(projects) {
    projectsEl.innerHTML = '';

    for (const p of projects ?? []) {
      for (const h of p.hosts ?? []) {
        const li = document.createElement('li');
        li.title = `${tr('✕ — удалить сервер')} · ${tr('＋ — добавить сервер')} · ${tr('правая кнопка — удалить сервер')}`;
        li.oncontextmenu = (e) => openCtx(e, [
          { label: tr('Удалить сервер'), fn: () => { if (!roundActive) projectHostDelete(p, h); } },
        ]);
        li.innerHTML =
          `<span>${esc(p.id)}</span><span class="meta">${esc(h.name)}: ${esc(h.host)}</span>` +
          `<span class="del" title="${esc(tr('Добавить сервер в проект'))}">＋</span>` +
          `<span class="del" title="${esc(tr('Удалить сервер'))}">✕</span>`;
        const btns = li.querySelectorAll('.del');
        btns[0].onclick = (e) => {
          e.stopPropagation();
          if (roundActive) return;
          openForm(tr('Сервер проекта «{id}»', { id: p.id }), [
            { key: 'hostName', label: tr('Имя сервера (напр. prod)') },
            { key: 'host', label: tr('Хост (адрес)') },
            { key: 'user', label: tr('Пользователь (можно пропустить)') },
            { key: 'port', label: tr('Порт (можно пропустить)') },
          ], (v) => rpc('project.host.add', { id: p.id, ...v })
            .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
            .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`)));
        };
        btns[1].onclick = (e) => {
          e.stopPropagation();
          if (!roundActive) projectHostDelete(p, h);
        };
        projectsEl.appendChild(li);
      }
    }
  }

  function colorByAuthor(m) {
    if (m.authorId === 'manager') return colorOf(state.manager?.color);
    const a = (state.team ?? []).find((x) => x.id === m.authorId);
    return colorOf(a?.color);
  }

  function renderHistory(messages) {
    for (const m of messages ?? []) {
      if (m.authorId === 'user') {
        addMsg(`<div class="msg user"><div class="head">👤 ${esc(m.authorName)}` +
          `</div><div class="txt">${formatText(m.text)}</div></div>`);
      } else if (m.authorId === 'tool') {
        addMsg(`<div class="toolblock">${esc(m.text)}</div>`);
      } else if (m.authorId === 'session-ref') {
        addMsg(`<div class="attachment"><b>📎 ${esc(m.authorName)}</b>` +
          `<div class="digest">${esc(m.text)}</div></div>`);
      } else {
        addMsg(`<div class="msg"><div class="head" style="color:${colorByAuthor(m)}">` +
          `${esc(m.authorName)}</div><div class="txt">${formatText(m.text)}</div></div>`);
      }
    }
    scrollDown();
  }

  // ── автодополнение: @-попап и /-подсказки в одной панели ─────
  // Данные — из state: команды (completion.commands), разговоры, команда,
  // состав чата (inChat), провайдеры, имя менеджера.
  let hintState = null; // {kind:'at'|'cmd'|'arg', items:[{label,hint,insert}], sel, from}

  function completionData() {
    if (!state) return null;
    return {
      operations: state.completion?.operations ?? [],
      sessions: state.sessions ?? [],
      team: state.team ?? [],
      modelIds: (state.models ?? []).map((p) => p.id),
      managerName: state.manager?.name ?? tr('Менеджер'),
    };
  }

  function mentionItems() {
    const d = completionData();
    if (!d) return [];
    return [
      { label: d.managerName, hint: tr('менеджер переговорки'), insert: d.managerName + ' ' },
      ...d.team.filter((a) => a.inChat)
        .map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
      { label: 'session', hint: tr('конспект другого разговора'), insert: 'session ' },
    ];
  }

  /** Варианты аргументов после `/команда `; null — команда без подсказок. */
  function argItems(cmdName, d) {
    const parts = cmdName.slice(1).toLowerCase().split(/\s+/).filter(Boolean);
    const group = parts[0] || '';
    const ops = d.operations || [];
    const verbs = [...new Set(ops.filter((o) => o.cmd.startsWith('/' + group + ' ')).map((o) => o.cmd.split(' ')[1]).filter(Boolean))];
    const implicit = ops.find((o) => o.cmd === '/' + group);
    if (parts.length === 1) {
      if (implicit && verbs.length === 0) return argHintItems(implicit, 0, d);
      return verbs.map((v) => ({ label: v, hint: '', insert: v + ' ' }));
    }
    const verb = parts[1] || '';
    const op = ops.find((o) => o.cmd === '/' + group + ' ' + verb) || implicit;
    if (!op) return null;
    const typed = Math.max(0, parts.length - 1 - (verb && !implicit ? 1 : 0));
    return argHintItems(op, typed, d);
  }

  /** Значения аргумента по подсказке манифеста: номера, имена, id, shared. */
  function argHintItems(op, argPos, d) {
    const argTokens = (op.args || '').split(' ');
    const m = /\[([^\]]+)\]/.exec(argTokens[Math.min(argPos, argTokens.length - 1)] || '');
    const argName = m ? m[1] : '';
    if (argName === 'номер' && op.cmd.includes('session')) {
      return d.sessions.map((s, i) => ({ label: String(i + 1), hint: s.title, insert: (i + 1) + ' ' }));
    }
    if (argName === 'номер' || argName === 'имя|номер') {
      return [
        ...d.team.map((a, i) => ({ label: String(i + 1), hint: a.name, insert: (i + 1) + ' ' })),
        ...d.team.map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
      ];
    }
    if (argName === 'кого|shared') {
      return [
        ...d.team.map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
        { label: 'shared', hint: tr('общая память'), insert: 'shared ' },
      ];
    }
    if (argName === 'id' && op.cmd.startsWith('/model')) {
      return d.modelIds.map((id) => ({ label: id, hint: '', insert: id + ' ' }));
    }
    if (argName === 'тул') {
      return ['files', 'shell', 'ssh', 'look', 'image'].map((t) => ({ label: t, hint: '', insert: t + ' ' }));
    }
    return null;
  }

  function updateHints() {
    const pos = inputEl.selectionStart ?? inputEl.value.length;
    const before = inputEl.value.slice(0, pos);
    const d = completionData();
    if (!d) { hideHints(); return; }

    // @/№ — попап упоминаний (менеджер, участники чата, session)
    const at = /(?:^|\s)([@№])([^\s@№]*)$/.exec(before);
    if (at) {
      const items = mentionItems().filter((it) => norm(it.label).startsWith(norm(at[2])));
      if (items.length > 0) {
        hintState = {
          kind: 'at', items, sel: 0,
          from: pos - at[1].length - at[2].length,
          insertSuffix: ' ',
          prefix: at[1],
        };
        renderHints();
        return;
      }
      hideHints();
      return;
    }

    // /… — команды и их аргументы
    if (before.startsWith('/')) {
      const sp = before.indexOf(' ');
      if (sp === -1) {
        const frag = before.slice(1);
        const items = d.commands
          .filter((c) => norm(c.cmd).startsWith(norm('/' + frag)))
          .map((c) => ({
            label: c.cmd + (c.args ? ' ' + c.args : ''),
            hint: c.help,
            insert: c.cmd.slice(1) + ' ',
          }));
        if (items.length > 0) {
          hintState = { kind: 'cmd', items, sel: 0, from: 1, insertSuffix: '', prefix: '/' };
          renderHints();
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
            hintState = { kind: 'arg', items, sel: 0, from: pos - last.length, insertSuffix: '', prefix: '' };
            renderHints();
            return;
          }
        }
      }
      hideHints();
      return;
    }

    hideHints();
  }

  function renderHints() {
    const st = hintState;
    if (!st) return;
    hintsEl.innerHTML = '';
    st.items.forEach((it, i) => {
      const div = document.createElement('div');
      div.className = 'row' + (i === st.sel ? ' sel' : '');
      if (st.kind === 'at') {
        div.innerHTML = `<b>${esc(st.prefix + it.label)}</b>` +
          (it.hint ? ` <span class="dim">— ${esc(it.hint)}</span>` : '');
      } else {
        const firstSpace = it.label.indexOf(' ');
        const head = firstSpace === -1 ? it.label : it.label.slice(0, firstSpace);
        const tail = firstSpace === -1 ? '' : it.label.slice(firstSpace);
        div.innerHTML = `<span class="cmd">${esc(head)}</span>${esc(tail)}` +
          (it.hint ? `  <span class="dim">— ${esc(it.hint)}</span>` : '');
      }
      div.onclick = () => { applyHintItem(it); inputEl.focus(); };
      hintsEl.appendChild(div);
    });
    hintsEl.classList.remove('hidden');
  }

  function hideHints() {
    hintState = null;
    hintsEl.classList.add('hidden');
    hintsEl.innerHTML = '';
  }

  function applyHintItem(it) {
    const st = hintState;
    if (!st) return;
    const pos = inputEl.selectionStart ?? inputEl.value.length;
    const text = st.kind === 'at' ? st.prefix + it.label + st.insertSuffix : it.insert;
    inputEl.value = inputEl.value.slice(0, st.from) + text + inputEl.value.slice(pos);
    const np = st.from + text.length;
    inputEl.setSelectionRange(np, np);
    hideHints();
    autosize();
    updateHints(); // после вставки может открыться следующий уровень
  }

  // ── статус раунда и ввод ─────────────────────────────────────
  function renderStatus() {
    const label = [...busyMap.values()].at(-1) ?? '';
    const show = roundActive || busyMap.size > 0;
    statusbarEl.classList.toggle('hidden', !show);
    btnAbort.classList.toggle('hidden', !roundActive);
    busyLabelEl.textContent = label || (roundActive ? tr('раунд идёт…') : '');
    btnSend.disabled = roundActive;
    renderAuto();
  }

  function sendUserMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    if (roundActive || !authed) return;
    inputEl.value = '';
    autosize();
    hideHints();
    roundActive = true;
    renderStatus();
    if (text.startsWith('/')) {
      // команда: исполняет ядро, отчёты придут notice-событиями в журнал
      send({ type: 'command', text });
    } else {
      addMsg(`<div class="msg user"><div class="head">👤 ${esc(state?.profile?.name ?? tr('Вы'))}` +
        `</div><div class="txt">${formatText(text)}</div></div>`);
      send({ type: 'user_message', text });
    }
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
  }

  // ── привязки ─────────────────────────────────────────────────
  btnSend.onclick = sendUserMessage;
  inputEl.addEventListener('keydown', (e) => {
    if (hintState) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        hintState.sel = (hintState.sel + 1) % hintState.items.length;
        renderHints();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        hintState.sel = (hintState.sel - 1 + hintState.items.length) % hintState.items.length;
        renderHints();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideHints();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && hintState.kind === 'at')) {
        e.preventDefault();
        applyHintItem(hintState.items[hintState.sel]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendUserMessage();
    }
  });
  inputEl.addEventListener('input', () => {
    autosize();
    updateHints();
  });
  inputEl.addEventListener('click', updateHints);
  btnAbort.onclick = () => send({ type: 'abort' });

  // ── секции: ＋ кнопки, сворачивание (localStorage) ────────────
  function secAdd(sec) {
    return document.querySelector(`.side-sec[data-sec='${sec}'] .sec-add`);
  }
  function secBtn(sec, title) {
    return document.querySelector(`.side-sec[data-sec='${sec}'] .sec-btns button[title*='${title}']`);
  }

  // клик по .side-head (кроме .sec-add) — свернуть/развернуть + localStorage
  const LS_KEY = 'dt-collapsed';
  const saved = localStorage.getItem(LS_KEY);
  if (saved !== null) {
    // есть сохранённое — применяем (иначе HTML-дефолты)
    const collapsed = new Set(JSON.parse(saved));
    document.querySelectorAll('.side-sec').forEach((sec) => {
      sec.classList.toggle('collapsed', collapsed.has(sec.dataset.sec));
    });
  }
  document.querySelectorAll('.side-sec .side-head').forEach((head) => {
    head.addEventListener('click', (e) => {
      if (e.target.closest('.sec-add')) return;
      const sec = head.closest('.side-sec');
      sec.classList.toggle('collapsed');
      const collapsed = [...document.querySelectorAll('.side-sec.collapsed')].map((s) => s.dataset.sec);
      localStorage.setItem(LS_KEY, JSON.stringify(collapsed));
    });
  });

  secAdd('sessions').onclick = () => {
    if (roundActive) return;
    roundActive = true;
    renderStatus();
    rpc('session.new', {}).catch((err) =>
      addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
  };
  secAdd('team').onclick = () => { if (!roundActive) openAgentCreate(); };
  secAdd('models').onclick = () => { if (!roundActive) modelCreate(); };
  function refreshSchedule() {
    rpc('schedule.list').then((r) => { state.scheduleTasks = r.tasks; renderSchedule(); }).catch(() => {});
  }
  secAdd('schedule').onclick = () => { if (!roundActive) { refreshSchedule(); openForm(tr('Задача по расписанию'), [
    { key: 'message', label: tr('Задание (уйдёт в чат)') },
    { key: 'intervalMinutes', label: tr('Каждые N минут'), value: '10' },
  ], (v) => {
    rpc('schedule.add', { message: v.message, intervalMinutes: Number(v.intervalMinutes) || 10 })
      .then(() => refreshSchedule())
      .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
  }); } };
  secAdd('projects').onclick = () => { if (!roundActive) projectAdd(); };

  const pickImportFile = (home) => {
    importFile.onchange = () => {
      const f = importFile.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result);
        let b64 = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
        }
        send({ type: home ? 'import_home' : 'import_session', dataB64: b64 });
        addFeed(`<div class="notice">· ${tr('Импорт {what} из {file}…', { what: home ? tr('настроек') : tr('разговора'), file: f.name })}</div>`);
      };
      reader.readAsArrayBuffer(f);
      importFile.value = '';
    };
    importFile.click();
  };
  $('badge-user').onclick = () => { if (!roundActive) openUserProfileForm(); };
  $('badge-manager').onclick = () => { if (!roundActive) openManagerForm(); };
  $('btn-settings-top').onclick = () => { if (!roundActive) openSettingsForm(); };
  btnExportHome.onclick = () => { if (!roundActive) send({ type: 'export_home' }); };
  $('btn-import-home').onclick = () => pickImportFile(true);
  btnExportSession.onclick = () => {
    const cur = (state?.sessions ?? []).findIndex((s) => state.session && s.id === state.session.id) + 1;
    if (cur > 0 && !roundActive) send({ type: 'export_session', n: cur });
  };
  btnImportHome.onclick = () => pickImportFile(true);
  btnImportSession.onclick = () => pickImportFile(false);
  btnAuto.onclick = () => { if (!roundActive) send({ type: 'command', text: engine_autoToggle() }); };
  function engine_autoToggle() { return state?.auto?.mode ? '/auto off' : '/auto on'; }
  btnAttach.onclick = () => attachFile.click();
  attachFile.onchange = () => {
    const f = attachFile.files[0];
    if (!f || roundActive) { attachFile.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let b64 = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
      }
      roundActive = true;
      renderStatus();
      send({ type: 'file', name: f.name, dataB64: b64, text: `посмотрите файл ${f.name}` });
      addFeed(`<div class="notice">· 📎 ${esc(f.name)} (${bytes.length} Б) — ${tr('отправлен команде')}</div>`);
    };
    reader.readAsArrayBuffer(f);
    attachFile.value = '';
  };
  btnLogout.onclick = () => {
    localStorage.removeItem('dt-token');
    location.reload();
  };
  authEnter.onclick = enterWithToken;
  authInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enterWithToken();
  });

  connect();
})();
