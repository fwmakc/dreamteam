/**
 * Dream Team — веб-оболочка (vanilla JS, без сборки).
 * Клиент протокола serve.ts: один WS на /ws, события рисуются в чат,
 * состояние приходит снапшотами (state) и перерисовывает всё целиком.
 * Команды `/…` уходят типом command (ядро исполняет их так же, как терминал),
 * автодополнение — по словарю из state (completion.commands + панели).
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
  const providersEl = $('providers');
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
  const settingsListEl = $('settings-list');
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
      connEl.textContent = 'на связи';
      connEl.className = 'conn on';
      send({ type: 'hello' });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      dispatch(msg);
    };
    ws.onclose = () => {
      connEl.textContent = 'отключено — переподключаюсь…';
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

  // ── агенты: создать/удалить/настроить ─────────────────────────
  function openAgentCreate() {
    openForm('Новый агент', [
      { key: 'id', label: 'id (латиница, цифры, -/_)' },
      { key: 'name', label: 'Имя' },
      { key: 'role', label: 'Роль (можно пропустить)' },
    ], (v) => {
      rpc('agent_create', v)
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }
  function openAgentSettings(a) {
    openForm(`Настройки агента ${a.name}`, [
      { key: 'role', label: 'Роль', value: a.role ?? '' },
      { key: 'provider', label: 'Провайдер', value: a.provider ?? '' },
      { key: 'temperature', label: 'Температура (0–2)', value: a.temperature ?? '' },
      { key: 'prompt', label: 'Промпт', value: a.prompt ?? '' },
    ], (v) => {
      const fields = {};
      for (const [k, val] of Object.entries(v)) if (val !== '') fields[k] = k === 'temperature' ? Number(val) : val;
      rpc('agent_update', { id: a.id, fields })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }
  function agentDelete(a) {
    if (confirm(`Удалить агента ${a.name}? История останется, но он исчезнет из команды.`)) {
      rpc('agent_delete', { id: a.id })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    }
  }

  // ── провайдеры: создать/удалить ───────────────────────────────
  function providerCreate() {
    openForm('Новый провайдер', [
      { key: 'id', label: 'id (латиница)' },
      { key: 'adapter', label: 'Адаптер (openai-compatible / anthropic / gigachat)', value: 'openai-compatible' },
      { key: 'baseUrl', label: 'baseUrl' },
      { key: 'model', label: 'Модель' },
      { key: 'apiKeyEnv', label: 'Имя переменной с ключом' },
    ], (v) => {
      rpc('provider_create', { id: v.id, config: v })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }
  function providerDelete(p) {
    if (p.isDefault) return;
    if (confirm(`Удалить провайдера ${p.id}?`)) {
      rpc('provider_delete', { id: p.id })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    }
  }

  // ── расписание: список задач, добавить/удалить/вкл-выкл ───────
  function renderSchedule(tasks) {
    scheduleListEl.innerHTML = '';
    const addLi = document.createElement('li');
    addLi.innerHTML = '<span class="tag">＋ задача</span>';
    addLi.onclick = () => openForm('Задача по расписанию', [
      { key: 'message', label: 'Задание (уйдёт в чат как сообщение)' },
      { key: 'intervalMinutes', label: 'Каждые N минут', value: '10' },
    ], (v) => {
      rpc('schedule_add', { message: v.message, intervalMinutes: Number(v.intervalMinutes) || 10 })
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
    scheduleListEl.appendChild(addLi);

    for (const t of tasks ?? []) {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="tag ${t.enabled ? 'in' : ''}">${t.enabled ? '▶' : '⏸'}</span>` +
        `<span class="meta">${t.intervalMinutes} мин</span>` +
        `<span>${esc(t.message.slice(0, 40))}</span>` +
        '<span class="del" title="Удалить задачу">✕</span>';
      li.title = `${t.message} — каждые ${t.intervalMinutes} мин`;
      li.querySelector('.del').onclick = (e) => {
        e.stopPropagation();
        rpc('schedule_delete', { id: t.id })
          .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
      };
      li.onclick = () => rpc('schedule_toggle', { id: t.id });
      scheduleListEl.appendChild(li);
    }
  }

  // ── авто-режим: тоггл (кнопка шлёт /auto через command) ───────
  function renderAuto() {
    const auto = state?.auto;
    const on = Boolean(auto?.mode);
    btnAuto.textContent = on ? `🤖 Авто (${auto?.left ?? 0})` : '🤖 Авто';
    btnAuto.classList.toggle('in', on);
    btnAuto.title = on
      ? `Автономный режим вкл (осталось ${auto?.left ?? 0} ходов). Клик — выключить.`
      : 'Автономный режим: агенты решают вопросы сами. Клик — включить.';
  }

  // ── настройки: форма правки ──────────────────────────────────
  function openSettingsForm() {
    const st = state.settings;
    if (!st) return;
    openForm('Настройки', [
      { key: 'language', label: 'Язык общения (russian / ru-RU / english…)', value: st.language ?? '' },
      { key: 'autoMessage', label: 'Автоответ в автономном режиме', value: st.autoMessage ?? '' },
      { key: 'width', label: 'Ширина экрана (40–500)', value: st.width ?? '' },
    ], (v) => {
      const patch = {};
      for (const [k, val] of Object.entries(v)) if (val !== '') patch[k] = k === 'width' ? Number(val) : val;
      rpc('settings_set', { patch })
        .then(() => addFeed('<div class="notice">· настройки сохранены</div>'))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  // ── менеджер: форма правки ───────────────────────────────────
  function openManagerForm() {
    const mgr = state.manager;
    if (!mgr) return;
    openForm('Менеджер переговорки', [
      { key: 'name', label: 'Имя', value: mgr.name ?? '' },
      { key: 'emoji', label: 'Эмодзи', value: mgr.emoji ?? '' },
      { key: 'color', label: 'Цвет (yellow/cyan/…)', value: mgr.color ?? '' },
      { key: 'temperature', label: 'Температура (0–2)', value: mgr.temperature ?? '' },
    ], (v) => {
      const fields = {};
      for (const [k, val] of Object.entries(v)) if (val !== '') fields[k] = k === 'temperature' ? Number(val) : val;
      rpc('manager_set', { fields })
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }

  // ── проекты: добавить сервер/удалить ──────────────────────────
  function projectAdd() {
    openForm('Новый проект', [
      { key: 'id', label: 'id проекта (латиница)' },
      { key: 'hostName', label: 'Имя сервера (напр. prod)' },
      { key: 'host', label: 'Хост (адрес)' },
      { key: 'user', label: 'Пользователь (можно пропустить)' },
      { key: 'port', label: 'Порт (можно пропустить)' },
    ], (v) => {
      rpc('project_add', v)
        .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
        .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
    });
  }
  function projectHostDelete(p, h) {
    rpc('project_host_delete', { id: p.id, name: h.name })
      .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
      .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
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
        addFeed(`<div class="notice">· Экспорт готов: ${esc(msg.name)}</div>`);
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
        showAuthForm('Неверный токен — попробуйте ещё раз.');
        break;
      case 'state':
        roundActive = false;
        state = msg.state;
        hidePrompts();
        authEl.classList.add('hidden');
        renderAll();
        renderStatus();
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
        renderSettingsList();
        break;
      case 'manager':
        state = state ?? {};
        state.manager = msg.manager;
        renderSettingsList();
        break;
      case 'schedule':
        renderSchedule(msg.tasks);
        break;
      case 'confirm':
        state = state ?? {};
        state.settings = msg.settings;
        renderSettingsList();
        break;
      case 'manager':
        state = state ?? {};
        state.manager = msg.manager;
        renderSettingsList();
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
      ` просит разрешение: ${esc(msg.label)}`;
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
      li.innerHTML = `${i + 1}. ${esc(it.title)} <span class="dim">— ${it.count} сообщ.</span>`;
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
    renderProviders();
    renderSettingsList();
    renderProjects(state.projects);
    renderAuto();
    renderTopbar();
    clearMsgs();
    renderHistory(state.session.messages);
  }

  function renderTopbar() {
    const def = state.providers.find((p) => p.isDefault);
    const badge = $('profile-badge');
    const who = state.profile?.name;
    if (who) {
      badge.textContent = `👤 ${who}${state.profile.role ? ` · ${state.profile.role}` : ''}`;
      badge.classList.remove('hidden');
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
      li.title = `${s.title}
id: ${s.id}
создан: ${created}
последнее сообщение: ${updated}`;
      li.innerHTML =
        `<div class="sess-main"><span>${esc(s.title)}</span>` +
        `<span class="meta">${s.count} сообщ.</span></div>` +
        `<div class="sub">№${i + 1} · ${esc(updated)}</div>` +
        (active ? '' : '<span class="del" title="Удалить разговор">✕</span>');
      li.onclick = (e) => {
        if (e.target.classList.contains('del')) {
          e.stopPropagation();
          if (confirm(`Удалить разговор «${s.title}»? Действие необратимо.`)) {
            rpc('session.delete', { n: i + 1 })
              .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
              .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
          }
          return;
        }
        if (!roundActive) rpc('session.open', { n: i + 1 }).catch(() => {});
      };
      sessionsEl.appendChild(li);
    });
  }

  /** Разделяет одиночный и двойной клик: одиночный срабатывает через 250 мс. */
  function onCliDbl(el, singleFn, dblFn) {
    let timer = null;
    el.addEventListener('click', () => {
      if (timer) { clearTimeout(timer); timer = null; return; }
      timer = setTimeout(() => { timer = null; singleFn(); }, 250);
    });
    el.addEventListener('dblclick', () => {
      if (timer) { clearTimeout(timer); timer = null; }
      dblFn();
    });
  }

  function renderTeam() {
    teamEl.innerHTML = '';
    const mgr = state.manager;
    const mgrLi = document.createElement('li');
    mgrLi.className = 'static';
    mgrLi.innerHTML =
      `<span>${esc(mgr.emoji)} ${esc(mgr.name)}</span>` +
      `<span class="tag">консьерж</span><span class="meta">${esc(mgr.provider)}</span>`;
    teamEl.appendChild(mgrLi);

    for (const a of state.team ?? []) {
      const li = document.createElement('li');
      li.title = `${a.inChat ? 'Вывести из чата' : 'Позвать в чат'} · двойной клик — настройки`;
      li.innerHTML =
        `<span>${esc(a.emoji)} ${esc(a.name)}</span>` +
        `<span class="meta">${esc(a.role ?? '')}</span>` +
        `<span class="tag ${a.inChat ? 'in' : ''}">${a.inChat ? 'в чате' : '＋ чат'}</span>` +
        '<span class="del" title="Удалить агента">✕</span>';
      li.onclick = () => {
        if (roundActive) return;
        const method = a.inChat ? 'chat.remove' : 'chat.add';
        rpc(method, { name: a.name })
          .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
          .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
      };
      li.querySelector('.del').onclick = (e) => {
        e.stopPropagation();
        if (!roundActive) agentDelete(a);
      };
      onCliDbl(li,
        () => {
          if (roundActive) return;
          const method = a.inChat ? 'chat.remove' : 'chat.add';
          rpc(method, { name: a.name })
            .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
            .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
        },
        () => openAgentSettings(a),
      );
      teamEl.appendChild(li);
    }
  }

  function renderProviders() {
    providersEl.innerHTML = '';
    for (const p of state.providers ?? []) {
      const li = document.createElement('li');
      li.title = (p.isDefault ? 'Провайдер по умолчанию' : 'Сделать основным (для агентов)')
        + (p.isDefault ? '' : ' · двойной клик — настройки');
      li.innerHTML =
        `<span>${p.ok ? '●' : '○'}</span><span>${esc(p.id)}</span>` +
        `<span class="meta">${esc(p.model ?? p.kind ?? '')}</span>` +
        (p.isManager ? '<span class="tag">менеджер</span>' : '') +
        (p.isDefault ? '<span class="tag in">основной</span>' : '') +
        (p.isDefault ? '' : '<span class="del" title="Удалить провайдера">✕</span>');
      if (!p.ok) li.title += ` · проблема: ${p.note ?? ''}`;
      onCliDbl(li,
        () => {
          if (roundActive || p.isDefault) return;
          rpc('provider.set', { id: p.id })
            .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
        },
        () => { if (!p.isDefault) openProviderSettings(p); },
      );
      const del = li.querySelector('.del');
      if (del) del.onclick = (e) => {
        e.stopPropagation();
        if (!roundActive) providerDelete(p);
      };
      providersEl.appendChild(li);
    }
  }

  function openProviderSettings(p) {
    openForm(`Провайдер ${p.id}`, [
      { key: 'baseUrl', label: 'baseUrl', value: '' },
      { key: 'model', label: 'Модель', value: p.model ?? '' },
      { key: 'apiKeyEnv', label: 'Имя переменной с ключом' },
    ], (v) => {
      addFeed(`<div class="notice">· правка провайдеров пока через ~/.dreamteam/providers.json</div>`);
    });
  }

  function renderSettingsList() {
    settingsListEl.innerHTML = '';
    const st = state.settings;
    if (!st) return;
    for (const [k, v] of [['Язык', st.language], ['Ширина', st.width], ['Автоответ', st.autoMessage]]) {
      const li = document.createElement('li');
      li.className = 'static';
      li.innerHTML = `<span class="meta">${k}:</span> <span>${esc(String(v ?? '—'))}</span>`;
      settingsListEl.appendChild(li);
    }
    const li = document.createElement('li');
    li.className = 'static';
    li.innerHTML = `<span>👤 ${esc(state.profile?.name ?? '—')}</span>` +
      `<span class="meta">${esc(state.profile?.role ?? '')}</span>`;
    settingsListEl.appendChild(li);
    const li2 = document.createElement('li');
    li2.className = 'static';
    li2.innerHTML = `<span>${esc(state.manager?.emoji ?? '🛎')} ${esc(state.manager?.name ?? '')}</span>` +
      `<span class="meta">менеджер</span>`;
    li2.title = 'Двойной клик — настройки менеджера';
    li2.ondblclick = () => openManagerForm();
    settingsListEl.appendChild(li2);
  }

  function renderProjects(projects) {
    projectsEl.innerHTML = '';

    for (const p of projects ?? []) {
      for (const h of p.hosts ?? []) {
        const li = document.createElement('li');
        li.title = 'Двойной клик — удалить проект целиком · ✕ — удалить сервер';
        li.innerHTML =
          `<span>${esc(p.id)}</span><span class="meta">${esc(h.name)}: ${esc(h.host)}</span>` +
          '<span class="del" title="Удалить сервер">✕</span>';
        li.querySelector('.del').onclick = (e) => {
          e.stopPropagation();
          if (!roundActive) projectHostDelete(p, h);
        };
        li.ondblclick = () => { if (!roundActive) rpc('project_delete', { id: p.id }); };
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
      commands: state.completion?.commands ?? [],
      sessions: state.sessions ?? [],
      team: state.team ?? [],
      providerIds: (state.providers ?? []).map((p) => p.id),
      managerName: state.manager?.name ?? 'Менеджер',
    };
  }

  function mentionItems() {
    const d = completionData();
    if (!d) return [];
    return [
      { label: d.managerName, hint: 'менеджер переговорки', insert: d.managerName + ' ' },
      ...d.team.filter((a) => a.inChat)
        .map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
      { label: 'session', hint: 'конспект другого разговора', insert: 'session ' },
    ];
  }

  /** Варианты аргументов после `/команда `; null — команда без подсказок. */
  function argItems(cmdName, d) {
    switch (norm(cmdName)) {
      case '/session':
      case '/delete':
        return d.sessions.map((s, i) => ({ label: String(i + 1), hint: s.title, insert: (i + 1) + ' ' }));
      case '/add':
      case '/out':
        return [
          ...d.team.map((a, i) => ({ label: String(i + 1), hint: a.name, insert: (i + 1) + ' ' })),
          ...d.team.map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
        ];
      case '/memory':
        return [
          ...d.team.map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' })),
          { label: 'shared', hint: 'общая память', insert: 'shared ' },
        ];
      case '/provider':
        return d.providerIds.map((id) => ({ label: id, hint: '', insert: id + ' ' }));
      case '/grant':
        return d.team.map((a) => ({ label: a.name, hint: a.role, insert: a.name + ' ' }));
      case '/agent':
        return [
          { label: 'add', hint: '<id> <Имя> [роль]', insert: 'add ' },
          { label: 'set', hint: '<id> поле=значение', insert: 'set ' },
        ];
      case '/project':
        return [
          { label: 'add', hint: '<id>; <имя>: хост', insert: 'add ' },
          { label: 'host', hint: '<проект> <имя>=<хост>', insert: 'host ' },
        ];
      default:
        return null;
    }
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
    busyLabelEl.textContent = label || (roundActive ? 'раунд идёт…' : '');
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
      addMsg(`<div class="msg user"><div class="head">👤 ${esc(state?.profile?.name ?? 'Вы')}` +
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
  secAdd('providers').onclick = () => { if (!roundActive) providerCreate(); };
  secAdd('schedule').onclick = () => { if (!roundActive) { send({ type: 'schedule_get' }); openForm('Задача по расписанию', [
    { key: 'message', label: 'Задание (уйдёт в чат)' },
    { key: 'intervalMinutes', label: 'Каждые N минут', value: '10' },
  ], (v) => {
    rpc('schedule_add', { message: v.message, intervalMinutes: Number(v.intervalMinutes) || 10 })
      .then(() => send({ type: 'schedule_get' }))
      .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
  }); } };
  secAdd('projects').onclick = () => { if (!roundActive) projectAdd(); };
  secAdd('settings').onclick = () => { if (!roundActive) openSettingsForm(); };

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
        addFeed(`<div class="notice">· Импорт ${home ? 'настроек' : 'разговора'} из ${esc(f.name)}…</div>`);
      };
      reader.readAsArrayBuffer(f);
      importFile.value = '';
    };
    importFile.click();
  };
  btnExportHome.onclick = () => { if (!roundActive) send({ type: 'export_home' }); };
  btnExportSession.onclick = () => {
    const cur = (state?.sessions ?? []).findIndex((s) => state.session && s.id === state.session.id) + 1;
    if (cur > 0 && !roundActive) send({ type: 'export_session', n: cur });
  };
  btnImportHome.onclick = () => pickImportFile(true);
  btnImportSession.onclick = () => pickImportFile(false);
  btnAuto.onclick = () => { if (!roundActive) send({ type: 'command', text: engine_autoToggle() }); };
  function engine_autoToggle() { return state?.auto?.mode ? '/auto off' : '/auto'; }
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
      addFeed(`<div class="notice">· 📎 ${esc(f.name)} (${bytes.length} Б) — отправлен команде</div>`);
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
