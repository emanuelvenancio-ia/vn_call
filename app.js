/**
 * VnCall Admin Panel — app.js
 * Pure HTML/CSS/JS using Firebase REST API + FCM HTTP v1 (via your server key)
 * No npm / bundler required — works by opening index.html directly in a browser
 * or hosting on any static server (Netlify, Firebase Hosting, GitHub Pages, etc.)
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
const STATE = {
  projectId:  '',
  webApiKey:  '',
  serverKey:  '',           // FCM Server Key (Legacy) or Bearer token for v1
  idToken:    '',           // Firebase Auth ID token (for Firestore REST)
  users:      [],
  selected:   new Set(),
  logs:       [],
  notifCount: 0,
};

// ── DOM helpers ────────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const qs = (sel) => document.querySelector(sel);
const afe = (el, cls) => el.classList.add(cls);
const rfe = (el, cls) => el.classList.remove(cls);

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initLoginFlow();
  initNotifyComposer();
  initUserSearch();
  restoreSession();
});

// ── Navigation ─────────────────────────────────────────────────────────────────
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      navigateTo(page);
    });
  });
}

function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(i => rfe(i, 'active'));
  document.querySelectorAll('.page').forEach(p => rfe(p, 'active'));
  const navItem = qs(`.nav-item[data-page="${page}"]`);
  const pageEl  = $(`page-${page}`);
  if (navItem) afe(navItem, 'active');
  if (pageEl)  afe(pageEl,  'active');

  // Lazy load data
  if (page === 'dashboard' && STATE.idToken) loadDashboard();
  if (page === 'users'     && STATE.idToken) loadUsers();
  if (page === 'logs')     renderLogs();
}

// ── Login / Auth ───────────────────────────────────────────────────────────────
function initLoginFlow() {
  $('btn-login').addEventListener('click', doLogin);
  $('btn-logout').addEventListener('click', doLogout);
  $('input-apikey').addEventListener('keydown',   e => e.key === 'Enter' && doLogin());
  $('input-projectid').addEventListener('keydown', e => e.key === 'Enter' && doLogin());
  $('input-webapikey').addEventListener('keydown', e => e.key === 'Enter' && doLogin());
}

function restoreSession() {
  const saved = localStorage.getItem('vncall_admin_session');
  if (!saved) return;
  try {
    const { projectId, webApiKey, serverKey } = JSON.parse(saved);
    if (projectId && serverKey) {
      STATE.projectId = projectId;
      STATE.webApiKey = webApiKey;
      STATE.serverKey = serverKey;
      showPanel();
      loadDashboard();
    }
  } catch (_) { localStorage.removeItem('vncall_admin_session'); }
}

async function doLogin() {
  const apiKey    = $('input-apikey').value.trim();
  const projectId = $('input-projectid').value.trim();
  const webApiKey = $('input-webapikey').value.trim();
  const errEl     = $('login-error');

  hideEl(errEl);

  if (!apiKey)    return showLoginErr('Introduza a API Key / Server Key');
  if (!projectId) return showLoginErr('Introduza o Project ID do Firebase');

  const btn = $('btn-login');
  btn.innerHTML = '<span class="spinner"></span> A verificar...';
  btn.disabled = true;

  try {
    // Validate by attempting a Firestore list (anonymous REST)
    // We use the server key directly for FCM; for Firestore we use the web api key
    // to create an anonymous token, or fall back to public read if rules allow
    STATE.projectId = projectId;
    STATE.webApiKey = webApiKey;
    STATE.serverKey = apiKey;

    // Try to get an anonymous Firebase Auth token for Firestore REST
    if (webApiKey) {
      try {
        const anonResp = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${webApiKey}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) }
        );
        if (anonResp.ok) {
          const anonData = await anonResp.json();
          STATE.idToken = anonData.idToken || '';
        }
      } catch (_) { /* anonymous sign-in optional */ }
    }

    // Quick test: try to read from Firestore
    const testUrl = firestoreUrl('usuarios', { pageSize: 1 });
    const resp = await fetch(testUrl, authHeaders());
    if (!resp.ok && resp.status !== 200) {
      const body = await resp.json().catch(() => ({}));
      // 403 = rules block anon, but connection worked → accept
      if (resp.status !== 403 && resp.status !== 401) {
        throw new Error(body?.error?.message || `HTTP ${resp.status}`);
      }
    }

    // Save session
    localStorage.setItem('vncall_admin_session', JSON.stringify({ projectId, webApiKey, serverKey: apiKey }));
    showPanel();
    loadDashboard();
  } catch (err) {
    showLoginErr(`Erro de autenticação: ${err.message}`);
    btn.innerHTML = 'Entrar no Painel';
    btn.disabled  = false;
  }
}

