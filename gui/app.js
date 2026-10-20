/**
 * Dream Team — веб-оболочка (vanilla JS, без сборки).
 * Клиент протокола serve.ts: один WS на /ws, события рисуются в чат,
 * состояние приходит снапшотами (state) и перерисовывает всё целиком.
 */
'use strict';

(() => {
  // ── элементы ─────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const chatEl = $('chat');
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

  // ── состояние клиента ────────────────────────────────────────
  let ws = null;
  let state = null;            // последний снапшот от сервера
  let roundActive = false;     // между отправкой и ближайшим state
  let currentMsg = null;       // открытая реплика стрима {el, body, text, open}
  const busyMap = new Map();   // busy id → label
  const pendingRpc = new Map(); // rpc id → {resolve, reject}
  let rpcSeq = 0;
  let retryTimer = null;

  const COLORS = {
    black: '#9aa3af', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
    gray: '#7f8790',
  };
  const colorOf = (name) => COLORS[String(name ?? '').toLowerCase()] ?? '#d7dae0';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /** Текст реплики: ```блоки``` → <pre>, остальное — экранированный текст. */
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
        html += `<span class="txt">${esc(parts[i])}</span>`;
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
      case 'state':
        roundActive = false;
        state = msg.state;
        hidePrompts();
        renderAll();
        renderStatus();
        break;
      case 'session_opened':
        state = state ?? {};
        state.session = msg.session;
        clearLive();
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
        chatEl.appendChild(el);
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
          addLine(`<div class="msg"><div class="txt">${formatText(msg.text)}</div></div>`);
        }
        scrollDown();
        break;
      case 'notice':
        closeStreaming();
        addLine(`<div class="notice">· ${esc(msg.text)}</div>`);
        break;
      case 'error':
        closeStreaming();
        addLine(`<div class="errline">✗ ${esc(msg.text)}</div>`);
        break;
      case 'tool_results':
        closeStreaming();
        addLine(`<div class="toolblock">${msg.results.map((r) => `⚙ ${esc(r)}`).join('\n')}</div>`);
        break;
      case 'attachment':
        closeStreaming();
        addLine(`<div class="attachment"><b>📎 ${esc(msg.title)}</b>` +
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

  function addLine(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    chatEl.appendChild(tpl.content.firstChild);
    scrollDown();
  }

  /** Заголовок без реплики на момент следующего события — закрываем тихо. */
  function closeStreaming() {
    if (currentMsg) {
      if (!currentMsg.text) currentMsg.el.remove();
      currentMsg.open = false;
      currentMsg = null;
    }
  }

  function clearLive() {
    closeStreaming();
    chatEl.innerHTML = '';
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
    renderTopbar();
    clearLive();
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
      li.innerHTML =
        `<span class="meta">№${i + 1}</span><span>${esc(s.title)}</span>` +
        `<span class="meta">${s.count}</span>` +
        (active ? '' : '<span class="del" title="Удалить разговор">✕</span>');
      li.onclick = (e) => {
        if (e.target.classList.contains('del')) {
          e.stopPropagation();
          if (confirm(`Удалить разговор «${s.title}»? Действие необратимо.`)) {
            rpc('session.delete', { n: i + 1 })
              .then((r) => addLine(`<div class="notice">· ${esc(r.text)}</div>`))
              .catch((err) => addLine(`<div class="errline">✗ ${esc(err.message)}</div>`));
          }
          return;
        }
        if (!roundActive) rpc('session.open', { n: i + 1 }).catch(() => {});
      };
      sessionsEl.appendChild(li);
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
      li.title = a.inChat ? 'Вывести из чата' : 'Позвать в чат';
      li.innerHTML =
        `<span>${esc(a.emoji)} ${esc(a.name)}</span>` +
        `<span class="meta">${esc(a.role ?? '')}</span>` +
        `<span class="tag ${a.inChat ? 'in' : ''}">${a.inChat ? 'в чате' : '＋ чат'}</span>`;
      li.onclick = () => {
        if (roundActive) return;
        const method = a.inChat ? 'chat.remove' : 'chat.add';
        rpc(method, { name: a.name })
          .then((r) => addLine(`<div class="notice">· ${esc(r.text)}</div>`))
          .catch((err) => addLine(`<div class="errline">✗ ${esc(err.message)}</div>`));
      };
      teamEl.appendChild(li);
    }
  }

  function renderProviders() {
    providersEl.innerHTML = '';
    for (const p of state.providers ?? []) {
      const li = document.createElement('li');
      li.title = p.isDefault ? 'Провайдер по умолчанию' : 'Сделать основным (для агентов)';
      li.innerHTML =
        `<span>${p.ok ? '●' : '○'}</span><span>${esc(p.id)}</span>` +
        `<span class="meta">${esc(p.model ?? p.kind ?? '')}</span>` +
        (p.isManager ? '<span class="tag">менеджер</span>' : '') +
        (p.isDefault ? '<span class="tag in">основной</span>' : '');
      if (!p.ok) li.title += ` · проблема: ${p.note ?? ''}`;
      li.onclick = () => {
        if (roundActive || p.isDefault) return;
        rpc('provider.set', { id: p.id })
          .catch((err) => addLine(`<div class="errline">✗ ${esc(err.message)}</div>`));
      };
      providersEl.appendChild(li);
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
        addLine(`<div class="msg user"><div class="head">👤 ${esc(m.authorName)}` +
          `</div><div class="txt">${formatText(m.text)}</div></div>`);
      } else if (m.authorId === 'tool') {
        addLine(`<div class="toolblock">${esc(m.text)}</div>`);
      } else if (m.authorId === 'session-ref') {
        addLine(`<div class="attachment"><b>📎 ${esc(m.authorName)}</b>` +
          `<div class="digest">${esc(m.text)}</div></div>`);
      } else {
        addLine(`<div class="msg"><div class="head" style="color:${colorByAuthor(m)}">` +
          `${esc(m.authorName)}</div><div class="txt">${formatText(m.text)}</div></div>`);
      }
    }
    scrollDown();
  }

  // ── статус раунда и ввод ─────────────────────────────────────
  function renderStatus() {
    const label = [...busyMap.values()].at(-1) ?? '';
    const show = roundActive || busyMap.size > 0;
    statusbarEl.classList.toggle('hidden', !show);
    btnAbort.classList.toggle('hidden', !roundActive);
    busyLabelEl.textContent = label || (roundActive ? 'раунд идёт…' : '');
    btnSend.disabled = roundActive;
  }

  function sendUserMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    if (roundActive) return;
    inputEl.value = '';
    autosize();
    addLine(`<div class="msg user"><div class="head">👤 ${esc(state?.profile?.name ?? 'Вы')}` +
      `</div><div class="txt">${formatText(text)}</div></div>`);
    roundActive = true;
    renderStatus();
    send({ type: 'user_message', text });
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
  }

  // ── привязки ─────────────────────────────────────────────────
  btnSend.onclick = sendUserMessage;
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendUserMessage();
    }
  });
  inputEl.addEventListener('input', autosize);
  btnAbort.onclick = () => send({ type: 'abort' });
  $('btn-new').onclick = () => {
    if (roundActive) return;
    roundActive = true;
    renderStatus();
    rpc('session.new', {}).catch((err) =>
      addLine(`<div class="errline">✗ ${esc(err.message)}</div>`));
  };
  $('confirm-yes').onclick = () => answerConfirm(true);
  $('confirm-no').onclick = () => answerConfirm(false);
  $('choose-cancel').onclick = () => {
    send({ type: 'choose_response', id: chooseEl.dataset.id, index: null });
    chooseEl.classList.add('hidden');
  };

  connect();
})();
