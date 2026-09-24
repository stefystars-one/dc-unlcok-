'use strict';
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const notice = $('notice');
const tokenInput = $('dev-token');
const licenseModal = $('license-modal');
let historyConversations = [];
let activeHistoryConversationId = '';
let messageRecipients = [];
let deviceRows = [];
let licenseRows = [];
let showAllDevices = false;
let showAllLicenses = false;
let pendingReplacementKey = '';
let activeActionButton = null;
let noticeTimer = null;

function devToken() { return sessionStorage.getItem('du_admin_dev_token') || ''; }
function feedbackTone(success) {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext; if (!Audio) return;
    const context = new Audio(); const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = success ? 720 : 210; gain.gain.value = 0.035;
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + (success ? .11 : .18));
    oscillator.stop(context.currentTime + (success ? .12 : .19));
  } catch (_) {}
}
function setButtonState(button, state) {
  if (!button) return;
  clearTimeout(Number(button.dataset.feedbackTimer || 0));
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent.trim();
  button.classList.remove('is-loading', 'is-success', 'is-failure');
  if (state === 'loading') { button.disabled = true; button.classList.add('is-loading'); button.textContent = 'Aguarde…'; return; }
  button.disabled = false;
  button.textContent = state === 'success' ? '✓ Concluído' : '↻ Tentar de novo';
  button.classList.add(state === 'success' ? 'is-success' : 'is-failure');
  button.dataset.feedbackTimer = String(setTimeout(() => {
    button.disabled = false; button.classList.remove('is-success', 'is-failure');
    button.textContent = button.dataset.defaultLabel || 'Concluído';
  }, state === 'success' ? 1150 : 1600));
}
function show(message, bad = false) {
  clearTimeout(noticeTimer); notice.textContent = message || ''; notice.className = message ? (bad ? 'error active' : 'ok active') : '';
  if (message) noticeTimer = setTimeout(() => { notice.className = ''; }, 4200);
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  button.classList.remove('button-tap'); void button.offsetWidth; button.classList.add('button-tap');
  activeActionButton = button;
}, true);
async function api(path, options = {}) {
  const actionButton = activeActionButton; activeActionButton = null;
  if (actionButton) setButtonState(actionButton, 'loading');
  try {
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    const token = devToken(); if (token) headers.set('X-Admin-Dev-Token', token);
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.message || ('Erro ' + response.status));
    if (actionButton) { setButtonState(actionButton, 'success'); feedbackTone(true); }
    return data;
  } catch (error) {
    if (actionButton) { setButtonState(actionButton, 'failure'); feedbackTone(false); }
    throw error;
  }
}
function cell(value) { const e = document.createElement('td'); e.textContent = value ?? ''; return e; }
function fmtDate(seconds) { return seconds ? new Date(Number(seconds) * 1000).toLocaleString('pt-BR') : '—'; }
function expiryLabel(seconds) { return seconds ? fmtDate(seconds) : 'Vitalícia'; }
function localInputFromSeconds(seconds) {
  if (!seconds) return ''; const date = new Date(Number(seconds) * 1000 - new Date().getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 16);
}
function expiryFromInput(value) { return value ? Math.floor(new Date(value).getTime() / 1000) : null; }
function randomLicense() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let out = 'DU-';
  for (let group = 0; group < 4; group += 1) { if (group) out += '-'; for (let i = 0; i < 5; i += 1) out += chars[Math.floor(Math.random() * chars.length)]; }
  return out;
}
async function loadOverview() {
  const data = await api('/admin-api/overview'); const t = data.totals;
  $('total-profiles').textContent = t.profiles; $('total-devices').textContent = t.activeDevices;
  $('total-requests').textContent = t.pendingRequests; $('total-messages').textContent = t.activeMessages;
}
function recipientLabel(profile) {
  const identification = String(profile.license_label || '').trim();
  const name = String(profile.display_name || 'Usuário').trim();
  return identification ? identification + ' — ' + name + ' (' + profile.public_id + ')' : name + ' (' + profile.public_id + ')';
}
function updateRecipientList() {
  const list = $('recipient-list'); list.replaceChildren();
  for (const profile of messageRecipients.filter((item) => item.role !== 'admin')) {
    const option = document.createElement('option');
    option.value = profile.license_label || profile.display_name || profile.public_id;
    option.label = recipientLabel(profile);
    list.append(option);
  }
}
function resolveRecipient(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Escolha um destinatário.');
  const normalized = raw.toLocaleLowerCase('pt-BR');
  const matches = messageRecipients.filter((profile) =>
    String(profile.public_id || '').toLocaleLowerCase('pt-BR') === normalized ||
    String(profile.display_name || '').toLocaleLowerCase('pt-BR') === normalized ||
    String(profile.license_label || '').toLocaleLowerCase('pt-BR') === normalized
  );
  if (matches.length === 1) return matches[0].public_id;
  if (matches.length > 1) throw new Error('Há mais de um usuário com esse nome. Selecione pelo DC ID.');
  if (/^DU-[A-Z0-9-]+$/i.test(raw)) return raw.toUpperCase();
  throw new Error('Destinatário não encontrado. Escolha um item da lista ou informe o DC ID.');
}
async function loadProfiles() {
  const query = $('search').value.trim();
  const data = await api('/admin-api/profiles?q=' + encodeURIComponent(query));
  if (!query) { messageRecipients = Array.isArray(data.profiles) ? data.profiles : []; updateRecipientList(); }
  const tbody = $('profiles'); tbody.replaceChildren();
  for (const profile of data.profiles) {
    const row = document.createElement('tr');
    row.append(cell(profile.license_label || '—'), cell(profile.display_name), cell(profile.public_id), cell(profile.role === 'admin' ? 'ADM' : 'Usuário'), cell(String(profile.active_devices)));
    const actions = document.createElement('td');
    const message = document.createElement('button'); message.textContent = 'Mensagem'; message.className = 'secondary';
    message.addEventListener('click', () => { $('recipient').value = profile.license_label || profile.display_name || profile.public_id; $('message').focus(); }); actions.append(message);
    if (profile.role !== 'admin' && Number(profile.devices_total) > 0 && Number(profile.active_devices) === 0) {
      const remove = document.createElement('button'); remove.textContent = 'Apagar'; remove.className = 'danger';
      remove.addEventListener('click', async () => {
        if (!confirm('Apagar este perfil revogado, suas conversas e seus dispositivos? A licença será mantida.')) return;
        try { await api('/admin-api/profiles/' + encodeURIComponent(profile.public_id), { method: 'DELETE' }); show('Perfil revogado apagado.'); await refreshAll(); } catch (error) { show(error.message, true); }
      }); actions.append(remove);
    }
    row.append(actions); tbody.append(row);
  }
  if (!data.profiles.length) { const row = document.createElement('tr'); const td = cell('Nenhum usuário encontrado.'); td.colSpan = 6; row.append(td); tbody.append(row); }
}
function shortHwid(value) {
  const hwid = String(value || '');
  return hwid.length > 22 ? hwid.slice(0, 12) + '…' + hwid.slice(-8) : (hwid || '—');
}
function renderDevicesAdmin() {
  const limit = 10, visible = showAllDevices ? deviceRows : deviceRows.slice(0, limit);
  const tbody = $('devices'); tbody.replaceChildren();
  for (const device of visible) {
    const row = document.createElement('tr');
    const key = cell(String(device.license_label || 'Sem identificação'));
    const keySub = document.createElement('small'); keySub.className = 'license-owner';
    keySub.textContent = String(device.license_id || '').slice(0, 8) + ' · limite ' + String(device.max_devices || '—');
    key.append(document.createElement('br'), keySub);
    const user = cell(device.display_name + ' (' + device.public_id + ')');
    const pcSub = document.createElement('small'); pcSub.className = 'license-owner';
    pcSub.textContent = 'Vinculado em ' + fmtDate(device.created_at);
    user.append(document.createElement('br'), pcSub);
    const hwid = cell(shortHwid(device.hwid_hash));
    hwid.title = String(device.hwid_hash || '');
    hwid.className = 'hwid-fingerprint';
    if (device.hwid_hash) {
      const copy = document.createElement('button'); copy.textContent = 'Copiar'; copy.className = 'secondary'; copy.style.marginLeft = '7px';
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(String(device.hwid_hash)); show('HWID protegido copiado.'); } catch (_) { show('Não foi possível copiar o HWID.', true); } });
      hwid.append(document.createElement('br'), copy);
    }
    const status = cell(device.status === 'active' ? 'Ativo' : 'Banido');
    status.className = device.status === 'active' ? 'status-active' : 'status-revoked';
    const actions = document.createElement('td');
    if (device.status === 'active') {
      const ban = document.createElement('button'); ban.textContent = 'Banir HWID'; ban.className = 'danger';
      ban.addEventListener('click', async () => {
        if (!confirm('Banir este HWID? O PC perderá acesso imediatamente, inclusive se a chave for usada novamente.')) return;
        try { await api('/admin-api/devices/' + device.id + '/ban', { method: 'POST' }); show('HWID banido e sessões encerradas.'); await refreshAll(); } catch (error) { show(error.message, true); }
      });
      actions.append(ban);
    } else {
      const unban = document.createElement('button'); unban.textContent = 'Reativar HWID'; unban.className = 'secondary';
      unban.addEventListener('click', async () => {
        if (!confirm('Reativar este HWID? Ele voltará a ocupar uma vaga da chave.')) return;
        try { await api('/admin-api/devices/' + device.id + '/unban', { method: 'POST' }); show('HWID reativado.'); await refreshAll(); } catch (error) { show(error.message, true); }
      });
      actions.append(unban);
    }
    row.append(key, user, hwid, cell(fmtDate(device.last_seen_at)), cell(device.app_version || '—'), status, actions); tbody.append(row);
  }
  if (!visible.length) { const row = document.createElement('tr'); const td = cell('Nenhum computador vinculado a chaves compartilhadas.'); td.colSpan = 7; row.append(td); tbody.append(row); }
  const toggle = $('toggle-devices'); toggle.hidden = deviceRows.length <= limit; toggle.textContent = showAllDevices ? 'Mostrar menos' : 'Mostrar mais (' + (deviceRows.length - limit) + ')';
}
async function loadDevicesAdmin() {
  const data = await api('/admin-api/devices'); deviceRows = Array.isArray(data.devices) ? data.devices : []; renderDevicesAdmin();
}
function licenseOwner(license) {
  const name = String(license.profile_name || '').trim(), id = String(license.profile_public_id || '').trim();
  return name ? name + (id ? ' (' + id + ')' : '') : '';
}
function renderLicensesAdmin() {
  const query = String($('license-search').value || '').trim().toLocaleLowerCase('pt-BR');
  const filtered = licenseRows.filter((license) => [license.label, license.id, license.profile_name, license.profile_public_id].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(query)));
  const limit = 6, visible = showAllLicenses ? filtered : filtered.slice(0, limit);
  const tbody = $('licenses'); tbody.replaceChildren();
  for (const license of visible) {
    const row = document.createElement('tr');
    const identity = cell(license.label || license.id.slice(0, 8));
    const owner = licenseOwner(license);
    if (owner) { const sub = document.createElement('small'); sub.className = 'license-owner'; sub.textContent = owner; identity.append(document.createElement('br'), sub); }
    row.append(identity, cell(expiryLabel(license.expires_at)), cell(license.status === 'active' ? 'Ativa' : 'Revogada'), cell(String(license.devices) + '/' + String(license.max_devices)));
    const actions = document.createElement('td');
    const edit = document.createElement('button'); edit.textContent = 'Editar'; edit.className = 'secondary'; edit.addEventListener('click', () => openLicenseEditor(license)); actions.append(edit);
    if (license.status === 'revoked' && Number(license.devices) === 0) {
      const remove = document.createElement('button'); remove.textContent = 'Apagar'; remove.className = 'danger';
      remove.addEventListener('click', async () => {
        if (!confirm('Apagar permanentemente esta licença revogada?')) return;
        try { await api('/admin-api/licenses/' + license.id, { method: 'DELETE' }); show('Licença revogada apagada.'); await loadLicensesAdmin(); } catch (error) { show(error.message, true); }
      }); actions.append(remove);
    }
    row.append(actions); tbody.append(row);
  }
  if (!visible.length) { const row = document.createElement('tr'); const td = cell('Nenhuma licença encontrada.'); td.colSpan = 5; row.append(td); tbody.append(row); }
  const toggle = $('toggle-licenses'); toggle.hidden = filtered.length <= limit; toggle.textContent = showAllLicenses ? 'Mostrar menos' : 'Mostrar mais (' + (filtered.length - limit) + ')';
}
function openLicenseEditor(license) {
  pendingReplacementKey = '';
  $('replacement-license-result').hidden = true; $('replacement-license-value').textContent = '';
  $('save-license').textContent = 'Salvar licença';
  $('edit-license-id').value = license.id; $('edit-license-label').value = license.label || '';
  $('edit-license-max-devices').value = String(license.max_devices); $('edit-license-expires-at').value = localInputFromSeconds(license.expires_at);
  $('edit-license-status').value = license.status; licenseModal.showModal();
}
async function loadLicensesAdmin() {
  const data = await api('/admin-api/licenses'); licenseRows = Array.isArray(data.licenses) ? data.licenses : []; renderLicensesAdmin();
}
function appendLinkedText(container, value) {
  const text = String(value || ''); const urlPattern = /https?:\/\/[^\s<>"']+/gi; let cursor = 0;
  for (const match of text.matchAll(urlPattern)) {
    if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
    const url = match[0]; const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = url; link.className = 'message-link';
    container.append(link); cursor = match.index + url.length;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
}
function historyPeer(conversation) {
  const fallback = String(conversation.participants || 'Conversa').split(' ↔ ').find((part) => !/\bADM\b/i.test(part)) || String(conversation.participants || 'Conversa');
  const match = fallback.match(/^(.*?)\s*\((DU-[A-Z0-9-]+)\)$/i);
  return {
    name: conversation.counterpart_name || (match ? match[1].trim() : fallback.trim()) || 'Usuário',
    publicId: conversation.counterpart_public_id || (match ? match[2].toUpperCase() : ''),
    identification: String(conversation.counterpart_license_label || '').trim()
  };
}
function renderHistoryConversations() {
  const host = $('history-conversations'); host.replaceChildren();
  if (!historyConversations.length) { const empty = document.createElement('div'); empty.className = 'history-empty'; empty.textContent = 'Nenhuma conversa no histórico.'; host.append(empty); return; }
  for (const conversation of historyConversations) {
    const peer = historyPeer(conversation);
    const item = document.createElement('button'); item.className = 'history-conversation' + (conversation.id === activeHistoryConversationId ? ' active' : '');
    const name = document.createElement('strong'); name.textContent = peer.name;
    if (peer.identification) { const identification = document.createElement('span'); identification.className = 'history-identification'; identification.textContent = 'Identificação: ' + peer.identification; item.append(identification); }
    const id = document.createElement('span'); id.className = 'history-id'; id.textContent = peer.publicId || 'Conversa';
    const preview = document.createElement('small'); preview.textContent = conversation.last_message || 'Sem mensagens';
    const meta = document.createElement('em'); meta.textContent = String(conversation.message_count || 0) + ' mensagem(ns)';
    item.append(name, id, preview, meta); item.addEventListener('click', () => { activeHistoryConversationId = conversation.id; renderHistoryConversations(); loadHistoryThread(); }); host.append(item);
  }
}async function loadHistory() {
  const data = await api('/admin-api/history'); historyConversations = Array.isArray(data.conversations) ? data.conversations : [];
  if (!historyConversations.some((item) => item.id === activeHistoryConversationId)) activeHistoryConversationId = historyConversations[0]?.id || '';
  renderHistoryConversations(); await loadHistoryThread();
}
async function loadHistoryThread() {
  const host = $('history-messages'); const title = $('history-thread-title'); const idLabel = $('history-thread-id'); const clear = $('clear-history-thread'); const reply = $('history-reply'); host.replaceChildren();
  const conversation = historyConversations.find((item) => item.id === activeHistoryConversationId);
  const peer = conversation ? historyPeer(conversation) : null;
  title.textContent = peer ? (peer.identification ? peer.name + ' — ' + peer.identification : peer.name) : 'Selecione uma conversa'; idLabel.textContent = peer?.publicId || ''; clear.hidden = !conversation; if (reply) reply.hidden = !conversation;
  if (!conversation) { const empty = document.createElement('div'); empty.className = 'history-empty'; empty.textContent = 'As mensagens desta conversa aparecerão aqui.'; host.append(empty); return; }
  const data = await api('/admin-api/history/' + conversation.id);
  for (const message of data.messages) {
    const block = document.createElement('article'); block.className = 'history-message';
    const meta = document.createElement('div'); meta.className = 'meta'; const sender = document.createElement('strong'); sender.textContent = message.sender_name; const senderId = document.createElement('small'); senderId.textContent = message.sender_public_id || ''; const date = document.createElement('span'); date.textContent = fmtDate(message.created_at); meta.append(sender, senderId, date);
    const body = document.createElement('div'); body.className = 'body'; appendLinkedText(body, message.kind === 'text' ? (message.body || '') : '[' + message.kind + '] ' + (message.body || ''));
    block.append(meta, body); host.append(block);
  }
  if (!data.messages.length) { const empty = document.createElement('div'); empty.className = 'history-empty'; empty.textContent = 'Esta conversa não tem mais mensagens.'; host.append(empty); }
  host.scrollTop = host.scrollHeight;
}
function openHistoryReply() {
  const conversation = historyConversations.find((item) => item.id === activeHistoryConversationId); const peer = conversation ? historyPeer(conversation) : null;
  if (!peer?.publicId) { show('Selecione uma conversa com um usuário para responder.', true); return; }
  const box = $('history-reply'); if (box) box.hidden = false;
  $('history-reply-text').focus();
}
async function sendHistoryReply() {
  const conversation = historyConversations.find((item) => item.id === activeHistoryConversationId); const peer = conversation ? historyPeer(conversation) : null;
  const input = $('history-reply-text'); const text = String(input?.value || '').trim();
  if (!peer?.publicId) throw new Error('Usuário da conversa não encontrado.');
  if (!text) { show('Digite uma resposta antes de enviar.', true); return; }
  try {
    await api('/admin-api/conversations', { method: 'POST', body: JSON.stringify({ recipientPublicId: peer.publicId, text }) });
    input.value = ''; show('Resposta enviada para ' + peer.name + '.'); await Promise.all([loadOverview(), loadHistory()]);
  } catch (error) { show(error.message, true); }
}
async function loadMotd() {
  const data = await api('/admin-api/motd');
  $('motd').value = data.motd || '';
  $('motd-status').textContent = data.motd ? (String(data.motd).length + '/4000 caracteres') : '';
}

async function refreshAll() {
  show('Atualizando…');
  try { await Promise.all([loadOverview(), loadProfiles(), loadDevicesAdmin(), loadLicensesAdmin(), loadHistory(), loadMotd(), loadGalleryAdmin(), loadGallerySettings(), loadGallerySources()]); show('Painel atualizado.'); } catch (error) { show(error.message, true); }
}
$('save-token').addEventListener('click', () => { sessionStorage.setItem('du_admin_dev_token', tokenInput.value); refreshAll(); });
$('refresh').addEventListener('click', refreshAll);
$('save-motd').addEventListener('click', async () => {
  try {
    const motd = $('motd').value.trim();
    const data = await api('/admin-api/motd', { method: 'PUT', body: JSON.stringify({ motd }) });
    $('motd').value = data.motd || motd;
    $('motd-status').textContent = String($('motd').value).length + '/4000 caracteres';
    show('Mensagem do dia publicada para os apps atualizados.');
  } catch (error) { show(error.message, true); }
});

$('refresh-history').addEventListener('click', () => loadHistory().then(() => show('Histórico atualizado.')).catch((error) => show(error.message, true)));
$('reply-history').addEventListener('click', openHistoryReply);
$('send-history-reply').addEventListener('click', sendHistoryReply);
$('history-reply-text').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendHistoryReply(); } });
$('clear-history-thread').addEventListener('click', async () => {
  if (!activeHistoryConversationId || !confirm('Limpar permanentemente todas as mensagens desta conversa?')) return;
  try { await api('/admin-api/history/' + activeHistoryConversationId, { method: 'DELETE' }); activeHistoryConversationId = ''; show('Conversa apagada do histórico.'); await refreshAll(); } catch (error) { show(error.message, true); }
});
$('clear-all-history').addEventListener('click', async () => {
  if (!confirm('Limpar permanentemente todo o histórico de mensagens? Esta ação não pode ser desfeita.')) return;
  try { await api('/admin-api/history', { method: 'DELETE' }); activeHistoryConversationId = ''; show('Histórico limpo.'); await refreshAll(); } catch (error) { show(error.message, true); }
});
$('search-button').addEventListener('click', () => loadProfiles().catch((error) => show(error.message, true)));
$('search').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadProfiles().catch((error) => show(error.message, true)); });
$('send-message').addEventListener('click', async () => {
  try {
    const recipientPublicId = resolveRecipient($('recipient').value);
    await api('/admin-api/conversations', { method: 'POST', body: JSON.stringify({ recipientPublicId, text: $('message').value.trim() }) });
    $('recipient').value = ''; $('message').value = ''; show('Mensagem da ADM enviada.');
    await Promise.all([loadOverview(), loadHistory()]);
  } catch (error) { show(error.message, true); }
});
$('create-license').addEventListener('click', async () => {
  const licenseKey = randomLicense();
  try { await api('/admin-api/licenses', { method: 'POST', body: JSON.stringify({ licenseKey, label: $('license-label').value.trim(), maxDevices: Number($('max-devices').value), expiresAt: expiryFromInput($('license-expires-at').value) }) }); $('license-value').textContent = licenseKey; $('new-license').hidden = false; show('Licença criada. Copie a chave agora.'); await loadLicensesAdmin(); } catch (error) { show(error.message, true); }
});
$('copy-license').addEventListener('click', async () => { await navigator.clipboard.writeText($('license-value').textContent); show('Chave copiada.'); });
$('toggle-devices').addEventListener('click', () => { showAllDevices = !showAllDevices; renderDevicesAdmin(); });$('ban-manual-hwid').addEventListener('click', async () => {
  const hwid = String($('manual-hwid').value || '').trim();
  const reason = String($('manual-hwid-reason').value || '').trim();
  if (!hwid) { show('Informe o HWID que deseja banir.', true); return; }
  if (!confirm('Banir este HWID de forma preventiva? Quando esse PC tentar usar qualquer chave, o acesso será negado.')) return;
  try {
    const result = await api('/admin-api/hwid-bans', { method: 'POST', body: JSON.stringify({ hwid, reason }) });
    $('manual-hwid').value = ''; $('manual-hwid-reason').value = '';
    show(result.matchedDevice ? 'HWID banido e dispositivo existente desconectado.' : 'HWID banido preventivamente.');
    await refreshAll();
  } catch (error) { show(error.message, true); }
});
$('unban-manual-hwid').addEventListener('click', async () => {
  const hwid = String($('manual-hwid').value || '').trim();
  if (!hwid) { show('Informe o HWID que deseja desbanir.', true); return; }
  if (!confirm('Remover o banimento deste HWID? Se ele já existir na lista, use também “Reativar HWID” para devolver a vaga da chave.')) return;
  try {
    const result = await api('/admin-api/hwid-bans', { method: 'DELETE', body: JSON.stringify({ hwid }) });
    $('manual-hwid').value = ''; $('manual-hwid-reason').value = '';
    show(result.matchedDevice ? 'Banimento removido. Reative o PC na lista se desejar liberá-lo agora.' : 'Banimento preventivo removido.');
    await refreshAll();
  } catch (error) { show(error.message, true); }
});
$('toggle-licenses').addEventListener('click', () => { showAllLicenses = !showAllLicenses; renderLicensesAdmin(); });
$('license-search').addEventListener('input', () => { showAllLicenses = false; renderLicensesAdmin(); });
$('replace-license-key').addEventListener('click', () => {
  if (!confirm('Gerar uma nova chave? A chave atual seguirá válida somente até você salvar esta licença.')) return;
  pendingReplacementKey = randomLicense();
  $('replacement-license-value').textContent = pendingReplacementKey; $('replacement-license-result').hidden = false;
  $('save-license').textContent = 'Salvar e substituir chave';
});
$('copy-replacement-license').addEventListener('click', async () => { await navigator.clipboard.writeText($('replacement-license-value').textContent); show('Nova chave copiada.'); });
$('close-license-modal').addEventListener('click', () => licenseModal.close());
$('save-license').addEventListener('click', async () => {
  try {
    await api('/admin-api/licenses/' + $('edit-license-id').value, { method: 'PATCH', body: JSON.stringify({ label: $('edit-license-label').value.trim(), maxDevices: Number($('edit-license-max-devices').value), expiresAt: expiryFromInput($('edit-license-expires-at').value), status: $('edit-license-status').value, licenseKey: pendingReplacementKey || undefined }) });
    licenseModal.close(); show(pendingReplacementKey ? 'Nova chave salva. Envie-a ao cliente.' : 'Licença atualizada.'); pendingReplacementKey = ''; await refreshAll();
  } catch (error) { show(error.message, true); }
});