function showLoginErr(msg) {
  const el = $('login-error');
  el.textContent = msg;
  showEl(el);
}

function showPanel() {
  hideEl($('login-overlay'));
  setAuthStatus(true);
  showEl($('btn-logout'));
  // Populate fields with state values
  if ($('input-projectid').value === '') $('input-projectid').value = STATE.projectId;
}

function doLogout() {
  localStorage.removeItem('vncall_admin_session');
  STATE.projectId = '';
  STATE.serverKey = '';
  STATE.idToken   = '';
  STATE.users     = [];
  STATE.selected.clear();
  setAuthStatus(false);
  showEl($('login-overlay'));
  hideEl($('btn-logout'));
}

function setAuthStatus(connected) {
  const el = $('auth-status');
  el.className = `auth-status ${connected ? 'connected' : 'disconnected'}`;
  el.querySelector('.status-text').textContent = connected ? 'Conectado' : 'Desconectado';
}

// ── Firestore REST helpers ─────────────────────────────────────────────────────
function firestoreUrl(collection, params = {}) {
  const base = `https://firestore.googleapis.com/v1/projects/${STATE.projectId}/databases/(default)/documents/${collection}`;
  const q    = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  return q ? `${base}?${q}` : base;
}

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (STATE.idToken) h['Authorization'] = `Bearer ${STATE.idToken}`;
  return { headers: h };
}

// Parse Firestore document value
function fsVal(val) {
  if (!val) return null;
  if (val.stringValue  !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return parseInt(val.integerValue);
  if (val.doubleValue  !== undefined) return parseFloat(val.doubleValue);
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.timestampValue !== undefined) return new Date(val.timestampValue);
  if (val.nullValue    !== undefined) return null;
  if (val.arrayValue   !== undefined) return (val.arrayValue.values || []).map(fsVal);
  if (val.mapValue     !== undefined) {
    const obj = {};
    const fields = val.mapValue.fields || {};
    for (const k in fields) obj[k] = fsVal(fields[k]);
    return obj;
  }
  return null;
}

function fsDoc(doc) {
  const obj = { _id: doc.name?.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields || {})) {
    obj[k] = fsVal(v);
  }
  return obj;
}

