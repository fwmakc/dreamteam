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
  const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');

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
      li.innerHTML =
        `<span class="meta">№${i + 1}</span><span>${esc(s.title)}</span>` +
        `<span class="meta">${s.count}</span>` +
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
          .then((r) => addFeed(`<div class="notice">· ${esc(r.text)}</div>`))
          .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
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
          .catch((err) => addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
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
  }

  function sendUserMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    if (roundActive) return;
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
  $('btn-new').onclick = () => {
    if (roundActive) return;
    roundActive = true;
    renderStatus();
    rpc('session.new', {}).catch((err) =>
      addFeed(`<div class="errline">✗ ${esc(err.message)}</div>`));
  };
  $('confirm-yes').onclick = () => answerConfirm(true);
  $('confirm-no').onclick = () => answerConfirm(false);
  $('choose-cancel').onclick = () => {
    send({ type: 'choose_response', id: chooseEl.dataset.id, index: null });
    chooseEl.classList.add('hidden');
  };

  connect();
})();