// ── Loja de Temas & Banners (Galeria DU) ──────────────────────────────────
function normalizeMediaUrl(url) {
  if (!url) return '';
  url = url.trim();
  // Giphy page link: https://giphy.com/gifs/funny-cat-3oEjI6SIIHBdRxXI40 ou https://giphy.com/gifs/3oEjI6SIIHBdRxXI40
  const giphyMatch = url.match(/giphy\.com\/gifs\/(?:.*-)?([a-zA-Z0-9]+)$/i);
  if (giphyMatch && giphyMatch[1] && !url.includes('/media/')) {
    return `https://i.giphy.com/media/${giphyMatch[1]}/giphy.gif`;
  }
  // Imgur page link: https://imgur.com/abc1234
  const imgurMatch = url.match(/^https?:\/\/imgur\.com\/([a-zA-Z0-9]+)$/i);
  if (imgurMatch && imgurMatch[1]) {
    return `https://i.imgur.com/${imgurMatch[1]}.gif`;
  }
  return url;
}

function isDirectVideoUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (/\.(mp4|webm|m4v|mov)$/i.test(url.pathname)) return true;
    const mime = decodeURIComponent(url.searchParams.get('mime') || '').toLowerCase();
    if (/^video\/(mp4|webm|quicktime)$/i.test(mime)) return true;
    return /(^|\.)googlevideo\.com$/i.test(url.hostname)
      && /\/videoplayback$/i.test(url.pathname)
      && (url.searchParams.has('itag') || url.searchParams.has('mime'));
  } catch (_) {
    return false;
  }
}