async function fetchAllUsers() {
  const allUsers = [];
  let pageToken  = null;

  do {
    const params = { pageSize: 100 };
    if (pageToken) params.pageToken = pageToken;
    const resp = await fetch(firestoreUrl('usuarios', params), authHeaders());
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 401) break; // rules blocked — return empty
      throw new Error(`Firestore error: ${resp.status}`);
    }
    const data = await resp.json();
    if (data.documents) {
      allUsers.push(...data.documents.map(fsDoc));
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return allUsers;
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
async function loadDashboard() {
  $('stat-users').textContent    = '…';
  $('stat-online').textContent   = '…';
  $('stat-with-token').textContent = '…';
  $('stat-notifs-sent').textContent = STATE.notifCount;

  try {
    const users = await fetchAllUsers();
    STATE.users  = users;

    const online     = users.filter(u => u.online === true).length;
    const withToken  = users.filter(u => u.fcmToken && u.fcmToken !== '').length;

    $('stat-users').textContent     = users.length;
    $('stat-online').textContent    = online;
    $('stat-with-token').textContent = withToken;
    $('stat-notifs-sent').textContent = STATE.notifCount;

    // Recent users preview
    const container = $('recent-users-list');
    container.innerHTML = '';
    users.slice(0, 8).forEach(u => {
      const div = document.createElement('div');
      div.className = 'user-preview-item';
      div.innerHTML = `
        <div class="user-avatar">${userAvatarHtml(u)}</div>
        <div class="user-info-mini">
          <div class="name">${esc(u.nome || 'Sem nome')}</div>
          <div class="id">@${esc(u.idVcall || u._id)}</div>
        </div>
        <span class="${u.online ? 'tag-online' : 'tag-offline'}">${u.online ? 'Online' : 'Offline'}</span>
      `;
      container.appendChild(div);
    });

    if (users.length === 0) {
      container.innerHTML = `<div class="empty-state">Sem utilizadores encontrados. Verifique as regras do Firestore.</div>`;
    }
  } catch (err) {
    $('stat-users').textContent    = 'Erro';
    $('recent-users-list').innerHTML = `<div class="empty-state" style="color:#CC2200">${esc(err.message)}</div>`;
  }
}

// ── Users Page ─────────────────────────────────────────────────────────────────
async function loadUsers() {
  const tbody = $('users-table-body');
  tbody.innerHTML = `<tr><td colspan="7"><div class="loading-overlay-inner"><span class="spinner"></span> A carregar...</div></td></tr>`;

  try {
    if (STATE.users.length === 0) STATE.users = await fetchAllUsers();
    renderUsersTable(STATE.users);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell" style="color:#CC2200">Erro: ${esc(err.message)}</td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = $('users-table-body');
  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">Sem utilizadores. Verifique as regras do Firestore.</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  users.forEach(u => {
    const tr = document.createElement('tr');
    const hasToken = !!(u.fcmToken && u.fcmToken !== '');
    tr.innerHTML = `
      <td><div class="user-avatar" style="margin:auto 0">${userAvatarHtml(u)}</div></td>
      <td><strong>${esc(u.nome || '—')}</strong></td>
      <td><code>@${esc(u.idVcall || '—')}</code></td>
      <td>${esc(u.emailTecnico || u.emailSuporte || '—')}</td>
      <td><span class="${u.online ? 'tag-online' : 'tag-offline'}">${u.online ? '● Online' : 'Offline'}</span></td>
      <td><span class="${hasToken ? 'tag-token' : 'tag-no-token'}">${hasToken ? '✓ Token' : '✗ Sem token'}</span></td>
      <td>
        <button class="btn-icon-sm" title="Enviar notificação" onclick="sendToSingleUser('${esc(u._id)}', '${esc(u.nome || '')}', '${esc(u.fcmToken || '')}')">📨</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Search filter on users page
document.addEventListener('DOMContentLoaded', () => {
  const usersSearch = $('users-search');
  if (usersSearch) {
    usersSearch.addEventListener('input', () => {
      const q = usersSearch.value.toLowerCase();
      const filtered = STATE.users.filter(u =>
        (u.nome     || '').toLowerCase().includes(q) ||
        (u.idVcall  || '').toLowerCase().includes(q) ||
        (u.emailTecnico || '').toLowerCase().includes(q)
      );
      renderUsersTable(filtered);
    });
  }
});

function sendToSingleUser(uid, name, token) {
  if (!token) {
    alert(`${name} não tem token FCM registado.`);
    return;
  }
  navigateTo('notify');
  // Pre-select this user in the selector
  document.querySelector('input[name=target][value=selected]').checked = true;
  STATE.selected.clear();
  STATE.selected.add(uid);
  updateSelectedBadge();
  renderUserSelector(STATE.users);
}

// ── Notification Composer ──────────────────────────────────────────────────────
function initNotifyComposer() {
  // Target radio
  document.querySelectorAll('input[name=target]').forEach(r => {
    r.addEventListener('change', () => {
      const topicGroup = $('topic-group');
      if (r.value === 'topic') showEl(topicGroup);
      else hideEl(topicGroup);

      if ((r.value === 'selected') && STATE.users.length === 0) {
        loadUsersForSelector();
      }
    });
  });

  // Live preview
  $('input-title').addEventListener('input', updatePreview);
  $('input-body').addEventListener('input',  updatePreview);
  $('input-title').addEventListener('input', () => {
    $('title-count').textContent = `${$('input-title').value.length}/65`;
  });
  $('input-body').addEventListener('input', () => {
    $('body-count').textContent = `${$('input-body').value.length}/240`;
  });

  // User search inside notify panel
  $('user-search').addEventListener('input', () => {
    const q = $('user-search').value.toLowerCase();
    const filtered = STATE.users.filter(u =>
      (u.nome    || '').toLowerCase().includes(q) ||
      (u.idVcall || '').toLowerCase().includes(q)
    );
    renderUserSelector(filtered);
  });

  // Send button
  $('btn-send').addEventListener('click', doSendNotification);

  // Initial user load for selector
  if (STATE.users.length > 0) renderUserSelector(STATE.users);
}

function updatePreview() {
  const title = $('input-title').value || 'Título da notificação';
  const body  = $('input-body').value  || 'Mensagem da notificação aparece aqui...';
  $('preview-title').textContent = title;
  $('preview-body').textContent  = body;
}

async function loadUsersForSelector() {
  if (STATE.users.length > 0) { renderUserSelector(STATE.users); return; }
  if (!STATE.idToken && !STATE.serverKey) return;
  try {
    STATE.users = await fetchAllUsers();
    renderUserSelector(STATE.users);
  } catch (e) {
    $('user-selector-list').innerHTML = `<div class="empty-state" style="color:#CC2200">Erro: ${esc(e.message)}</div>`;
  }
}

function renderUserSelector(users) {
  const container = $('user-selector-list');
  if (users.length === 0) {
    container.innerHTML = '<div class="empty-state">Sem utilizadores</div>';
    return;
  }
  container.innerHTML = '';
  users.forEach(u => {
    const div = document.createElement('div');
    div.className = 'user-select-item';
    const checked = STATE.selected.has(u._id);
    const hasToken = !!(u.fcmToken && u.fcmToken !== '');
    div.innerHTML = `
      <input type="checkbox" ${checked ? 'checked' : ''} data-uid="${esc(u._id)}" ${!hasToken ? 'disabled title="Sem token FCM"' : ''} />
      <div class="user-avatar">${userAvatarHtml(u)}</div>
      <div class="user-info-mini">
        <div class="name">${esc(u.nome || u._id)}</div>
        <div class="id">@${esc(u.idVcall || '')} ${!hasToken ? '• sem token' : ''}</div>
      </div>
      ${u.online ? '<div class="online-dot" title="Online"></div>' : ''}
    `;
    const cb = div.querySelector('input[type=checkbox]');
    cb.addEventListener('change', () => {
      if (cb.checked) STATE.selected.add(u._id);
      else STATE.selected.delete(u._id);
      updateSelectedBadge();
    });
    container.appendChild(div);
  });
}

function updateSelectedBadge() {
  $('selected-count-badge').textContent = `${STATE.selected.size} sel.`;
}

function initUserSearch() {
  // Triggered from DOMContentLoaded indirectly via initNotifyComposer
}

// ── Send Notification ──────────────────────────────────────────────────────────
async function doSendNotification() {
  const title     = $('input-title').value.trim();
  const body      = $('input-body').value.trim();
  const type      = $('input-type').value;
  const priority  = $('input-priority').value;
  const imageUrl  = $('input-image').value.trim();
  const rawData   = $('input-data').value.trim();
  const targetVal = document.querySelector('input[name=target]:checked').value;
  const errEl     = $('send-error');
  const sucEl     = $('send-success');

  hideEl(errEl); hideEl(sucEl);

  if (!title)   return showEl(Object.assign(errEl, { textContent: 'O título é obrigatório.' }));
  if (!body)    return showEl(Object.assign(errEl, { textContent: 'A mensagem é obrigatória.' }));
  if (!STATE.serverKey) return showEl(Object.assign(errEl, { textContent: 'Sem Server Key configurada. Faça login primeiro.' }));

  // Parse extra data
  let extraData = {};
  if (rawData) {
    try { extraData = JSON.parse(rawData); }
    catch (_) { return showEl(Object.assign(errEl, { textContent: 'JSON inválido no campo de dados adicionais.' })); }
  }

  const btn = $('btn-send');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> A enviar...';

  try {
    let results = [];

    if (targetVal === 'all') {
      // Batch: send to all users with FCM tokens
      if (STATE.users.length === 0) STATE.users = await fetchAllUsers();
      const tokened = STATE.users.filter(u => u.fcmToken && u.fcmToken !== '');
      if (tokened.length === 0) throw new Error('Nenhum utilizador tem token FCM registado.');
      results = await sendBatch(tokened.map(u => u.fcmToken), title, body, type, priority, imageUrl, extraData);
      logEntry(`Enviado para todos (${tokened.length} tokens)`, title, body, type, results);

    } else if (targetVal === 'selected') {
      if (STATE.selected.size === 0) throw new Error('Seleccione pelo menos um utilizador.');
      const selUsers = STATE.users.filter(u => STATE.selected.has(u._id) && u.fcmToken);
      if (selUsers.length === 0) throw new Error('Nenhum dos utilizadores seleccionados tem token FCM.');
      results = await sendBatch(selUsers.map(u => u.fcmToken), title, body, type, priority, imageUrl, extraData);
      logEntry(`Enviado para ${selUsers.length} seleccionados`, title, body, type, results);

    } else if (targetVal === 'topic') {
      const topic = $('input-topic').value.trim();
      if (!topic) throw new Error('Introduza um nome de tópico.');
      results = [await sendToTopic(topic, title, body, type, priority, imageUrl, extraData)];
      logEntry(`Enviado para tópico: ${topic}`, title, body, type, results);
    }

    const successCount = results.filter(r => r.success).length;
    const failCount    = results.length - successCount;
    sucEl.textContent  = `✓ Enviado com sucesso! ${successCount} entregue(s)${failCount > 0 ? `, ${failCount} falha(s)` : ''}.`;
    showEl(sucEl);
    STATE.notifCount  += successCount;
    $('stat-notifs-sent').textContent = STATE.notifCount;

  } catch (err) {
    errEl.textContent = `Erro: ${err.message}`;
    showEl(errEl);
    logEntry('ERRO ao enviar', title, body, type, [{ success: false, error: err.message }]);
  } finally {
    btn.disabled  = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg> Enviar Notificação`;
  }
}

// ── FCM Send (Legacy HTTP API) ─────────────────────────────────────────────────
// Note: FCM Legacy API allows sending to individual tokens and topics.
// FCM HTTP v1 API requires a Google OAuth2 access token which cannot be
// obtained in a pure browser context. Using Legacy API here.
// For v1 API, use a Cloud Function or server proxy.

async function sendToToken(token, title, body, type, priority, imageUrl, extraData) {
  const payload = {
    to: token,
    priority: priority,
    notification: {
      title: title,
      body:  body,
      ...(imageUrl ? { image: imageUrl } : {}),
    },
    data: {
      type:  type,
      title: title,
      body:  body,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      ...extraData,
    },
  };

  const resp = await fetch('https://fcm.googleapis.com/fcm/send', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `key=${STATE.serverKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { success: false, token, error: `HTTP ${resp.status}: ${text}` };
  }
  const data = await resp.json();
  if (data.failure > 0) {
    return { success: false, token, error: data.results?.[0]?.error || 'FCM error' };
  }
  return { success: true, token, messageId: data.results?.[0]?.message_id };
}

async function sendBatch(tokens, title, body, type, priority, imageUrl, extraData) {
  // FCM supports multicast (up to 1000 tokens per request)
  const results = [];
  const CHUNK   = 500;

  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);

    if (chunk.length === 1) {
      // Single token
      results.push(await sendToToken(chunk[0], title, body, type, priority, imageUrl, extraData));
    } else {
      // Multicast
      const payload = {
        registration_ids: chunk,
        priority: priority,
        notification: {
          title: title,
          body:  body,
          ...(imageUrl ? { image: imageUrl } : {}),
        },
        data: {
          type:  type,
          title: title,
          body:  body,
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          ...extraData,
        },
      };

      try {
        const resp = await fetch('https://fcm.googleapis.com/fcm/send', {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `key=${STATE.serverKey}`,
          },
          body: JSON.stringify(payload),
        });

        if (!resp.ok) {
          const text = await resp.text();
          chunk.forEach(t => results.push({ success: false, token: t, error: `HTTP ${resp.status}: ${text}` }));
          continue;
        }

        const data = await resp.json();
        const rr   = data.results || [];
        chunk.forEach((t, idx) => {
          if (rr[idx]?.message_id) {
            results.push({ success: true, token: t, messageId: rr[idx].message_id });
          } else {
            results.push({ success: false, token: t, error: rr[idx]?.error || 'unknown' });
          }
        });
      } catch (err) {
        chunk.forEach(t => results.push({ success: false, token: t, error: err.message }));
      }
    }
  }
  return results;
}

async function sendToTopic(topic, title, body, type, priority, imageUrl, extraData) {
  const payload = {
    to: `/topics/${topic}`,
    priority: priority,
    notification: {
      title: title,
      body:  body,
      ...(imageUrl ? { image: imageUrl } : {}),
    },
    data: {
      type:  type,
      title: title,
      body:  body,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      ...extraData,
    },
  };

  const resp = await fetch('https://fcm.googleapis.com/fcm/send', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `key=${STATE.serverKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { success: false, error: `HTTP ${resp.status}: ${text}` };
  }
  const data = await resp.json();
  return data.message_id
      ? { success: true, messageId: data.message_id }
      : { success: false, error: data.error || 'FCM topic error' };
}

// ── Logs ───────────────────────────────────────────────────────────────────────
function logEntry(action, title, body, type, results) {
  const successCount = results.filter(r => r.success).length;
  const failCount    = results.length - successCount;
  const status       = failCount === 0 ? 'success' : (successCount > 0 ? 'pending' : 'error');
  const icons        = { success: '✅', pending: '⚠️', error: '❌' };

  STATE.logs.unshift({
    action,
    title,
    body,
    type,
    successCount,
    failCount,
    status,
    icon:      icons[status],
    timestamp: new Date(),
  });

  // Keep last 50 logs
  if (STATE.logs.length > 50) STATE.logs.length = 50;
}

function renderLogs() {
  const container = $('logs-container');
  if (STATE.logs.length === 0) {
    container.innerHTML = '<div class="empty-state">Sem histórico de envios ainda</div>';
    return;
  }
  container.innerHTML = '';
  STATE.logs.forEach(log => {
    const div = document.createElement('div');
    div.className = `log-entry ${log.status}`;
    div.innerHTML = `
      <div class="log-icon">${log.icon}</div>
      <div class="log-content">
        <div class="log-title">${esc(log.action)}</div>
        <div class="log-meta">
          <strong>${esc(log.title)}</strong> — ${esc(log.body.substring(0, 80))}${log.body.length > 80 ? '…' : ''}<br>
          Tipo: <code>${esc(log.type)}</code> |
          Sucesso: <strong style="color:#0A7A35">${log.successCount}</strong> |
          Falha: <strong style="color:#CC2200">${log.failCount}</strong>
        </div>
      </div>
      <div class="log-time">${formatTime(log.timestamp)}</div>
    `;
    container.appendChild(div);
  });
}

function clearLogs() {
  if (!confirm('Apagar todos os logs?')) return;
  STATE.logs = [];
  renderLogs();
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function userAvatarHtml(u) {
  if (u.urlFoto) {
    return `<img src="${esc(u.urlFoto)}" alt="${esc(u.nome || '')}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" onerror="this.style.display='none'" />`;
  }
  const initials = (u.nome || u._id || 'U').charAt(0).toUpperCase();
  return `<span>${initials}</span>`;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showEl(el) { el.style.display = ''; }
function hideEl(el) { el.style.display = 'none'; }

function formatTime(date) {
  if (!date) return '';
  return date.toLocaleTimeString('pt', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Expose global functions used by onclick= in HTML
window.loadDashboard = loadDashboard;
window.loadUsers     = loadUsers;
window.clearLogs     = clearLogs;
window.sendToSingleUser = sendToSingleUser;