function updateAdminGalleryPreview() {
  const inp = $('gallery-url');
  let url = (inp ? inp.value : '').trim();
  if (url) {
    const normalized = normalizeMediaUrl(url);
    if (normalized !== url) {
      url = normalized;
      inp.value = normalized;
    }
  }

  const target = ($('gallery-target') ? $('gallery-target').value : 'both') || 'both';
  const name = ($('gallery-name') ? $('gallery-name').value : '').trim();

  const nameEl = $('preview-item-name');
  if (nameEl) nameEl.textContent = name || 'Nome do Tema';

  const badgeEl = $('preview-mode-badge');
  const descEl = $('preview-target-desc');
  if (badgeEl && descEl) {
    if (target === 'both') {
      badgeEl.textContent = '✨ Ambos';
      badgeEl.style.color = '#c4b5fd';
      badgeEl.style.borderColor = 'rgba(139,92,246,0.35)';
      badgeEl.style.background = 'rgba(139,92,246,0.18)';
      descEl.textContent = 'Aplica no Banner de fundo & Avatar circular';
    } else if (target === 'banner') {
      badgeEl.textContent = '🖼️ Banner';
      badgeEl.style.color = '#93c5fd';
      badgeEl.style.borderColor = 'rgba(59,130,246,0.35)';
      badgeEl.style.background = 'rgba(59,130,246,0.18)';
      descEl.textContent = 'Aplica na Capa / Fundo de perfil (Banner)';
    } else if (target === 'avatar') {
      badgeEl.textContent = '👤 Avatar';
      badgeEl.style.color = '#86efac';
      badgeEl.style.borderColor = 'rgba(34,197,94,0.35)';
      badgeEl.style.background = 'rgba(34,197,94,0.18)';
      descEl.textContent = 'Aplica na Foto de perfil (Avatar circular)';
    } else {
      badgeEl.textContent = '🎨 Tema';
      badgeEl.style.color = '#fcd34d';
      badgeEl.style.borderColor = 'rgba(245,158,11,0.35)';
      badgeEl.style.background = 'rgba(245,158,11,0.18)';
      descEl.textContent = 'Aplica no Wallpaper geral do Discord';
    }
  }

  const ph = $('gallery-preview-placeholder');
  const bannerImg = $('gallery-preview-img');
  const bannerVid = $('gallery-preview-vid');
  const avatarImg = $('gallery-preview-avatar-img');
  const avatarVid = $('gallery-preview-avatar-vid');
  const avatarInitial = $('preview-avatar-initial');
  const avatarCircle = $('preview-avatar-circle');

  if (!url) {
    if (ph) {
      ph.style.display = 'block';
      ph.innerHTML = 'Cole o link ao lado para ver a prévia em tempo real ✨';
    }
    if (bannerImg) { bannerImg.style.display = 'none'; bannerImg.src = ''; }
    if (bannerVid) { bannerVid.style.display = 'none'; bannerVid.src = ''; }
    if (avatarImg) { avatarImg.style.display = 'none'; avatarImg.src = ''; }
    if (avatarVid) { avatarVid.style.display = 'none'; avatarVid.src = ''; }
    if (avatarInitial) avatarInitial.style.display = 'block';
    if (avatarCircle) avatarCircle.classList.remove('is-active');
    return;
  }

  // Detecção amigável de links de página do Klipy ou Tenor
  if (/klipy\.com\/gifs\//i.test(url)) {
    if (ph) {
      ph.style.display = 'block';
      ph.innerHTML = `<div style="padding:10px;line-height:1.4;"><strong style="color:#f87171;font-size:12px;">⚠️ Link de página do Klipy detectado!</strong><br><span style="color:#cbd5e1;font-size:11px;">Abra o GIF no Klipy, clique com o <strong>botão direito nele</strong> e escolha <strong>"Copiar endereço da imagem"</strong> (terá início com <em>https://static.klipy.com/...</em>).</span></div>`;
    }
    if (bannerImg) { bannerImg.style.display = 'none'; bannerImg.src = ''; }
    if (bannerVid) { bannerVid.style.display = 'none'; bannerVid.src = ''; }
    if (avatarImg) { avatarImg.style.display = 'none'; avatarImg.src = ''; }
    if (avatarVid) { avatarVid.style.display = 'none'; avatarVid.src = ''; }
    if (avatarInitial) avatarInitial.style.display = 'block';
    if (avatarCircle) avatarCircle.classList.remove('is-active');
    return;
  }
  if (/tenor\.com\/view\//i.test(url)) {
    if (ph) {
      ph.style.display = 'block';
      ph.innerHTML = `<div style="padding:10px;line-height:1.4;"><strong style="color:#f87171;font-size:12px;">⚠️ Link de página do Tenor detectado!</strong><br><span style="color:#cbd5e1;font-size:11px;">Clique com o <strong>botão direito sobre o GIF</strong> no Tenor e selecione <strong>"Copiar endereço da imagem"</strong>.</span></div>`;
    }
    if (bannerImg) { bannerImg.style.display = 'none'; bannerImg.src = ''; }
    if (bannerVid) { bannerVid.style.display = 'none'; bannerVid.src = ''; }
    if (avatarImg) { avatarImg.style.display = 'none'; avatarImg.src = ''; }
    if (avatarVid) { avatarVid.style.display = 'none'; avatarVid.src = ''; }
    if (avatarInitial) avatarInitial.style.display = 'block';
    if (avatarCircle) avatarCircle.classList.remove('is-active');
    return;
  }
  if (/(^|\/\/)(www\.)?(youtube\.com\/watch|youtu\.be\/)/i.test(url)) {
    if (ph) {
      ph.style.display = 'block';
      ph.innerHTML = '<div style="padding:10px;line-height:1.4;"><strong style="color:#fbbf24;font-size:12px;">⚠️ Link de página do YouTube</strong><br><span style="color:#cbd5e1;font-size:11px;">O Discord Unlock só reproduz arquivos de vídeo diretos. Use uma URL HTTPS que entregue MP4 ou WebM; o endereço <em>youtube.com/watch</em> não é um arquivo de vídeo.</span></div>';
    }
    if (bannerImg) { bannerImg.style.display = 'none'; bannerImg.src = ''; }
    if (bannerVid) { bannerVid.style.display = 'none'; bannerVid.src = ''; }
    if (avatarImg) { avatarImg.style.display = 'none'; avatarImg.src = ''; }
    if (avatarVid) { avatarVid.style.display = 'none'; avatarVid.src = ''; }
    if (avatarInitial) avatarInitial.style.display = 'block';
    if (avatarCircle) avatarCircle.classList.remove('is-active');
    return;
  }

  const isVid = isDirectVideoUrl(url);

  // Atualizar Banner
  if (target === 'banner' || target === 'both' || target === 'theme') {
    if (isVid) {
      if (bannerImg) { bannerImg.style.display = 'none'; bannerImg.src = ''; }
      if (bannerVid) {
        bannerVid.onerror = () => {
          if (ph) {
            ph.style.display = 'block';
            ph.innerHTML = '<span style="color:#f87171;font-size:11px;">⚠️ O servidor recusou este vídeo. Links temporários do YouTube/Google podem expirar ou ser vinculados ao IP; use um MP4/WebM permanente.</span>';
          }
          bannerVid.style.display = 'none';
        };
        bannerVid.style.display = 'block';
        if (bannerVid.src !== url) { bannerVid.src = url; bannerVid.load(); }
      }
      if (ph) ph.style.display = 'none';
    } else {
      if (bannerVid) { bannerVid.style.display = 'none'; bannerVid.src = ''; }
      if (bannerImg) {
        bannerImg.onload = () => {
          if (ph) ph.style.display = 'none';
          bannerImg.style.display = 'block';
        };
        bannerImg.onerror = () => {
          if (ph) {
            ph.style.display = 'block';
            ph.innerHTML = `<span style="color:#f87171;font-size:11px;">⚠️ Não foi possível carregar a imagem deste link direto.</span>`;
          }
          bannerImg.style.display = 'none';
        };
        bannerImg.src = url;
        bannerImg.style.display = 'block';
        if (ph) ph.style.display = 'none';
      }
    }
  } else {
    // Modo Avatar: banner fica limpo
    if (bannerImg) { bannerImg.style.display = 'none'; bannerImg.src = ''; }
    if (bannerVid) { bannerVid.style.display = 'none'; bannerVid.src = ''; }
    if (ph) {
      ph.style.display = 'block';
      ph.innerHTML = '<span style="color:#64748b;font-size:11px;">(Modo somente Foto de Perfil / Avatar circular)</span>';
    }
  }

  // Atualizar Avatar Circle
  if (target === 'avatar' || target === 'both') {
    if (avatarCircle) avatarCircle.classList.add('is-active');
    if (isVid) {
      if (avatarInitial) avatarInitial.style.display = 'none';
      if (avatarImg) { avatarImg.style.display = 'none'; avatarImg.src = ''; }
      if (avatarVid) {
        avatarVid.onerror = () => {
          if (ph) {
            ph.style.display = 'block';
            ph.innerHTML = '<span style="color:#f87171;font-size:11px;">⚠️ O servidor recusou este vídeo. Use um link direto MP4/WebM permanente.</span>';
          }
          avatarVid.style.display = 'none';
        };
        avatarVid.style.display = 'block';
        if (avatarVid.src !== url) { avatarVid.src = url; avatarVid.load(); }
      }
    } else {
      if (avatarVid) { avatarVid.style.display = 'none'; avatarVid.src = ''; }
      if (avatarImg) {
        avatarImg.onload = () => {
          if (avatarInitial) avatarInitial.style.display = 'none';
          avatarImg.style.display = 'block';
        };
        avatarImg.onerror = () => {
          if (avatarInitial) avatarInitial.style.display = 'block';
          avatarImg.style.display = 'none';
        };
        avatarImg.src = url;
        avatarImg.style.display = 'block';
        if (avatarInitial) avatarInitial.style.display = 'none';
      }
    }
  } else {
    // Banner ou Tema: avatar mostra ícone padrão
    if (avatarImg) { avatarImg.style.display = 'none'; avatarImg.src = ''; }
    if (avatarVid) { avatarVid.style.display = 'none'; avatarVid.src = ''; }
    if (avatarInitial) avatarInitial.style.display = 'block';
    if (avatarCircle) avatarCircle.classList.remove('is-active');
  }
}

async function loadGallerySettings() {
  const data = await api('/admin-api/du-banner/settings');
  setGalleryStoreToggle(data.storeEnabled !== false);
  if ($('gallery-klipy-enabled')) $('gallery-klipy-enabled').checked = data.klipyEnabled === true;
  if ($('gallery-klipy-key')) $('gallery-klipy-key').value = data.klipyAppKey || '';
}
async function saveGallerySettings() {
  try {
    const data = await api('/admin-api/du-banner/settings', {
      method: 'PUT',
      body: JSON.stringify({
        storeEnabled: $('gallery-store-toggle')?.dataset.enabled === 'true',
        klipyEnabled: !!$('gallery-klipy-enabled').checked,
        klipyAppKey: $('gallery-klipy-key').value.trim()
      })
    });
    $('gallery-klipy-enabled').checked = data.klipyEnabled;
    setGalleryStoreToggle(data.storeEnabled);
    show('Controles da loja salvos. A chave KLIPY só ativa a busca com uma App Key válida.');
  } catch (e) { await loadGallerySettings().catch(() => {}); show('Erro ao salvar controles da loja: ' + e.message, true); }
}
function setGalleryStoreToggle(enabled) {
  const button = $('gallery-store-toggle');
  if (!button) return;
  button.dataset.enabled = enabled ? 'true' : 'false';
  button.setAttribute('aria-checked', enabled ? 'true' : 'false');
  button.textContent = enabled ? '🟢 Loja de GIFs: visível' : '⚫ Loja de GIFs: oculta';
}
if ($('gallery-store-toggle')) $('gallery-store-toggle').addEventListener('click', async () => {
  const button = $('gallery-store-toggle');
  setGalleryStoreToggle(button.dataset.enabled !== 'true');
  await saveGallerySettings();
});
async function loadGallerySources() {
  const list = $('gallery-sources-list');
  if (!list) return;
  try {
    const data = await api('/admin-api/du-banner/sources');
    const items = data.items || [];
    list.innerHTML = items.length ? items.map(item => `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid rgba(148,163,184,.18);border-radius:8px"><span><strong>${escapeHtml(item.name)}</strong> <small style="color:#94a3b8">${escapeHtml(item.domain)}</small></span><button type="button" class="danger" data-delete-gallery-source="${escapeHtml(item.id)}">Remover</button></div>`).join('') : '<span class="field-help">Nenhum site cadastrado.</span>';
    list.querySelectorAll('[data-delete-gallery-source]').forEach(button => button.addEventListener('click', async () => {
      try { await api('/admin-api/du-banner/sources/' + encodeURIComponent(button.dataset.deleteGallerySource), {method:'DELETE'}); await loadGallerySources(); show('Site removido.'); }
      catch (e) { show('Erro ao remover site: ' + e.message, true); }
    }));
  } catch (e) { list.textContent = 'Não foi possível carregar os sites: ' + e.message; }
}
if ($('add-gallery-source')) $('add-gallery-source').addEventListener('click', async () => {
  try {
    await api('/admin-api/du-banner/sources', {method:'POST',body:JSON.stringify({name:$('gallery-source-name').value,domain:$('gallery-source-domain').value})});
    $('gallery-source-name').value = ''; $('gallery-source-domain').value = '';
    await loadGallerySources(); show('Site permitido adicionado.');
  } catch (e) { show('Erro ao adicionar site: ' + e.message, true); }
});
if ($('save-gallery-settings')) $('save-gallery-settings').addEventListener('click', saveGallerySettings);

function setGalleryConfigVisible(visible) {
  const storeContent = $('gallery-store-content');
  const panels = $('gallery-config-panels');
  const button = $('toggle-gallery-config');
  const headerButton = $('header-gallery-config-toggle');
  if (storeContent) storeContent.hidden = !visible;
  else if (panels) panels.hidden = !visible;
  if (button) {
    button.setAttribute('aria-expanded', visible ? 'true' : 'false');
    button.textContent = visible ? '⚙️ Ocultar configurações' : '⚙️ Mostrar configurações';
  }
  if (headerButton) {
    headerButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
    headerButton.textContent = visible ? '🛍️ Ocultar configurações da Loja' : '🛍️ Mostrar configurações da Loja';
  }
  try { localStorage.setItem('du_admin_gallery_config_visible', visible ? '1' : '0'); } catch (_) {}
}
if ($('toggle-gallery-config')) $('toggle-gallery-config').addEventListener('click', () => {
  setGalleryConfigVisible($('toggle-gallery-config').getAttribute('aria-expanded') !== 'true');
});
if ($('header-gallery-config-toggle')) $('header-gallery-config-toggle').addEventListener('click', () => {
  const visible = $('header-gallery-config-toggle').getAttribute('aria-expanded') !== 'true';
  setGalleryConfigVisible(visible);
  if (visible) $('loja-temas')?.scrollIntoView({behavior:'smooth',block:'start'});
});
try { setGalleryConfigVisible(localStorage.getItem('du_admin_gallery_config_visible') !== '0'); }
catch (_) { setGalleryConfigVisible(true); }

async function loadGalleryAdmin() {
  const tbody = $('gallery-table-body');
  if (!tbody) return;
  try {
    const data = await api('/admin-api/du-banner/gallery');
    const items = data.items || [];
    window._cachedGalleryItems = items;
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#64748b;padding:18px;">Nenhum tema/banner cadastrado ainda. Use o formulário acima para adicionar!</td></tr>';
      return;
    }
    const targetBadges = {
      both: '<span style="background:rgba(139,92,246,0.18);border:1px solid rgba(139,92,246,0.35);color:#c4b5fd;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">✨ Ambos</span>',
      banner: '<span style="background:rgba(59,130,246,0.18);border:1px solid rgba(59,130,246,0.35);color:#93c5fd;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">🖼️ Banner</span>',
      avatar: '<span style="background:rgba(34,197,94,0.18);border:1px solid rgba(34,197,94,0.35);color:#86efac;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">👤 Avatar</span>',
      theme: '<span style="background:rgba(245,158,11,0.18);border:1px solid rgba(245,158,11,0.35);color:#fcd34d;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">🎨 Tema</span>'
    };
    tbody.innerHTML = items.map(item => {
      const safeUrl = escapeHtml(item.url || '');
      const safeThumbnail = escapeHtml(item.thumbnail || item.url || '');
      const safeId = escapeHtml(item.id || '');
      const isVid = isDirectVideoUrl(item.url || '');
      const mediaHtml = isVid
        ? `<video src="${safeUrl}" referrerpolicy="no-referrer" autoplay loop muted playsinline style="width:64px;height:38px;object-fit:cover;border-radius:6px;"></video>`
        : `<img src="${safeThumbnail}" referrerpolicy="no-referrer" style="width:64px;height:38px;object-fit:cover;border-radius:6px;" loading="lazy" onerror="this.onerror=null;this.src='https://placehold.co/100x60/1e293b/94a3b8?text=Tema';">`;
      const targetBadge = targetBadges[item.target] || targetBadges.both;
      const owned = !!item.ownerDiscordId;
      const isOfficial = !owned && item.authorName === 'Admin DU';
      const authorName = item.authorName || (owned ? 'Anônimo' : 'Legado');
      const ownerLine = owned
        ? `<strong>${escapeHtml(authorName)}</strong><br><small style="color:#94a3b8;word-break:break-all;">${escapeHtml(item.ownerDiscordId)}</small>`
        : isOfficial
          ? '<strong>Admin DU</strong><br><small style="color:#94a3b8;">Item oficial</small>'
          : '<strong>Item antigo</strong><br><small style="color:#94a3b8;">Sem DCID registrado</small>';
      const visibility = item.visibility === 'private'
        ? '<span style="background:rgba(245,158,11,.16);border:1px solid rgba(245,158,11,.35);color:#fcd34d;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:700;">🔒 Só o dono</span>'
        : '<span style="background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.32);color:#86efac;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:700;">🌐 Comunidade</span>';
      return `
        <tr>
          <td>${mediaHtml}</td>
          <td><strong>${escapeHtml(item.name || 'Sem nome')}</strong>${owned ? '<br><small style="color:#a78bfa;">🔒 Nome protegido</small>' : ''}</td>
          <td>${ownerLine}</td>
          <td>${visibility}</td>
          <td>${targetBadge}</td>
          <td><span style="background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.3);color:#7dd3fc;padding:2px 8px;border-radius:12px;font-size:11px;">${escapeHtml(item.category || 'Geral')}</span></td>
          <td><a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:#a78bfa;font-size:11px;word-break:break-all;">${safeUrl}</a></td>
          <td style="white-space:nowrap;">
            <button onclick="openGalleryEditModal('${safeId}')" class="secondary compact-button" style="padding:4px 8px;font-size:11px;margin-right:4px;">✏️ Moderar</button>
            <button onclick="deleteGalleryItemAdmin('${safeId}')" class="danger compact-button" style="padding:4px 8px;font-size:11px;">Excluir</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:#ef4444;text-align:center;">Falha ao carregar temas da galeria. Verifique o login/servidor.</td></tr>';
  }
}

window.openGalleryEditModal = function(id) {
  const items = window._cachedGalleryItems || [];
  const item = items.find(it => it.id === id);
  if (!item) return;
  if ($('edit-gallery-id')) $('edit-gallery-id').value = item.id;
  if ($('edit-gallery-name')) {
    $('edit-gallery-name').value = item.name || '';
    $('edit-gallery-name').disabled = !!item.ownerDiscordId;
    $('edit-gallery-name').title = item.ownerDiscordId ? 'Somente o dono deste DCID pode alterar o nome.' : '';
  }
  if ($('edit-gallery-owner-note')) {
    $('edit-gallery-owner-note').hidden = !item.ownerDiscordId;
    $('edit-gallery-owner-note').textContent = item.ownerDiscordId
      ? `🔒 O nome pertence a ${item.authorName || 'Anônimo'} (${item.ownerDiscordId}) e só pode ser alterado pelo dono.`
      : '';
  }
  if ($('edit-gallery-target')) $('edit-gallery-target').value = item.target || 'both';
  if ($('edit-gallery-category')) $('edit-gallery-category').value = item.category || 'Geral';
  if ($('edit-gallery-url')) $('edit-gallery-url').value = item.url || '';
  const modal = $('gallery-edit-modal');
  if (modal && typeof modal.showModal === 'function') modal.showModal();
};

window.closeGalleryEditModal = function() {
  const modal = $('gallery-edit-modal');
  if (modal && typeof modal.close === 'function') modal.close();
};

window.saveGalleryEditAdmin = async function() {
  const id = ($('edit-gallery-id') ? $('edit-gallery-id').value : '').trim();
  const name = ($('edit-gallery-name') ? $('edit-gallery-name').value : '').trim();
  const target = ($('edit-gallery-target') ? $('edit-gallery-target').value : 'both') || 'both';
  const category = ($('edit-gallery-category') ? $('edit-gallery-category').value : '').trim() || 'Geral';
  let url = ($('edit-gallery-url') ? $('edit-gallery-url').value : '').trim();
  url = normalizeMediaUrl(url);

  if (!id) { show('ID do item não encontrado.', true); return; }
  if (!name) { show('Informe um nome para o tema.', true); return; }
  if (!url || !url.startsWith('https://')) { show('Informe uma URL HTTPS válida.', true); return; }

  try {
    await api('/admin-api/du-banner/gallery', {
      method: 'POST',
      body: JSON.stringify({ action: 'edit', id, name, target, category, url })
    });
    closeGalleryEditModal();
    show('✅ Tema atualizado com sucesso!');
    await loadGalleryAdmin();
  } catch (e) {
    show('Erro ao salvar alterações: ' + e.message, true);
  }
};

async function addGalleryItemAdmin() {
  const target = ($('gallery-target') ? $('gallery-target').value : 'both') || 'both';
  const name = ($('gallery-name') ? $('gallery-name').value : '').trim();
  const category = ($('gallery-category') ? $('gallery-category').value : '').trim() || 'Geral';
  let url = ($('gallery-url') ? $('gallery-url').value : '').trim();
  url = normalizeMediaUrl(url);

  if (!url) { show('Informe a URL direta do GIF ou vídeo.', true); return; }
  if (/klipy\.com\/gifs\//i.test(url)) {
    show('⚠️ Você colou o link da página do Klipy. Abra a página, clique com o botão direito no GIF e escolha "Copiar endereço da imagem" (começa com https://static.klipy.com/...).', true);
    return;
  }
  if (/tenor\.com\/view\//i.test(url)) {
    show('⚠️ Você colou o link da página do Tenor. Clique com o botão direito sobre o GIF no Tenor e selecione "Copiar endereço da imagem".', true);
    return;
  }
  if (!url.startsWith('https://')) { show('A URL precisa começar com HTTPS://', true); return; }

  try {
    await api('/admin-api/du-banner/gallery', {
      method: 'POST',
      body: JSON.stringify({
        action: 'add',
        name: name || 'Tema DU',
        category: category,
        target: target,
        url: url,
        thumbnail: url
      })
    });
    if ($('gallery-name')) $('gallery-name').value = '';
    if ($('gallery-url')) $('gallery-url').value = '';
    updateAdminGalleryPreview();
    show('✅ Tema cadastrado com sucesso na Loja!');
    await loadGalleryAdmin();
  } catch (e) {
    show('Erro ao cadastrar tema: ' + e.message, true);
  }
}

window.deleteGalleryItemAdmin = async function(id) {
  const item = (window._cachedGalleryItems || []).find(entry => entry.id === id);
  const name = item && item.name ? item.name : 'este item';
  if (!confirm(`Remover "${name}" da loja de temas?`)) return;
  try {
    await api('/admin-api/du-banner/gallery', {
      method: 'POST',
      body: JSON.stringify({ action: 'remove', id })
    });
    show('Tema removido da loja.');
    await loadGalleryAdmin();
  } catch (e) {
    show('Erro ao remover tema: ' + e.message, true);
  }
};

window.normalizeMediaUrl = normalizeMediaUrl;
window.updateAdminGalleryPreview = updateAdminGalleryPreview;
window.loadGalleryAdmin = loadGalleryAdmin;
window.loadGallerySources = loadGallerySources;
window.addGalleryItemAdmin = addGalleryItemAdmin;

if ($('add-gallery-item')) $('add-gallery-item').addEventListener('click', addGalleryItemAdmin);
if ($('refresh-gallery')) $('refresh-gallery').addEventListener('click', () => loadGalleryAdmin().then(() => show('Lista de temas atualizada.')));
if ($('save-gallery-edit')) $('save-gallery-edit').addEventListener('click', saveGalleryEditAdmin);
if ($('cancel-gallery-edit')) $('cancel-gallery-edit').addEventListener('click', closeGalleryEditModal);
if ($('close-gallery-edit-modal')) $('close-gallery-edit-modal').addEventListener('click', closeGalleryEditModal);

const urlInput = $('gallery-url');
if (urlInput) {
  urlInput.addEventListener('input', updateAdminGalleryPreview);
  urlInput.addEventListener('change', updateAdminGalleryPreview);
}
const targetSelect = $('gallery-target');
if (targetSelect) {
  targetSelect.addEventListener('change', updateAdminGalleryPreview);
}
const pasteBtn = $('paste-gallery-url');
if (pasteBtn) {
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        if (urlInput) {
          urlInput.value = text.trim();
          updateAdminGalleryPreview();
          show('📋 Link colado da área de transferência!');
        }
      } else {
        show('A área de transferência está vazia.', true);
      }
    } catch (err) {
      show('Não foi possível ler a área de transferência. Use Ctrl+V no campo.', true);
    }
  });
}

refreshAll();
