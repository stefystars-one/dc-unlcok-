import type { Env, ProfileRow, SessionIdentity } from './types';
import {
  ATTACHMENT_SECONDS, HISTORY_SECONDS, HttpError, MAX_ATTACHMENTS_PER_MESSAGE,
  cleanDisplayName, cleanMessage, error, isAllowedAttachment, json,
  normalizeGofileContentId, normalizeGofileShareUrl, normalizePublicId,
  nowSeconds, randomPublicId, readJson, safeFileName
} from './utils';
import {
  authenticateAdmin, authenticateClient, hmacHex, hwidHash, issueRealtimeTicket, issueSessionToken,
  licenseHash, requireConfiguredSecrets
} from './auth';
import { openRealtimeConnection, publishRealtime } from './realtime';
export { RealtimeHub } from './realtime';

type LicenseRow = { id: string; status: string; max_devices: number; expires_at: number | null };
type DeviceRow = {
  id: string; profile_id: string; license_id: string; status: string; session_version: number
};
type MessageRequestRow = { id: string; sender_id: string; recipient_id: string };

const uuid = (): string => crypto.randomUUID();

async function uniquePublicId(env: Env): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    const candidate = randomPublicId();
    if (!await env.DB.prepare('SELECT 1 FROM profiles WHERE public_id = ?').bind(candidate).first()) {
      return candidate;
    }
  }
  throw new HttpError(503, 'id_generation_failed', 'Não foi possível gerar um DC ID.');
}

async function enforceSessionRateLimit(request: Request, env: Env): Promise<void> {
  const now = nowSeconds();
  const windowSeconds = 15 * 60;
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const bucket = await hmacHex(
    env.IDENTIFIER_PEPPER,
    'auth-rate:' + ip + ':' + Math.floor(now / windowSeconds)
  );
  await env.DB.prepare(
    'INSERT INTO auth_rate_limits (bucket,attempts,expires_at) VALUES (?,1,?) ' +
    'ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1,expires_at=excluded.expires_at'
  ).bind(bucket, now + windowSeconds).run();
  const state = await env.DB.prepare(
    'SELECT attempts FROM auth_rate_limits WHERE bucket=?'
  ).bind(bucket).first();
  const attempts = Number((state as { attempts?: number } | null)?.attempts ?? 0);
  if (attempts > 60) {
    throw new HttpError(429, 'session_rate_limit', 'Muitas tentativas de sessão. Tente novamente depois.');
  }
}
let hwidBansTableReady: Promise<void> | null = null;

async function ensureHwidBansTable(env: Env): Promise<void> {
  if (!hwidBansTableReady) {
    hwidBansTableReady = env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS hwid_bans (' +
      'hwid_hash TEXT PRIMARY KEY,device_id TEXT,reason TEXT NOT NULL DEFAULT \'\',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)'
    ).run().then(() => undefined);
  }
  await hwidBansTableReady;
}
async function openSession(request: Request, env: Env): Promise<Response> {
  requireConfiguredSecrets(env);
  await enforceSessionRateLimit(request, env);
  const body = await readJson<{
    licenseKey?: string; hwid?: string; appVersion?: string; displayName?: string
  }>(request);
  const [keyHash, deviceHash] = await Promise.all([
    licenseHash(env, body.licenseKey),
    hwidHash(env, body.hwid)
  ]);
  const now = nowSeconds();
  await ensureHwidBansTable(env);
  const hwidBan = await env.DB.prepare('SELECT hwid_hash FROM hwid_bans WHERE hwid_hash=?').bind(deviceHash).first<{hwid_hash:string}>();
  if (hwidBan) throw new HttpError(403, 'hwid_banned', 'Este computador foi banido pelo administrador.');
  const license = await env.DB.prepare(
    'SELECT id, status, max_devices, expires_at FROM licenses WHERE key_hash = ?'
  ).bind(keyHash).first<LicenseRow>();
  if (!license || license.status !== 'active' ||
      (license.expires_at !== null && license.expires_at <= now)) {
    throw new HttpError(401, 'license_denied', 'Licença inválida, revogada ou expirada.');
  }

  let device = await env.DB.prepare(
    'SELECT id, profile_id, license_id, status, session_version FROM devices WHERE hwid_hash = ?'
  ).bind(deviceHash).first<DeviceRow>();
  if (device && device.license_id !== license.id) {
    throw new HttpError(409, 'device_bound', 'Dispositivo associado a outra licença.');
  }

  if (!device) {
    const used = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM devices WHERE license_id = ? AND status = 'active'"
    ).bind(license.id).first<{ total: number }>();
    if (Number(used?.total ?? 0) >= license.max_devices) {
      throw new HttpError(403, 'device_limit', 'Limite de dispositivos atingido.');
    }
    const profileId = uuid();
    const deviceId = uuid();
    const publicId = await uniquePublicId(env);
    const name = cleanDisplayName(body.displayName) || 'Usuário ' + publicId.slice(-5);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO profiles (id,public_id,display_name,role,accept_requests,created_at,updated_at) VALUES (?,?,?,?,1,?,?)'
      ).bind(profileId, publicId, name, 'user', now, now),
      env.DB.prepare(
        'INSERT INTO devices (id,profile_id,license_id,hwid_hash,status,session_version,app_version,last_seen_at,created_at) VALUES (?,?,?,?,?,1,?,?,?)'
      ).bind(deviceId, profileId, license.id, deviceHash, 'active',
        String(body.appVersion ?? '').slice(0, 32), now, now)
    ]);
    device = {
      id: deviceId, profile_id: profileId, license_id: license.id,
      status: 'active', session_version: 1
    };
  } else {
    if (device.status !== 'active') throw new HttpError(401, 'device_revoked', 'Dispositivo revogado.');
    await env.DB.prepare('UPDATE devices SET last_seen_at=?, app_version=? WHERE id=?')
      .bind(now, String(body.appVersion ?? '').slice(0, 32), device.id).run();
  }

  const profile = await env.DB.prepare(
    'SELECT id,public_id,display_name,role,accept_requests,created_at,updated_at FROM profiles WHERE id=?'
  ).bind(device.profile_id).first<ProfileRow>();
  if (!profile) throw new HttpError(500, 'profile_missing', 'Perfil não encontrado.');

  const identity: SessionIdentity = {
    profileId: profile.id, deviceId: device.id, publicId: profile.public_id,
    role: profile.role, sessionVersion: device.session_version
  };
  return json({
    ok: true,
    accessToken: await issueSessionToken(env, identity),
    expiresIn: 3600,
    license: {
      expiresAt: license.expires_at,
      maxDevices: license.max_devices
    },
    profile: {
      publicId: profile.public_id, displayName: profile.display_name, role: profile.role,
      acceptRequests: profile.accept_requests === 1
    }
  });
}

async function getMe(identity: SessionIdentity, env: Env): Promise<Response> {
  const profile = await env.DB.prepare(
    'SELECT public_id,display_name,role,accept_requests,created_at FROM profiles WHERE id=?'
  ).bind(identity.profileId).first();
  return json({ ok: true, profile });
}

async function updateMe(request: Request, identity: SessionIdentity, env: Env): Promise<Response> {
  const body = await readJson<{ displayName?: string; acceptRequests?: boolean }>(request);
  const current = await env.DB.prepare(
    'SELECT display_name,accept_requests FROM profiles WHERE id=?'
  ).bind(identity.profileId).first<{ display_name: string; accept_requests: number }>();
  if (!current) throw new HttpError(404, 'profile_not_found', 'Perfil não encontrado.');
  const name = body.displayName === undefined ? current.display_name : cleanDisplayName(body.displayName);
  if (!name) throw new HttpError(400, 'invalid_name', 'Informe um nome válido.');
  const accepts = body.acceptRequests === undefined ? current.accept_requests : (body.acceptRequests ? 1 : 0);
  await env.DB.prepare(
    'UPDATE profiles SET display_name=?,accept_requests=?,updated_at=? WHERE id=?'
  ).bind(name, accepts, nowSeconds(), identity.profileId).run();
  return json({ ok: true, profile: { displayName: name, acceptRequests: accepts === 1 } });
}

async function resetId(identity: SessionIdentity, env: Env): Promise<Response> {
  const publicId = await uniquePublicId(env);
  await env.DB.prepare('UPDATE profiles SET public_id=?,updated_at=? WHERE id=?')
    .bind(publicId, nowSeconds(), identity.profileId).run();
  return json({ ok: true, publicId });
}

async function participant(env: Env, conversationId: string, profileId: string): Promise<void> {
  const row = await env.DB.prepare(
    'SELECT c.status FROM conversations c JOIN conversation_participants p ON p.conversation_id=c.id WHERE c.id=? AND p.profile_id=?'
  ).bind(conversationId, profileId).first<{ status: string }>();
  if (!row) throw new HttpError(404, 'conversation_not_found', 'Conversa não encontrada.');
  if (row.status !== 'open') throw new HttpError(409, 'conversation_closed', 'Conversa encerrada.');
}

async function findConversation(env: Env, a: string, b: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT c.id FROM conversations c " +
    "JOIN conversation_participants a ON a.conversation_id=c.id AND a.profile_id=? " +
    "JOIN conversation_participants b ON b.conversation_id=c.id AND b.profile_id=? " +
    "WHERE c.status='open' ORDER BY c.updated_at DESC LIMIT 1"
  ).bind(a, b).first<{ id: string }>();
  return row?.id ?? null;
}

async function createConversation(
  env: Env, creatorId: string, otherId: string, requestId: string | null = null
): Promise<string> {
  const current = await findConversation(env, creatorId, otherId);
  if (current) return current;
  const id = uuid();
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO conversations (id,created_by,request_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)'
    ).bind(id, creatorId, requestId, 'open', now, now),
    env.DB.prepare(
      'INSERT INTO conversation_participants (conversation_id,profile_id,joined_at,last_read_at) VALUES (?,?,?,0)'
    ).bind(id, creatorId, now),
    env.DB.prepare(
      'INSERT INTO conversation_participants (conversation_id,profile_id,joined_at,last_read_at) VALUES (?,?,?,0)'
    ).bind(id, otherId, now)
  ]);
  return id;
}

async function createRequest(
  request: Request, identity: SessionIdentity, env: Env
): Promise<Response> {
  const body = await readJson<{ recipientPublicId?: string; intro?: string }>(request);
  const target = await env.DB.prepare(
    'SELECT id,public_id,display_name,role,accept_requests,created_at,updated_at FROM profiles WHERE public_id=?'
  ).bind(normalizePublicId(body.recipientPublicId)).first<ProfileRow>();
  if (!target) throw new HttpError(404, 'profile_not_found', 'DC ID não encontrado.');
  if (target.id === identity.profileId) throw new HttpError(400, 'self_request', 'Destino inválido.');

  const blocked = await env.DB.prepare(
    'SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)'
  ).bind(identity.profileId, target.id, target.id, identity.profileId).first();
  if (blocked) throw new HttpError(403, 'request_unavailable', 'Solicitação indisponível.');

  const existing = await findConversation(env, identity.profileId, target.id);
  if (existing) return json({ ok: true, status: 'accepted', conversationId: existing });
  if (identity.role === 'admin') {
    return json({
      ok: true, status: 'accepted',
      conversationId: await createConversation(env, identity.profileId, target.id)
    }, 201);
  }
  if (target.accept_requests !== 1) {
    throw new HttpError(403, 'requests_disabled', 'Este usuário não aceita solicitações.');
  }
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM message_requests WHERE sender_id=? AND created_at>=?'
  ).bind(identity.profileId, nowSeconds() - 86400).first<{ total: number }>();
  if (Number(recent?.total ?? 0) >= 10) {
    throw new HttpError(429, 'request_limit', 'Limite diário de solicitações atingido.');
  }
  const lastRequest = await env.DB.prepare(
    'SELECT created_at FROM message_requests WHERE sender_id=? ORDER BY created_at DESC LIMIT 1'
  ).bind(identity.profileId).first<{ created_at: number }>();
  if (lastRequest && nowSeconds() - Number(lastRequest.created_at) < 60) {
    throw new HttpError(429, 'request_cooldown', 'Aguarde um minuto antes de enviar outra solicitação.');
  }

  const id = uuid();
  try {
    await env.DB.prepare(
      'INSERT INTO message_requests (id,sender_id,recipient_id,status,intro,created_at) VALUES (?,?,?,?,?,?)'
    ).bind(id, identity.profileId, target.id, 'pending',
      cleanMessage(body.intro).slice(0, 300), nowSeconds()).run();
  } catch {
    throw new HttpError(409, 'request_exists', 'Já existe uma solicitação pendente.');
  }
  await publishRealtime(env, [target.id], { type: 'requests_changed' });
  return json({ ok: true, status: 'pending', requestId: id }, 201);
}

async function contactAdmin(request: Request, identity: SessionIdentity, env: Env): Promise<Response> {
  if (identity.role === 'admin') throw new HttpError(400, 'admin_contact', 'A ADM já possui acesso às conversas.');
  const body = await readJson<{ intro?: string }>(request);
  const admin = await ensureAdminProfile(env);
  const existing = await findConversation(env, identity.profileId, admin.id);
  if (existing) return json({ ok: true, conversationId: existing, existing: true });
  const conversationId = await createConversation(env, identity.profileId, admin.id);
  const rawIntro = String(body.intro ?? '').trim();
  const intro = rawIntro ? cleanMessage(rawIntro).slice(0, 300) : '';
  if (intro) {
    const now = nowSeconds();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO messages (id,conversation_id,sender_id,kind,body,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .bind(uuid(), conversationId, identity.profileId, 'text', intro, now, now + HISTORY_SECONDS),
      env.DB.prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(now, conversationId)
    ]);
  }
  await audit(env, identity.profileId, 'admin.contact_requested', conversationId);
  await publishRealtime(env, [admin.id], { type: 'inbox_changed', conversationId });
  return json({ ok: true, conversationId, existing: false }, 201);
}

async function listRequests(identity: SessionIdentity, env: Env): Promise<Response> {
  const incoming = await env.DB.prepare(
    "SELECT r.id,r.intro,r.created_at,p.public_id,p.display_name FROM message_requests r " +
    "JOIN profiles p ON p.id=r.sender_id WHERE r.recipient_id=? AND r.status='pending' " +
    "ORDER BY r.created_at DESC LIMIT 50"
  ).bind(identity.profileId).all();
  const outgoing = await env.DB.prepare(
    'SELECT r.id,r.status,r.intro,r.created_at,p.public_id,p.display_name FROM message_requests r ' +
    'JOIN profiles p ON p.id=r.recipient_id WHERE r.sender_id=? ORDER BY r.created_at DESC LIMIT 50'
  ).bind(identity.profileId).all();
  return json({ ok: true, incoming: incoming.results, outgoing: outgoing.results });
}

async function decideRequest(
  id: string, decision: 'accept' | 'decline' | 'block',
  identity: SessionIdentity, env: Env
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id,sender_id,recipient_id FROM message_requests WHERE id=? AND recipient_id=? AND status='pending'"
  ).bind(id, identity.profileId).first<MessageRequestRow>();
  if (!row) throw new HttpError(404, 'request_not_found', 'Solicitação não encontrada.');
  const now = nowSeconds();

  if (decision === 'accept') {
    const conversationId = await createConversation(env, row.sender_id, row.recipient_id, row.id);
    await env.DB.prepare(
      "UPDATE message_requests SET status='accepted',decided_at=? WHERE id=? AND status='pending'"
    ).bind(now, row.id).run();
    await publishRealtime(env, [row.sender_id, row.recipient_id], { type: 'inbox_changed', conversationId });
    await publishRealtime(env, [row.sender_id, row.recipient_id], { type: 'requests_changed' });
    return json({ ok: true, status: 'accepted', conversationId });
  }
  if (decision === 'block') {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE message_requests SET status='blocked',decided_at=? WHERE id=? AND status='pending'"
      ).bind(now, row.id),
      env.DB.prepare(
        'INSERT OR IGNORE INTO blocks (blocker_id,blocked_id,created_at) VALUES (?,?,?)'
      ).bind(identity.profileId, row.sender_id, now)
    ]);
    await publishRealtime(env, [row.sender_id, row.recipient_id], { type: 'requests_changed' });
    return json({ ok: true, status: 'blocked' });
  }
  await env.DB.prepare(
    "UPDATE message_requests SET status='declined',decided_at=? WHERE id=? AND status='pending'"
  ).bind(now, row.id).run();
  await publishRealtime(env, [row.sender_id, row.recipient_id], { type: 'requests_changed' });
  return json({ ok: true, status: 'declined' });
}

async function listConversations(identity: SessionIdentity, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT c.id,c.status,c.updated_at,o.public_id,o.display_name,o.role," +
    "(SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message," +
    "(SELECT created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message_at," +
    "(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_id<>? AND m.created_at>mine.last_read_at) unread " +
    "FROM conversations c " +
    "JOIN conversation_participants mine ON mine.conversation_id=c.id AND mine.profile_id=? " +
    "JOIN conversation_participants theirs ON theirs.conversation_id=c.id AND theirs.profile_id<>? " +
    "JOIN profiles o ON o.id=theirs.profile_id ORDER BY c.updated_at DESC LIMIT 100"
  ).bind(identity.profileId, identity.profileId, identity.profileId).all();
  return json({ ok: true, conversations: result.results });
}

async function listMessages(
  url: URL, conversationId: string, identity: SessionIdentity, env: Env
): Promise<Response> {
  await participant(env, conversationId, identity.profileId);
  const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
  const messages = await env.DB.prepare(
    'SELECT m.id,m.kind,m.body,m.created_at,p.public_id sender_public_id,' +
    'p.display_name sender_name,p.role sender_role FROM messages m ' +
    'JOIN profiles p ON p.id=m.sender_id ' +
    'WHERE m.conversation_id=? AND m.created_at>? AND m.expires_at>? ' +
    'ORDER BY m.created_at ASC LIMIT 200'
  ).bind(conversationId, after, nowSeconds()).all<Record<string, unknown>>();

  const ids = messages.results.map((item) => String(item.id));
  let files: Record<string, unknown>[] = [];
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    files = (await env.DB.prepare(
      'SELECT id,message_id,provider_content_id,share_url,file_name,mime_type,byte_size,expires_at ' +
      'FROM attachments WHERE message_id IN (' + marks + ") AND status='ready' AND expires_at>?"
    ).bind(...ids, nowSeconds()).all<Record<string, unknown>>()).results;
  }
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const file of files) {
    const key = String(file.message_id);
    const list = grouped.get(key) ?? [];
    list.push(file);
    grouped.set(key, list);
  }
  return json({
    ok: true,
    messages: messages.results.map((item) => ({
      ...item, attachments: grouped.get(String(item.id)) ?? []
    }))
  });
}

async function sendMessage(
  request: Request, conversationId: string, identity: SessionIdentity, env: Env
): Promise<Response> {
  await participant(env, conversationId, identity.profileId);
  const body = await readJson<{ text?: string; attachmentIds?: string[] }>(request);
  const text = cleanMessage(body.text);
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? [...new Set(body.attachmentIds.map(String))].slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    : [];
  if (!text && !attachmentIds.length) {
    throw new HttpError(400, 'empty_message', 'Digite uma mensagem ou adicione um anexo.');
  }

  const recent = await env.DB.prepare(
    'SELECT COUNT(*) total,MAX(created_at) last_created_at FROM messages WHERE sender_id=? AND created_at>=?'
  ).bind(identity.profileId, nowSeconds() - 60).first<{ total: number; last_created_at: number | null }>();
  const userLimit = identity.role === 'admin' ? 30 : 12;
  if (Number(recent?.total ?? 0) >= userLimit) {
    throw new HttpError(429, 'message_limit', 'Muitas mensagens em pouco tempo.');
  }
  if (identity.role !== 'admin' && recent?.last_created_at && nowSeconds() - Number(recent.last_created_at) < 2) {
    throw new HttpError(429, 'message_cooldown', 'Aguarde alguns segundos antes de enviar outra mensagem.');
  }

  if (attachmentIds.length) {
    const marks = attachmentIds.map(() => '?').join(',');
    const found = await env.DB.prepare(
      'SELECT id FROM attachments WHERE id IN (' + marks + ") AND conversation_id=? " +
      "AND uploader_id=? AND status='ready' AND message_id IS NULL AND expires_at>?"
    ).bind(...attachmentIds, conversationId, identity.profileId, nowSeconds()).all();
    if (found.results.length !== attachmentIds.length) {
      throw new HttpError(400, 'invalid_attachment', 'Um ou mais anexos são inválidos.');
    }
  }

  const id = uuid();
  const now = nowSeconds();
  const kind = text && attachmentIds.length ? 'mixed' : attachmentIds.length ? 'file' : 'text';
  const batch = [
    env.DB.prepare(
      'INSERT INTO messages (id,conversation_id,sender_id,kind,body,created_at,expires_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(id, conversationId, identity.profileId, kind, text, now, now + HISTORY_SECONDS),
    env.DB.prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(now, conversationId)
  ];
  for (const attachmentId of attachmentIds) {
    batch.push(env.DB.prepare(
      'UPDATE attachments SET message_id=? WHERE id=? AND message_id IS NULL'
    ).bind(id, attachmentId));
  }
  await env.DB.batch(batch);
  const counterparts = await env.DB.prepare(
    'SELECT profile_id FROM conversation_participants WHERE conversation_id=? AND profile_id<>?'
  ).bind(conversationId, identity.profileId).all<{ profile_id: string }>();
  await publishRealtime(env, counterparts.results.map((row) => row.profile_id), { type: 'inbox_changed', conversationId });
  return json({ ok: true, messageId: id, createdAt: now }, 201);
}

async function markRead(
  conversationId: string, identity: SessionIdentity, env: Env
): Promise<Response> {
  await participant(env, conversationId, identity.profileId);
  const now = nowSeconds();
  await env.DB.prepare(
    'UPDATE conversation_participants SET last_read_at=? WHERE conversation_id=? AND profile_id=?'
  ).bind(now, conversationId, identity.profileId).run();
  return json({ ok: true, readAt: now });
}

function attachmentConfig(env: Env): Response {
  return json({
    ok: true,
    provider: 'gofile',
    uploadUrl: env.GOFILE_UPLOAD_URL || 'https://upload.gofile.io/uploadfile',
    method: 'POST',
    fieldName: 'file',
    maxBytes: 200 * 1024 * 1024,
    expiresAfterSeconds: ATTACHMENT_SECONDS,
    authenticatedUpload: false
  });
}

async function registerAttachment(
  request: Request, identity: SessionIdentity, env: Env
): Promise<Response> {
  const body = await readJson<{
    conversationId?: string; contentId?: string; shareUrl?: string;
    fileName?: string; mimeType?: string; byteSize?: number
  }>(request);
  const conversationId = String(body.conversationId ?? '');
  await participant(env, conversationId, identity.profileId);
  const contentId = normalizeGofileContentId(body.contentId);
  const shareUrl = normalizeGofileShareUrl(body.shareUrl);
  const mime = String(body.mimeType ?? '').toLowerCase();
  const size = Number(body.byteSize ?? 0);
  if (!isAllowedAttachment(mime, size)) {
    throw new HttpError(400, 'attachment_rejected',
      'Aceitamos imagens, áudios e vídeos permitidos de até 200 MB.');
  }

  const recent = await env.DB.prepare(
    'SELECT COUNT(*) total FROM attachments WHERE uploader_id=? AND created_at>=?'
  ).bind(identity.profileId, nowSeconds() - 3600).first<{ total: number }>();
  if (Number(recent?.total ?? 0) >= 20) {
    throw new HttpError(429, 'attachment_limit', 'Limite de anexos por hora atingido.');
  }

  const id = uuid();
  const now = nowSeconds();
  await env.DB.prepare(
    'INSERT INTO attachments ' +
    '(id,conversation_id,uploader_id,message_id,provider,provider_content_id,share_url,' +
    'file_name,mime_type,byte_size,status,created_at,expires_at) ' +
    'VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?)'
  ).bind(id, conversationId, identity.profileId, 'gofile', contentId, shareUrl,
    safeFileName(body.fileName), mime, size, 'ready', now, now + ATTACHMENT_SECONDS).run();
  return json({ ok: true, attachmentId: id, expiresAt: now + ATTACHMENT_SECONDS }, 201);
}

async function ensureAdminProfile(env: Env): Promise<ProfileRow> {
  const current = await env.DB.prepare(
    "SELECT id,public_id,display_name,role,accept_requests,created_at,updated_at " +
    "FROM profiles WHERE role='admin' ORDER BY created_at LIMIT 1"
  ).first<ProfileRow>();
  if (current) return current;
  const now = nowSeconds();
  const profile: ProfileRow = {
    id: uuid(), public_id: await uniquePublicId(env), display_name: 'Stefy Stars • ADM',
    role: 'admin', accept_requests: 0, created_at: now, updated_at: now
  };
  await env.DB.prepare(
    'INSERT INTO profiles (id,public_id,display_name,role,accept_requests,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(profile.id, profile.public_id, profile.display_name, profile.role, 0, now, now).run();
  return profile;
}

async function audit(
  env: Env, actor: string, action: string, target = '', details: unknown = {}
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id,actor,action,target,details,created_at) VALUES (?,?,?,?,?,?)'
  ).bind(uuid(), actor, action, target, JSON.stringify(details).slice(0, 2000), nowSeconds()).run();
}

async function adminOverview(request: Request, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const admin = await ensureAdminProfile(env);
  const stats = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) total FROM profiles'),
    env.DB.prepare("SELECT COUNT(*) total FROM devices WHERE status='active'"),
    env.DB.prepare("SELECT COUNT(*) total FROM message_requests WHERE status='pending'"),
    env.DB.prepare('SELECT COUNT(*) total FROM messages WHERE expires_at>?').bind(nowSeconds())
  ]);
  return json({
    ok: true, actor,
    adminProfile: { publicId: admin.public_id, displayName: admin.display_name },
    totals: {
      profiles: Number((stats[0]?.results[0] as { total?: number } | undefined)?.total ?? 0),
      activeDevices: Number((stats[1]?.results[0] as { total?: number } | undefined)?.total ?? 0),
      pendingRequests: Number((stats[2]?.results[0] as { total?: number } | undefined)?.total ?? 0),
      activeMessages: Number((stats[3]?.results[0] as { total?: number } | undefined)?.total ?? 0)
    }
  });
}

async function adminProfiles(request: Request, url: URL, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  const q = String(url.searchParams.get('q') ?? '').trim().replace(/[%_]/g, '').slice(0, 64);
  const like = '%' + q + '%';
  const result = await env.DB.prepare(
    'SELECT p.public_id,p.display_name,p.role,p.accept_requests,p.created_at,' +
    "(SELECT l.label FROM devices d JOIN licenses l ON l.id=d.license_id WHERE d.profile_id=p.id ORDER BY d.created_at DESC LIMIT 1) license_label," +
    "(SELECT COUNT(*) FROM devices d WHERE d.profile_id=p.id) devices_total," +
    "(SELECT COUNT(*) FROM devices d WHERE d.profile_id=p.id AND d.status='active') active_devices " +
    "FROM profiles p WHERE (?='' OR p.public_id LIKE ? OR p.display_name LIKE ? OR EXISTS (SELECT 1 FROM devices d JOIN licenses l ON l.id=d.license_id WHERE d.profile_id=p.id AND l.label LIKE ?)) " +
    'ORDER BY p.created_at DESC LIMIT 100'
  ).bind(q, like, like, like).all();
  return json({ ok: true, profiles: result.results });
}

async function adminDevices(request: Request, url: URL, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  await ensureBannerTables(env);
  const q = String(url.searchParams.get('q') ?? '').trim().replace(/[%_]/g, '').slice(0, 64);
  const like = '%' + q + '%';
  const rows = await env.DB.prepare(
    'SELECT d.id,d.hwid_hash,d.status,d.app_version,d.last_seen_at,d.created_at,' +
    'p.public_id,p.display_name,l.id license_id,l.label license_label,l.max_devices,b.discord_id discord_id ' +
    'FROM devices d JOIN profiles p ON p.id=d.profile_id JOIN licenses l ON l.id=d.license_id LEFT JOIN du_banners b ON b.license_key_hash=l.key_hash ' +
    "WHERE (?='' OR p.public_id LIKE ? OR p.display_name LIKE ? OR l.label LIKE ? OR d.hwid_hash LIKE ?) " +
    'ORDER BY l.label COLLATE NOCASE,d.last_seen_at DESC LIMIT 250'
  ).bind(q, like, like, like, like).all();
  return json({ ok: true, devices: rows.results });
}

async function adminLicenses(request: Request, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  const rows = await env.DB.prepare(
    'SELECT l.id,l.label,l.status,l.max_devices,l.expires_at,l.created_at,' +
    '(SELECT COUNT(*) FROM devices d WHERE d.license_id=l.id) devices,' +
    '(SELECT p.public_id FROM devices d JOIN profiles p ON p.id=d.profile_id WHERE d.license_id=l.id ORDER BY d.created_at DESC LIMIT 1) profile_public_id,' +
    '(SELECT p.display_name FROM devices d JOIN profiles p ON p.id=d.profile_id WHERE d.license_id=l.id ORDER BY d.created_at DESC LIMIT 1) profile_name ' +
    'FROM licenses l ORDER BY l.created_at DESC LIMIT 100'
  ).all();
  return json({ ok: true, licenses: rows.results });
}

async function adminHistory(request: Request, url: URL, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  const q = String(url.searchParams.get('q') ?? '').trim().replace(/[%_]/g, '').slice(0, 64);
  const like = '%' + q + '%';
  const result = await env.DB.prepare(
    'SELECT c.id,c.updated_at,' +
    "(SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message," +
    "(SELECT created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message_at," +
    "(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) message_count," +
    "(SELECT p.display_name FROM conversation_participants cp JOIN profiles p ON p.id=cp.profile_id WHERE cp.conversation_id=c.id AND p.role<>'admin' ORDER BY cp.joined_at LIMIT 1) counterpart_name," +
    "(SELECT p.public_id FROM conversation_participants cp JOIN profiles p ON p.id=cp.profile_id WHERE cp.conversation_id=c.id AND p.role<>'admin' ORDER BY cp.joined_at LIMIT 1) counterpart_public_id," +
    "(SELECT l.label FROM conversation_participants cp JOIN profiles p ON p.id=cp.profile_id JOIN devices d ON d.profile_id=p.id JOIN licenses l ON l.id=d.license_id WHERE cp.conversation_id=c.id AND p.role<>'admin' ORDER BY d.created_at DESC LIMIT 1) counterpart_license_label," +
    "(SELECT group_concat(p.display_name || ' (' || p.public_id || ')', ' ↔ ') FROM conversation_participants cp JOIN profiles p ON p.id=cp.profile_id WHERE cp.conversation_id=c.id) participants " +
    'FROM conversations c WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id) ' +
    "AND (?='' OR EXISTS (SELECT 1 FROM conversation_participants cp JOIN profiles p ON p.id=cp.profile_id WHERE cp.conversation_id=c.id AND (p.display_name LIKE ? OR p.public_id LIKE ?)) OR EXISTS (SELECT 1 FROM conversation_participants cp JOIN devices d ON d.profile_id=cp.profile_id JOIN licenses l ON l.id=d.license_id WHERE cp.conversation_id=c.id AND l.label LIKE ?)) " +
    'ORDER BY c.updated_at DESC LIMIT 100'
  ).bind(q, like, like, like).all();
  return json({ ok: true, conversations: result.results });
}

async function adminHistoryMessages(request: Request, conversationId: string, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  const messages = await env.DB.prepare(
    'SELECT m.id,m.kind,m.body,m.created_at,m.expires_at,sender.display_name sender_name,sender.public_id sender_public_id,sender.role sender_role ' +
    'FROM messages m JOIN profiles sender ON sender.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.created_at ASC LIMIT 500'
  ).bind(conversationId).all();
  return json({ ok: true, messages: messages.results });
}

async function clearHistory(request: Request, env: Env, conversationId?: string): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const statements: D1PreparedStatement[] = conversationId ? [
    env.DB.prepare('DELETE FROM attachments WHERE conversation_id=?').bind(conversationId),
    env.DB.prepare('DELETE FROM messages WHERE conversation_id=?').bind(conversationId),
    env.DB.prepare('DELETE FROM conversations WHERE id=?').bind(conversationId)
  ] : [
    env.DB.prepare('DELETE FROM attachments'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM conversations')
  ];
  await env.DB.batch(statements);
  await audit(env, actor, conversationId ? 'history.clear_conversation' : 'history.clear_all', conversationId ?? 'all');
  return json({ ok: true });
}
async function updateLicense(request: Request, id: string, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const body = await readJson<{
    label?: string; maxDevices?: number; expiresAt?: number | null; status?: 'active' | 'revoked'; licenseKey?: string
  }>(request);
  const current = await env.DB.prepare(
    'SELECT id,status,max_devices,expires_at FROM licenses WHERE id=?'
  ).bind(id).first<{ id: string; status: string; max_devices: number; expires_at: number | null }>();
  if (!current) throw new HttpError(404, 'license_not_found', 'Licença não encontrada.');

  const maxDevices = Math.max(1, Math.min(20, Number(body.maxDevices ?? current.max_devices) || 1));
  const expiresAt = body.expiresAt === null ? null :
    (body.expiresAt === undefined ? current.expires_at : Number(body.expiresAt));
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= nowSeconds() + 60)) {
    throw new HttpError(400, 'invalid_expiration', 'A expiração precisa estar pelo menos um minuto no futuro.');
  }
  const status = body.status === 'revoked' ? 'revoked' : 'active';
  const activeDevices = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM devices WHERE license_id=? AND status='active'"
  ).bind(id).first<{ total: number }>();
  if (maxDevices < Number(activeDevices?.total ?? 0)) {
    throw new HttpError(409, 'device_limit_below_active', 'Revogue dispositivos antes de reduzir o limite desta licença.');
  }

  const replacementKey = String(body.licenseKey ?? '').trim();
  if (replacementKey && !/^DU-[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3}$/i.test(replacementKey)) {
    throw new HttpError(400, 'invalid_license_key', 'A nova chave tem um formato inválido.');
  }
  try {
    if (replacementKey) {
      await env.DB.prepare(
        'UPDATE licenses SET key_hash=?,label=?,status=?,max_devices=?,expires_at=? WHERE id=?'
      ).bind(await licenseHash(env, replacementKey), String(body.label ?? '').slice(0, 80), status, maxDevices, expiresAt, id).run();
    } else {
      await env.DB.prepare(
        'UPDATE licenses SET label=?,status=?,max_devices=?,expires_at=? WHERE id=?'
      ).bind(String(body.label ?? '').slice(0, 80), status, maxDevices, expiresAt, id).run();
    }
  } catch {
    throw new HttpError(409, 'license_exists', 'Esta chave já está cadastrada.');
  }
  if (status === 'revoked') {
    await env.DB.prepare('UPDATE devices SET session_version=session_version+1 WHERE license_id=?').bind(id).run();
  }
  await audit(env, actor, 'license.update', id, { status, maxDevices, expiresAt, keyReplaced: Boolean(replacementKey) });
  return json({ ok: true });
}
async function deleteRevokedLicense(request: Request, id: string, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const license = await env.DB.prepare('SELECT status FROM licenses WHERE id=?').bind(id)
    .first<{ status: string }>();
  if (!license) throw new HttpError(404, 'license_not_found', 'Licença não encontrada.');
  if (license.status !== 'revoked') throw new HttpError(409, 'license_not_revoked', 'Revogue a licença antes de apagá-la.');
  const devices = await env.DB.prepare('SELECT COUNT(*) total FROM devices WHERE license_id=?').bind(id)
    .first<{ total: number }>();
  if (Number(devices?.total ?? 0) !== 0) {
    throw new HttpError(409, 'license_has_devices', 'Remova os perfis revogados vinculados antes de apagar esta licença.');
  }
  await env.DB.prepare('DELETE FROM licenses WHERE id=?').bind(id).run();
  await audit(env, actor, 'license.delete_revoked', id);
  return json({ ok: true });
}
async function revokeLicense(request: Request, id: string, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const result = await env.DB.prepare(
    "UPDATE licenses SET status='revoked' WHERE id=?"
  ).bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'license_not_found', 'Licença não encontrada.');
  await env.DB.prepare(
    'UPDATE devices SET session_version=session_version+1 WHERE license_id=?'
  ).bind(id).run();
  await audit(env, actor, 'license.revoke', id);
  return json({ ok: true });
}
async function createLicense(request: Request, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  requireConfiguredSecrets(env);
  await enforceSessionRateLimit(request, env);
  const body = await readJson<{
    licenseKey?: string; label?: string; maxDevices?: number; expiresAt?: number | null
  }>(request);
  const keyHash = await licenseHash(env, body.licenseKey);
  const maxDevices = Math.max(1, Math.min(20, Number(body.maxDevices ?? 1) || 1));
  const expiresAt = body.expiresAt == null ? null :
    Math.max(nowSeconds() + 60, Number(body.expiresAt));
  const id = uuid();
  try {
    await env.DB.prepare(
      'INSERT INTO licenses (id,key_hash,label,status,max_devices,expires_at,created_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(id, keyHash, String(body.label ?? '').slice(0, 80), 'active',
      maxDevices, expiresAt, nowSeconds()).run();
  } catch {
    throw new HttpError(409, 'license_exists', 'Esta licença já está cadastrada.');
  }
  await audit(env, actor, 'license.create', id, { maxDevices, expiresAt });
  return json({ ok: true, licenseId: id }, 201);
}

async function deleteProfile(request: Request, publicId: string, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const normalized = normalizePublicId(publicId);
  const profile = await env.DB.prepare('SELECT id,role FROM profiles WHERE public_id=?').bind(normalized)
    .first<{ id: string; role: string }>();
  if (!profile) throw new HttpError(404, 'profile_not_found', 'Usuário não encontrado.');
  if (profile.role === 'admin') throw new HttpError(403, 'admin_protected', 'A conta administrativa não pode ser apagada.');

  const state = await env.DB.prepare(
    "SELECT COUNT(*) total, SUM(CASE WHEN status='revoked' THEN 1 ELSE 0 END) revoked " +
    'FROM devices WHERE profile_id=?'
  ).bind(profile.id).first<{ total: number; revoked: number | null }>();
  const total = Number(state?.total ?? 0);
  const revoked = Number(state?.revoked ?? 0);
  if (total === 0 || total !== revoked) {
    throw new HttpError(409, 'profile_not_revoked', 'Somente perfis com todos os dispositivos revogados podem ser apagados.');
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM attachments WHERE conversation_id IN (SELECT conversation_id FROM conversation_participants WHERE profile_id=?)').bind(profile.id),
    env.DB.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT conversation_id FROM conversation_participants WHERE profile_id=?)').bind(profile.id),
    env.DB.prepare('DELETE FROM conversations WHERE id IN (SELECT conversation_id FROM conversation_participants WHERE profile_id=?)').bind(profile.id),
    env.DB.prepare('DELETE FROM profiles WHERE id=?').bind(profile.id)
  ];
  await env.DB.batch(statements);
  await audit(env, actor, 'profile.delete_revoked', normalized, { revokedDevices: revoked });
  return json({ ok: true });
}
async function promote(request: Request, publicId: string, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const normalized = normalizePublicId(publicId);
  const result = await env.DB.prepare(
    "UPDATE profiles SET role='admin',updated_at=? WHERE public_id=?"
  ).bind(nowSeconds(), normalized).run();
  if (!result.meta.changes) throw new HttpError(404, 'profile_not_found', 'Perfil não encontrado.');
  await audit(env, actor, 'profile.promote', normalized);
  return json({ ok: true });
}

async function adminMessage(request: Request, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const body = await readJson<{ recipientPublicId?: string; text?: string }>(request);
  const text = cleanMessage(body.text);
  if (!text) throw new HttpError(400, 'empty_message', 'Digite a mensagem.');
  const target = await env.DB.prepare(
    'SELECT id,public_id,display_name,role,accept_requests,created_at,updated_at FROM profiles WHERE public_id=?'
  ).bind(normalizePublicId(body.recipientPublicId)).first<ProfileRow>();
  if (!target) throw new HttpError(404, 'profile_not_found', 'DC ID não encontrado.');
  const admin = await ensureAdminProfile(env);
  if (target.id === admin.id) throw new HttpError(400, 'self_message', 'Destino inválido.');
  const conversationId = await createConversation(env, admin.id, target.id);
  const messageId = uuid();
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO messages (id,conversation_id,sender_id,kind,body,created_at,expires_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(messageId, conversationId, admin.id, 'text', text, now, now + HISTORY_SECONDS),
    env.DB.prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(now, conversationId)
  ]);
  await audit(env, actor, 'admin.message', target.public_id, { conversationId, messageId });
  await publishRealtime(env, [target.id], { type: 'inbox_changed', conversationId });
  return json({ ok: true, conversationId, messageId }, 201);
}

async function banDevice(request: Request, id: string, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  await ensureHwidBansTable(env);
  const device = await env.DB.prepare('SELECT id,hwid_hash FROM devices WHERE id=?').bind(id)
    .first<{id:string;hwid_hash:string}>();
  if (!device) throw new HttpError(404, 'device_not_found', 'Dispositivo não encontrado.');
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET status='revoked',session_version=session_version+1 WHERE id=?").bind(id),
    env.DB.prepare('INSERT INTO hwid_bans(hwid_hash,device_id,reason,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(hwid_hash) DO UPDATE SET device_id=excluded.device_id,updated_at=excluded.updated_at')
      .bind(device.hwid_hash, id, 'Banido pelo painel ADM', now, now)
  ]);
  await audit(env, actor, 'hwid.ban', id, { hwid: device.hwid_hash });
  return json({ ok: true, status: 'banned' });
}

async function unbanDevice(request: Request, id: string, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  await ensureHwidBansTable(env);
  const device = await env.DB.prepare('SELECT d.id,d.hwid_hash,d.license_id,l.status license_status,l.max_devices FROM devices d JOIN licenses l ON l.id=d.license_id WHERE d.id=?')
    .bind(id).first<{id:string;hwid_hash:string;license_id:string;license_status:string;max_devices:number}>();
  if (!device) throw new HttpError(404, 'device_not_found', 'Dispositivo não encontrado.');
  if (device.license_status !== 'active') throw new HttpError(409, 'license_not_active', 'Reative a chave antes de reativar este computador.');
  const used = await env.DB.prepare("SELECT COUNT(*) total FROM devices WHERE license_id=? AND status='active' AND id<>?")
    .bind(device.license_id, id).first<{total:number}>();
  if (Number(used?.total ?? 0) >= Number(device.max_devices)) throw new HttpError(409, 'device_limit', 'O limite da chave já está ocupado por outros computadores ativos.');
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET status='active',session_version=session_version+1 WHERE id=?").bind(id),
    env.DB.prepare('DELETE FROM hwid_bans WHERE hwid_hash=?').bind(device.hwid_hash)
  ]);
  await audit(env, actor, 'hwid.unban', id, { hwid: device.hwid_hash });
  return json({ ok: true, status: 'active' });
}

async function banRawHwid(request: Request, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const body = await readJson<{hwid?:string;reason?:string}>(request);
  const rawHwid = String(body.hwid || '').trim();
  if (!rawHwid || rawHwid.length > 512) throw new HttpError(400, 'invalid_hwid', 'Informe um HWID válido.');
  await ensureHwidBansTable(env);
  const hash = await hwidHash(env, rawHwid);
  const device = await env.DB.prepare('SELECT id FROM devices WHERE hwid_hash=?').bind(hash).first<{id:string}>();
  const now = nowSeconds();
  const reason = String(body.reason || 'Banido manualmente pelo painel ADM').trim().slice(0, 160) || 'Banido manualmente pelo painel ADM';
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO hwid_bans(hwid_hash,device_id,reason,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(hwid_hash) DO UPDATE SET device_id=excluded.device_id,reason=excluded.reason,updated_at=excluded.updated_at')
      .bind(hash, device?.id || null, reason, now, now)
  ];
  if (device?.id) statements.push(env.DB.prepare("UPDATE devices SET status='revoked',session_version=session_version+1 WHERE id=?").bind(device.id));
  await env.DB.batch(statements);
  await audit(env, actor, 'hwid.ban_manual', device?.id || 'unseen', { hwid: hash, reason });
  return json({ ok: true, matchedDevice: !!device });
}

async function unbanRawHwid(request: Request, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const body = await readJson<{hwid?:string}>(request);
  const rawHwid = String(body.hwid || '').trim();
  if (!rawHwid || rawHwid.length > 512) throw new HttpError(400, 'invalid_hwid', 'Informe um HWID válido.');
  await ensureHwidBansTable(env);
  const hash = await hwidHash(env, rawHwid);
  const ban = await env.DB.prepare('SELECT device_id FROM hwid_bans WHERE hwid_hash=?').bind(hash).first<{device_id:string|null}>();
  if (!ban) throw new HttpError(404, 'hwid_not_banned', 'Este HWID não está banido.');
  await env.DB.prepare('DELETE FROM hwid_bans WHERE hwid_hash=?').bind(hash).run();
  await audit(env, actor, 'hwid.unban_manual', ban.device_id || 'unseen', { hwid: hash });
  return json({ ok: true, matchedDevice: !!ban.device_id });
}
const MOTD_SETTING_KEY = 'motd';
const MOTD_REFRESH_SETTING_KEY = 'motd_refresh_minutes';
const MESSAGE_REFRESH_SETTING_KEY = 'message_refresh_seconds';

function cleanMotd(value: unknown): string {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new HttpError(400, 'invalid_motd', 'Digite uma mensagem do dia.');
  if (text.length > 4000) throw new HttpError(400, 'motd_too_long', 'A mensagem do dia suporta até 4.000 caracteres.');
  return text;
}

let settingsTableReady: Promise<void> | null = null;

async function ensureSettingsTable(env: Env): Promise<void> {
  if (!settingsTableReady) {
    settingsTableReady = env.DB.prepare('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')
      .run().then(() => undefined);
  }
  await settingsTableReady;
}

async function resolveMotd(request: Request, env: Env): Promise<string> {
  await ensureSettingsTable(env);
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(MOTD_SETTING_KEY).first<{ value: string }>();
  if (row?.value) return row.value;
  const fallback = await env.ASSETS.fetch(new Request(new URL('/updates/motd.txt', request.url)));
  return fallback.ok ? (await fallback.text()).trim() : 'Discord Unlock pronto para jogar.';
}

function clampTiming(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
async function timingSettings(env: Env): Promise<{ motdRefreshMinutes: number; messageRefreshSeconds: number }> {
  await ensureSettingsTable(env);
  const rows = await env.DB.prepare('SELECT key,value FROM app_settings WHERE key IN (?,?)')
    .bind(MOTD_REFRESH_SETTING_KEY, MESSAGE_REFRESH_SETTING_KEY).all<{ key: string; value: string }>();
  const values = new Map(rows.results.map((row) => [row.key, row.value]));
  return {
    motdRefreshMinutes: clampTiming(values.get(MOTD_REFRESH_SETTING_KEY), 60, 30, 1440),
    messageRefreshSeconds: clampTiming(values.get(MESSAGE_REFRESH_SETTING_KEY), 60, 30, 900)
  };
}
async function publicMotd(request: Request, env: Env): Promise<Response> {
  const motd = await resolveMotd(request, env);
  return new Response(motd, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function clientConfig(request: Request, env: Env): Promise<Response> {
  return json({ ok: true, motd: await resolveMotd(request, env), ...(await timingSettings(env)) });
}

async function adminGetMotd(request: Request, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  return json({ ok: true, motd: await resolveMotd(request, env) });
}

async function adminGetTimings(request: Request, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  return json({ ok: true, ...(await timingSettings(env)) });
}
async function adminUpdateTimings(request: Request, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const body = await readJson<{ motdRefreshMinutes?: number; messageRefreshSeconds?: number }>(request);
  const motdRefreshMinutes = clampTiming(body.motdRefreshMinutes, 60, 30, 1440);
  const messageRefreshSeconds = clampTiming(body.messageRefreshSeconds, 60, 30, 900);
  await ensureSettingsTable(env);
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .bind(MOTD_REFRESH_SETTING_KEY, String(motdRefreshMinutes), now),
    env.DB.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .bind(MESSAGE_REFRESH_SETTING_KEY, String(messageRefreshSeconds), now)
  ]);
  await audit(env, actor, 'timings.update', 'client_refresh', { motdRefreshMinutes, messageRefreshSeconds });
  await publishRealtime(env, null, { type: 'config_update', motdRefreshMinutes, messageRefreshSeconds });
  return json({ ok: true, motdRefreshMinutes, messageRefreshSeconds });
}
async function adminUpdateMotd(request: Request, env: Env): Promise<Response> {
  const actor = await authenticateAdmin(request, env);
  const body = await readJson<{ motd?: string }>(request);
  const motd = cleanMotd(body.motd);
  await ensureSettingsTable(env);
  await env.DB.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .bind(MOTD_SETTING_KEY, motd, nowSeconds()).run();
  await audit(env, actor, 'motd.update', MOTD_SETTING_KEY, { length: motd.length });
  await publishRealtime(env, null, { type: 'motd_update', motd });
  return json({ ok: true, motd });
}
type SupportTicketRow = { id: string; access_hash: string; profile_id: string; conversation_id: string };

async function ensureSupportTicketsTable(env: Env): Promise<void> {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS support_tickets (' +
    'id TEXT PRIMARY KEY,access_hash TEXT NOT NULL,profile_id TEXT NOT NULL UNIQUE,' +
    'conversation_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)'
  ).run();
}

function supportMessages(env: Env, conversationId: string) {
  return env.DB.prepare(
    'SELECT m.id,m.kind,m.body,m.created_at,p.public_id sender_public_id,p.display_name sender_name,p.role sender_role ' +
    'FROM messages m JOIN profiles p ON p.id=m.sender_id ' +
    'WHERE m.conversation_id=? AND m.expires_at>? ORDER BY m.created_at ASC LIMIT 100'
  ).bind(conversationId, nowSeconds()).all<Record<string, unknown>>();
}

async function supportTicket(url: URL, env: Env): Promise<SupportTicketRow> {
  const match = url.pathname.match(/^\/v1\/support\/([0-9a-f-]+)$/);
  const ticketId = match?.[1] ?? '';
  const accessCode = String(url.searchParams.get('code') ?? '').trim();
  if (!ticketId || !/^[0-9a-f-]{36}$/i.test(ticketId) || !/^[a-f0-9]{16}$/i.test(accessCode)) {
    throw new HttpError(400, 'invalid_support_ticket', 'Código de suporte inválido.');
  }
  await ensureSupportTicketsTable(env);
  const ticket = await env.DB.prepare(
    'SELECT id,access_hash,profile_id,conversation_id FROM support_tickets WHERE id=?'
  ).bind(ticketId).first<SupportTicketRow>();
  if (!ticket || ticket.access_hash !== await hmacHex(env.IDENTIFIER_PEPPER, 'support:' + accessCode)) {
    throw new HttpError(404, 'support_ticket_not_found', 'Conversa de suporte não encontrada neste computador.');
  }
  return ticket;
}

async function createGuestSupport(request: Request, env: Env): Promise<Response> {
  requireConfiguredSecrets(env);
  await enforceSessionRateLimit(request, env);
  const body = await readJson<{ name?: string; text?: string }>(request);
  const text = cleanMessage(body.text);
  if (!text) throw new HttpError(400, 'empty_message', 'Descreva sua dúvida para a ADM.');
  const name = cleanDisplayName(body.name) || 'Visitante';
  await ensureSupportTicketsTable(env);
  const profileId = uuid();
  const ticketId = uuid();
  const accessCode = crypto.getRandomValues(new Uint8Array(8));
  const code = [...accessCode].map((item) => item.toString(16).padStart(2, '0')).join('');
  const now = nowSeconds();
  await env.DB.prepare(
    'INSERT INTO profiles (id,public_id,display_name,role,accept_requests,created_at,updated_at) VALUES (?,?,?,?,0,?,?)'
  ).bind(profileId, await uniquePublicId(env), 'Suporte: ' + name.slice(0, 50), 'guest', now, now).run();
  const conversationId = await createConversation(env, profileId, (await ensureAdminProfile(env)).id);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO support_tickets (id,access_hash,profile_id,conversation_id,created_at,updated_at) VALUES (?,?,?,?,?,?)'
    ).bind(ticketId, await hmacHex(env.IDENTIFIER_PEPPER, 'support:' + code), profileId, conversationId, now, now),
    env.DB.prepare(
      'INSERT INTO messages (id,conversation_id,sender_id,kind,body,created_at,expires_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(uuid(), conversationId, profileId, 'text', text, now, now + HISTORY_SECONDS),
    env.DB.prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(now, conversationId)
  ]);
  await audit(env, profileId, 'support.guest_created', ticketId);
  return json({ ok: true, ticketId, accessCode: code, messages: (await supportMessages(env, conversationId)).results }, 201);
}

async function readGuestSupport(url: URL, env: Env): Promise<Response> {
  const ticket = await supportTicket(url, env);
  return json({ ok: true, ticketId: ticket.id, messages: (await supportMessages(env, ticket.conversation_id)).results });
}

async function sendGuestSupport(request: Request, url: URL, env: Env): Promise<Response> {
  const ticket = await supportTicket(url, env);
  const body = await readJson<{ text?: string }>(request);
  const text = cleanMessage(body.text);
  if (!text) throw new HttpError(400, 'empty_message', 'Digite uma mensagem.');
  const now = nowSeconds();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) total,MAX(created_at) last_created_at FROM messages WHERE sender_id=? AND created_at>=?'
  ).bind(ticket.profile_id, now - 60).first<{ total: number; last_created_at: number | null }>();
  if (Number(recent?.total ?? 0) >= 12 || (recent?.last_created_at && now - Number(recent.last_created_at) < 3)) {
    throw new HttpError(429, 'message_cooldown', 'Aguarde alguns segundos antes de enviar outra mensagem.');
  }
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO messages (id,conversation_id,sender_id,kind,body,created_at,expires_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(uuid(), ticket.conversation_id, ticket.profile_id, 'text', text, now, now + HISTORY_SECONDS),
    env.DB.prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(now, ticket.conversation_id),
    env.DB.prepare('UPDATE support_tickets SET updated_at=? WHERE id=?').bind(now, ticket.id)
  ]);
  return json({ ok: true, messages: (await supportMessages(env, ticket.conversation_id)).results });
}
// ─────────────────────────────────────────────────────────────────────────────
// DU BANNER SYSTEM
// GET  /du-banner/css          → CSS com todos os banners (injetado no Discord)
// GET  /du-banner/:discordId   → banner de um usuário
// POST /du-banner              → cadastrar/atualizar banner (requer licença)
// DELETE /du-banner            → remover próprio banner (requer licença)
// GET  /du-banner/gallery      → galeria curada de GIFs (pública)
// POST /admin-api/du-banner/gallery → gerenciar galeria (admin)
// ─────────────────────────────────────────────────────────────────────────────

const BANNER_URL_MAX = 4096;
const BANNER_DISCORD_ID_RE = /^\d{17,21}$/;

function duYouTubeVideoId(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let id = '';
    if (['youtube.com','www.youtube.com','m.youtube.com'].includes(host) && url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    else if (['youtube.com','www.youtube.com'].includes(host) && url.pathname.startsWith('/shorts/')) id = url.pathname.split('/').filter(Boolean)[1] || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  } catch { return ''; }
}

function isDuIpBoundMediaUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return /(^|\.)googlevideo\.com$/.test(host) && /\/videoplayback$/i.test(url.pathname);
}

function isExpiredDuMediaUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (/(^|\.)discordapp\.(com|net)$/.test(host) && url.searchParams.has('ex')) {
    const expires = parseInt(url.searchParams.get('ex') || '', 16);
    return Number.isFinite(expires) && expires <= nowSeconds();
  }
  const expires = Number(url.searchParams.get('expire') || url.searchParams.get('expires') || 0);
  return Number.isFinite(expires) && expires > 0 && expires <= nowSeconds();
}

function duGalleryMediaInfo(value: string): { available:boolean; key:string; thumbnail:string } {
  try {
    const url = new URL(value);
    const youtubeId = duYouTubeVideoId(value);
    if (youtubeId) return { available:true, key:'youtube:' + youtubeId, thumbnail:'https://i.ytimg.com/vi/' + youtubeId + '/hqdefault.jpg' };
    url.hash = '';
    return { available:!isDuIpBoundMediaUrl(url) && !isExpiredDuMediaUrl(url), key:url.href, thumbnail:'' };
  } catch { return { available:false, key:'', thumbnail:'' }; }
}

function normalizeDuMediaUrl(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_media', 'URL inválida.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new HttpError(400, 'invalid_media', 'URL inválida.'); }
  url.hash = '';
  const youtubeId = duYouTubeVideoId(url.href);
  if (youtubeId) return 'https://i.ytimg.com/vi/' + youtubeId + '/hqdefault.jpg';
  if (isExpiredDuMediaUrl(url)) throw new HttpError(400, 'expired_media', 'Este link expirou. Use uma URL permanente da mídia.');
  if (isDuIpBoundMediaUrl(url) || (/(^|\.)discordapp\.(com|net)$/.test(url.hostname) && url.searchParams.has('ex')))
    throw new HttpError(400, 'temporary_media', 'Este link é temporário. Use uma URL permanente ou escolha a mídia diretamente na Loja DU.');
  return url.href;
}

// Gallery entries can be images, GIFs or direct video files. The host allowlist
// and HTTPS requirement remain the same for every media type.
async function isSafeMediaUrl(raw: string, env: Env): Promise<boolean> {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    if (isDuIpBoundMediaUrl(u) || isExpiredDuMediaUrl(u) || (/(^|\.)discordapp\.(com|net)$/.test(u.hostname) && u.searchParams.has('ex'))) return false;
    const h = u.hostname.toLowerCase();
    // CDNs essenciais do Discord e dos hosts que o app já usava como armazenamento.
    if (['discordapp.com','discordapp.net','postimg.cc','catbox.moe','pinimg.com','ibb.co','ytimg.com','youtube.com','youtu.be','youtube-nocookie.com'].some(d => h === d || h.endsWith('.' + d))) return true;
    // Os demais hosts podem ser geridos no painel ADM e valem para o domínio e subdomínios.
    const sources = await env.DB.prepare('SELECT domain FROM du_gallery_sources WHERE enabled = 1').all<{domain:string}>();
    return sources.results.some(row => h === row.domain || h.endsWith('.' + row.domain));
  } catch { return false; }
}

async function ensureBannerTables(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS du_banners (
      discord_id TEXT PRIMARY KEY,
      banner_url TEXT NOT NULL,
      avatar_url TEXT,
      customization_json TEXT NOT NULL DEFAULT '{}',
      license_key_hash TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS du_banner_gallery (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbnail TEXT,
      category TEXT NOT NULL DEFAULT 'Geral',
      target TEXT NOT NULL DEFAULT 'both',
      owner_discord_id TEXT,
      owner_license_key_hash TEXT,
      author_name TEXT NOT NULL DEFAULT 'Anônimo',
      visibility TEXT NOT NULL DEFAULT 'community',
      added_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS du_gallery_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      added_at INTEGER NOT NULL
    )`)
  ]);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS du_banner_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  await env.DB.prepare("INSERT OR IGNORE INTO du_banner_settings (key,value) VALUES ('store_enabled','true'),('klipy_enabled','false'),('klipy_app_key','')").run();
  const sourcesSeeded = await env.DB.prepare("SELECT value FROM du_banner_settings WHERE key='sources_seeded'").first<{value:string}>();
  if (!sourcesSeeded) {
    await env.DB.batch([
      ...[['KLIPY','klipy.com'],['GIPHY','giphy.com'],['Tenor','tenor.com'],['Imgur','imgur.com']]
        .map(([name,domain]) => env.DB.prepare('INSERT OR IGNORE INTO du_gallery_sources(id,name,domain,enabled,added_at) VALUES(?,?,?,1,?)').bind('builtin-' + domain,name,domain,nowSeconds())),
      env.DB.prepare("INSERT INTO du_banner_settings(key,value) VALUES('sources_seeded','true')")
    ]);
  }
  try {
    await env.DB.prepare('ALTER TABLE du_banners ADD COLUMN avatar_url TEXT').run();
  } catch(e) {}
  try {
    await env.DB.prepare("ALTER TABLE du_banners ADD COLUMN customization_json TEXT NOT NULL DEFAULT '{}'").run();
  } catch(e) {}
  for (const column of ['banner_visibility', 'avatar_visibility']) {
    try {
      await env.DB.prepare("ALTER TABLE du_banners ADD COLUMN " + column + " TEXT NOT NULL DEFAULT 'community'").run();
    } catch (_) {}
  }
  try {
    await env.DB.prepare("ALTER TABLE du_banner_gallery ADD COLUMN target TEXT NOT NULL DEFAULT 'both'").run();
  } catch(e) {}
  try {
    await env.DB.prepare('ALTER TABLE du_banner_gallery ADD COLUMN owner_discord_id TEXT').run();
  } catch(e) {}
  try {
    await env.DB.prepare('ALTER TABLE du_banner_gallery ADD COLUMN owner_license_key_hash TEXT').run();
  } catch(e) {}
  try {
    await env.DB.prepare("ALTER TABLE du_banner_gallery ADD COLUMN author_name TEXT NOT NULL DEFAULT 'Anônimo'").run();
  } catch(e) {}
  try {
    await env.DB.prepare("ALTER TABLE du_banner_gallery ADD COLUMN visibility TEXT NOT NULL DEFAULT 'community'").run();
  } catch(e) {}
  // A migração de privacidade precisa rodar depois de ambas as tabelas terem as
  // colunas novas. Fora do ALTER, ela também conclui uma migração interrompida.
  for (const [column, mediaColumn] of [['banner_visibility', 'banner_url'], ['avatar_visibility', 'avatar_url']]) {
    try {
      await env.DB.prepare("UPDATE du_banners SET " + column + "='private' WHERE EXISTS (SELECT 1 FROM du_banner_gallery g WHERE g.owner_discord_id=du_banners.discord_id AND g.url=du_banners." + mediaColumn + " AND g.visibility='private')").run();
    } catch (_) {}
  }
  // A comunidade tem um único cartão por URL. Itens privados continuam
  // isolados por dono e podem usar a mesma URL sem vazar para a comunidade.
  try {
    await env.DB.prepare('DROP INDEX IF EXISTS idx_du_gallery_owner_url').run();
    await env.DB.prepare(
      `DELETE FROM du_banner_gallery
       WHERE COALESCE(visibility,'community')='community'
         AND rowid NOT IN (
           SELECT MIN(rowid) FROM du_banner_gallery
           WHERE COALESCE(visibility,'community')='community'
           GROUP BY url
         )`
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_du_gallery_community_url
       ON du_banner_gallery(url) WHERE COALESCE(visibility,'community')='community'`
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_du_gallery_owner_url_visibility
       ON du_banner_gallery(owner_discord_id, url, visibility)
       WHERE owner_discord_id IS NOT NULL`
    ).run();
  } catch(e) {}
}
async function getDuBannerCss(env: Env): Promise<Response> {
  await ensureBannerTables(env);
  const rows = await env.DB.prepare(
    "SELECT discord_id, CASE WHEN banner_visibility='private' THEN '' ELSE banner_url END AS banner_url, CASE WHEN avatar_visibility='private' THEN '' ELSE avatar_url END AS avatar_url FROM du_banners ORDER BY updated_at DESC LIMIT 5000"
  ).all<{ discord_id: string; banner_url: string; avatar_url: string | null }>();
  let css = '/* DiscordUnlock DU Banner & Avatar — auto-generated */\n';
  for (const row of rows.results) {
    if (row.banner_url) {
      const safeUrl = row.banner_url.replace(/"/g, '%22');
      // Discord muda as classes e nem sempre expõe data-user-id. :has() ancora
      // o banner no avatar nativo da pessoa, mantendo o banner visível a toda a rede.
      const profileRoot = `:is([class*="userProfileOuter_"],[class*="userProfileModal_"],[class*="userPopout_"],[class*="user-profile-popout"],[class*="user-profile-modal"],[class*="profileHeader_"]):has(img[src*="/avatars/${row.discord_id}/"],img[src*="/users/${row.discord_id}/avatars/"])`;
      css += `[data-userid="${row.discord_id}"] [class*="profileBanner"],` +
             `[data-userid="${row.discord_id}"] [class*="banner-"],` +
             `[data-userid="${row.discord_id}"] [class*="banner_"],` +
             `[data-user-id="${row.discord_id}"] [class*="profileBanner"],` +
             `[data-user-id="${row.discord_id}"] [class*="banner-"],` +
             `[data-user-id="${row.discord_id}"] [class*="banner_"],` +
             `[data-user-id="${row.discord_id}"] [class*="bannerPremium_"],` +
             `${profileRoot} [class*="profileBanner"],${profileRoot} [class*="banner-"],${profileRoot} [class*="banner_"],${profileRoot} [class*="banner"]{` +
             `background-image:url("${safeUrl}") !important;` +
             `background-size:cover !important;background-position:center !important;}\n`;
    }    if (row.avatar_url) {
      const safeAvatar = row.avatar_url.replace(/"/g, '%22');
      css += `img[src*="/avatars/${row.discord_id}/"],img[src*="/users/${row.discord_id}/avatars/"],` +
             `[data-user-id="${row.discord_id}"] img[class*="avatar_"],` +
             `[data-user-id="${row.discord_id}"] img[class*="avatar-"],` +
             `[data-userid="${row.discord_id}"] img[class*="avatar_"],` +
             `[data-userid="${row.discord_id}"] img[class*="avatar-"]{` +
             `content:url("${safeAvatar}") !important;` +
             `object-fit:cover !important;}\n`;
    }
  }
  return new Response(css, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

async function getDuBannerForUser(discordId: string, env: Env): Promise<Response> {
  if (!BANNER_DISCORD_ID_RE.test(discordId)) throw new HttpError(400, 'invalid_discord_id', 'ID Discord inválido.');
  await ensureBannerTables(env);
  const row = await env.DB.prepare(
    "SELECT CASE WHEN banner_visibility='private' THEN '' ELSE banner_url END AS banner_url, CASE WHEN avatar_visibility='private' THEN '' ELSE avatar_url END AS avatar_url, updated_at FROM du_banners WHERE discord_id = ?"
  ).bind(discordId).first<{ banner_url: string; avatar_url: string | null; updated_at: number }>();
  if (!row) throw new HttpError(404, 'not_found', 'Perfil não cadastrado.');
  return json({ ok: true, discordId, url: row.banner_url, bannerUrl: row.banner_url, avatarUrl: row.avatar_url || '', updatedAt: row.updated_at });
}

function sanitizeDuCustomizations(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const clean = (input: unknown) => {
    const text = typeof input === 'string' ? input.trim() : '';
    return /^[A-Za-z0-9_-]{1,160}$/.test(text) ? text : '';
  };
  const result: Record<string, unknown> = {};
  const avatar = source.avatarDecoration as Record<string, unknown> | undefined;
  const avatarAsset = clean(avatar?.asset);
  if (avatarAsset) result.avatarDecoration = { asset: avatarAsset, skuId: clean(avatar?.skuId) || '1' };
  const effect = source.profileEffect as Record<string, unknown> | undefined;
  const effectId = clean(effect?.id) || clean(effect?.skuId);
  if (effectId) result.profileEffect = { id: effectId, skuId: clean(effect?.skuId) || effectId };
  const frame = source.profileFrame as Record<string, unknown> | undefined;
  const frameSku = clean(frame?.skuId);
  if (frameSku) result.profileFrame = { skuId: frameSku };
  const nameplate = source.nameplate as Record<string, unknown> | undefined;
  const nameplateSku = clean(nameplate?.skuId);
  if (nameplateSku) result.nameplate = { skuId: nameplateSku };
  const banner = source.banner as Record<string, unknown> | undefined;
  const bannerAsset = clean(banner?.asset);
  if (bannerAsset) result.banner = { asset: bannerAsset, skuId: clean(banner?.skuId) || '1' };
  return result;
}

async function getDuNetworkCustomizations(env: Env): Promise<Response> {
  await ensureBannerTables(env);
  const rows = await env.DB.prepare("SELECT discord_id, customization_json FROM du_banners WHERE customization_json IS NOT NULL AND customization_json <> '{}' ORDER BY updated_at DESC LIMIT 5000").all<{discord_id:string; customization_json:string}>();
  const items = rows.results.map(row => {
    let value: unknown = {};
    try { value = JSON.parse(row.customization_json); } catch (_) {}
    return { discordId: row.discord_id, customizations: sanitizeDuCustomizations(value) };
  }).filter(item => Object.keys(item.customizations).length > 0);
  return json({ ok: true, items });
}
async function registerDuBanner(request: Request, env: Env): Promise<Response> {
  requireConfiguredSecrets(env);
  const body = await readJson<{
    discordId?: string; bannerUrl?: string; avatarUrl?: string; licenseKey?: string;
    gifName?: string; authorName?: string; shareWithCommunity?: boolean; customizations?: unknown; clearCustomizations?: boolean; syncOnly?: boolean
  }>(request);
  if (!body.discordId || !BANNER_DISCORD_ID_RE.test(body.discordId))
    throw new HttpError(400, 'invalid_discord_id', 'ID Discord inválido (17-21 dígitos numéricos).');
  
  const hasBanner = Object.prototype.hasOwnProperty.call(body, 'bannerUrl');
  const hasAvatar = Object.prototype.hasOwnProperty.call(body, 'avatarUrl');
  const hasCustomizations = Object.prototype.hasOwnProperty.call(body, 'customizations') || body.clearCustomizations === true;
  const bannerUrl = normalizeDuMediaUrl(body.bannerUrl);
  const avatarUrl = normalizeDuMediaUrl(body.avatarUrl);
  const customizations = sanitizeDuCustomizations(body.customizations);
  const customizationsJson = JSON.stringify(customizations);
  const clearCustomizations = body.clearCustomizations === true;

  if (!hasBanner && !hasAvatar && !hasCustomizations)
    throw new HttpError(400, 'missing_media', 'Preencha uma mídia ou aplique um visual da Loja para sincronizar.');

  if (bannerUrl) {
    await ensureBannerTables(env);
    if (!await isSafeMediaUrl(bannerUrl, env))
      throw new HttpError(400, 'invalid_banner_url', 'URL do banner inválida. Use HTTPS direto para GIF/PNG/JPG de um CDN reconhecido.');
    if (bannerUrl.length > BANNER_URL_MAX)
      throw new HttpError(400, 'url_too_long', 'URL do banner muito longa (máx. 4096 chars).');
  }

  if (avatarUrl) {
    await ensureBannerTables(env);
    if (!await isSafeMediaUrl(avatarUrl, env))
      throw new HttpError(400, 'invalid_avatar_url', 'URL do avatar inválida. Use HTTPS direto para GIF/PNG/JPG de um CDN reconhecido.');
    if (avatarUrl.length > BANNER_URL_MAX)
      throw new HttpError(400, 'url_too_long', 'URL do avatar muito longa (máx. 4096 chars).');
  }

  if (!body.licenseKey)
    throw new HttpError(401, 'no_license', 'Chave de licença obrigatória.');
  const keyHash = await licenseHash(env, body.licenseKey);
  const now = nowSeconds();
  const license = await env.DB.prepare(
    'SELECT id, status, expires_at FROM licenses WHERE key_hash = ?'
  ).bind(keyHash).first<LicenseRow>();
  if (!license || license.status !== 'active' || (license.expires_at !== null && license.expires_at <= now))
    throw new HttpError(401, 'license_denied', 'Licença inválida, revogada ou expirada.');
  await ensureBannerTables(env);
  const saved = await env.DB.prepare(
    'INSERT INTO du_banners (discord_id,banner_url,avatar_url,customization_json,license_key_hash,registered_at,updated_at,banner_visibility,avatar_visibility) VALUES (?,?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(discord_id) DO UPDATE SET ' +
    'banner_url=CASE WHEN ? THEN excluded.banner_url ELSE du_banners.banner_url END,' +
    'avatar_url=CASE WHEN ? THEN excluded.avatar_url ELSE du_banners.avatar_url END,' +
    'customization_json=CASE WHEN ? THEN excluded.customization_json ELSE du_banners.customization_json END,' +
    'banner_visibility=CASE WHEN ? THEN excluded.banner_visibility ELSE du_banners.banner_visibility END,' +
    'avatar_visibility=CASE WHEN ? THEN excluded.avatar_visibility ELSE du_banners.avatar_visibility END,' +
    'updated_at=MAX(du_banners.updated_at+1,excluded.updated_at) WHERE du_banners.license_key_hash=excluded.license_key_hash'
  ).bind(body.discordId, bannerUrl, avatarUrl || null, clearCustomizations ? '{}' : customizationsJson, keyHash, now, now,
    body.shareWithCommunity === false ? 'private' : 'community', body.shareWithCommunity === false ? 'private' : 'community',
    hasBanner ? 1 : 0, hasAvatar ? 1 : 0, hasCustomizations ? 1 : 0,
    hasBanner && typeof body.shareWithCommunity === 'boolean' ? 1 : 0,
    hasAvatar && typeof body.shareWithCommunity === 'boolean' ? 1 : 0).run();
  if (!saved.meta.changes) throw new HttpError(403, 'forbidden', 'Sem permissão para alterar este perfil.');

  const galleryName = String(body.gifName || '').trim().slice(0, 80) || 'GIF da Comunidade';
  const authorName = String(body.authorName || '').trim().slice(0, 60) || 'Anônimo';
  const visibility = body.shareWithCommunity === false ? 'private' : 'community';

  // URL comunitária é globalmente única. Reenviar a mesma mídia para a
  // comunidade só atualiza o perfil do usuário, sem criar outro cartão.
  // Privados são únicos apenas por dono e nunca entram no catálogo público.
  try {
    const mediaUrls = body.syncOnly ? [] : [...new Set([bannerUrl, avatarUrl].filter(Boolean))];
    for (const mediaUrl of mediaUrls) {
      if (visibility === 'community') {
        const published = await env.DB.prepare(
          "SELECT id FROM du_banner_gallery WHERE url=? AND COALESCE(visibility,'community')='community' LIMIT 1"
        ).bind(mediaUrl).first<{id:string}>();
        if (published) continue;
        await env.DB.prepare(
          'INSERT INTO du_banner_gallery (id,name,url,thumbnail,category,target,added_at,owner_discord_id,owner_license_key_hash,author_name,visibility) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
        ).bind(crypto.randomUUID(), galleryName, mediaUrl, mediaUrl, 'Comunidade', 'both', now,
          body.discordId, keyHash, authorName, 'community').run();
      } else {
        await env.DB.prepare("DELETE FROM du_banner_gallery WHERE url=? AND owner_discord_id=? AND visibility='community'").bind(mediaUrl,body.discordId).run();
        const privateItem = await env.DB.prepare(
          "SELECT id FROM du_banner_gallery WHERE url=? AND owner_discord_id=? AND COALESCE(visibility,'community')='private' LIMIT 1"
        ).bind(mediaUrl, body.discordId).first<{id:string}>();
        if (privateItem) {
          await env.DB.prepare(
            'UPDATE du_banner_gallery SET name=?,thumbnail=?,category=?,target=?,author_name=?,owner_license_key_hash=? WHERE id=?'
          ).bind(galleryName, mediaUrl, 'Comunidade', 'both', authorName, keyHash, privateItem.id).run();
        } else {
          await env.DB.prepare(
            'INSERT INTO du_banner_gallery (id,name,url,thumbnail,category,target,added_at,owner_discord_id,owner_license_key_hash,author_name,visibility) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
          ).bind(crypto.randomUUID(), galleryName, mediaUrl, mediaUrl, 'Comunidade', 'both', now,
            body.discordId, keyHash, authorName, 'private').run();
        }
      }
    }
  } catch(e) {}
  await publishRealtime(env, null, { type: 'du_profile_changed', discordId: body.discordId });
  const galleryMessage = body.syncOnly ? 'Os campos locais foram sincronizados sem criar cartões na galeria.' : visibility === 'community'
    ? 'O GIF também foi compartilhado com a comunidade.'
    : 'O GIF ficou privado e só aparece para você.';
  return json({ ok: true, message: 'Perfil atualizado com sucesso! ' + galleryMessage });
}

async function deleteDuBanner(request: Request, env: Env): Promise<Response> {
  requireConfiguredSecrets(env);
  const body = await readJson<{ discordId?: string; licenseKey?: string }>(request);
  if (!body.discordId || !BANNER_DISCORD_ID_RE.test(body.discordId))
    throw new HttpError(400, 'invalid_discord_id', 'ID Discord inválido.');
  if (!body.licenseKey) throw new HttpError(401, 'no_license', 'Licença obrigatória.');
  const keyHash = await licenseHash(env, body.licenseKey);
  await ensureBannerTables(env);
  const row = await env.DB.prepare(
    'SELECT license_key_hash, banner_url, avatar_url FROM du_banners WHERE discord_id = ?'
  ).bind(body.discordId).first<{ license_key_hash: string; banner_url:string; avatar_url:string|null }>();
  if (!row) throw new HttpError(404, 'not_found', 'Banner não encontrado.');
  if (row.license_key_hash !== keyHash) throw new HttpError(403, 'forbidden', 'Sem permissão para remover este banner.');
  await env.DB.batch([
    env.DB.prepare("UPDATE du_banners SET banner_url='',avatar_url=NULL,updated_at=MAX(updated_at+1,?) WHERE discord_id=?").bind(nowSeconds(),body.discordId),
    env.DB.prepare('DELETE FROM du_banner_gallery WHERE owner_discord_id = ?').bind(body.discordId),
    env.DB.prepare("DELETE FROM du_banner_gallery WHERE owner_discord_id IS NULL AND name IN ('Banner da Comunidade DU','Avatar da Comunidade DU') AND url IN (?,?) AND NOT EXISTS (SELECT 1 FROM du_banners b WHERE b.discord_id <> ? AND (b.banner_url = du_banner_gallery.url OR b.avatar_url = du_banner_gallery.url))")
      .bind(row.banner_url, row.avatar_url || '', body.discordId)
  ]);
  await publishRealtime(env, null, { type: 'du_profile_changed', discordId: body.discordId, removed: true });
  return json({ ok: true, message: 'Banner e avatar removidos do perfil e da galeria da comunidade.' });
}

async function getDuBannerSettings(env: Env): Promise<{storeEnabled:boolean; klipyEnabled:boolean; klipyAppKey:string}> {
  await ensureBannerTables(env);
  const rows = await env.DB.prepare("SELECT key,value FROM du_banner_settings WHERE key IN ('store_enabled','klipy_enabled','klipy_app_key')").all<{key:string;value:string}>();
  const values = new Map(rows.results.map(row => [row.key, row.value]));
  const appKey = values.get('klipy_app_key') || '';
  return { storeEnabled: values.get('store_enabled') !== 'false', klipyEnabled: values.get('klipy_enabled') === 'true' && !!appKey, klipyAppKey: appKey };
}

async function proxyDuKlipy(url: URL, env: Env): Promise<Response> {
  const settings = await getDuBannerSettings(env);
  if (!settings.klipyEnabled || !settings.klipyAppKey) throw new HttpError(503, 'klipy_unavailable', 'Busca KLIPY indisponível no momento.');
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
  const limit = Math.max(1, Math.min(48, Number(url.searchParams.get('limit') || 24) || 24));
  const params = new URLSearchParams({ key: settings.klipyAppKey, limit: String(limit), contentfilter: 'medium', media_filter: 'gif,tinygif,mp4,tinymp4', locale: 'pt_BR' });
  const endpoint = query ? '/v2/search' : '/v2/featured';
  if (query) params.set('q', query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch('https://api.klipy.com' + endpoint + '?' + params.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(502, 'klipy_error', String((payload as {message?:string}).message || 'KLIPY retornou HTTP ' + response.status));
    return json(payload, 200);
  } catch (cause) {
    if (cause instanceof HttpError) throw cause;
    throw new HttpError(502, 'klipy_error', 'Não foi possível consultar o KLIPY agora.');
  } finally { clearTimeout(timeout); }
}
async function publicDuBannerSettings(env: Env): Promise<Response> {
  const settings = await getDuBannerSettings(env);
  // A chave fica somente no Worker; o cliente recebe apenas a disponibilidade.
  return json({ ok:true, storeEnabled:settings.storeEnabled, klipyEnabled:settings.klipyEnabled });
}

async function adminDuBannerSettings(request: Request, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  if (request.method === 'GET') return json({ ok:true, ...(await getDuBannerSettings(env)) });
  const body = await readJson<{storeEnabled?:boolean;klipyEnabled?:boolean;klipyAppKey?:string}>(request);
  const appKey = (body.klipyAppKey || '').trim().slice(0,120);
  const storeEnabled = body.storeEnabled !== false;
  const klipyEnabled = body.klipyEnabled === true && !!appKey;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO du_banner_settings(key,value) VALUES('store_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(storeEnabled ? 'true' : 'false'),
    env.DB.prepare("INSERT INTO du_banner_settings(key,value) VALUES('klipy_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(klipyEnabled ? 'true' : 'false'),
    env.DB.prepare("INSERT INTO du_banner_settings(key,value) VALUES('klipy_app_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(appKey)
  ]);
  return json({ok:true,storeEnabled,klipyEnabled,klipyAppKey:appKey});
}

async function adminDuGallerySources(request: Request, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  await ensureBannerTables(env);
  if (request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id,name,domain,enabled,added_at FROM du_gallery_sources ORDER BY name COLLATE NOCASE').all();
    return json({ok:true,items:rows.results});
  }
  const body = await readJson<{name?:string;domain?:string}> (request);
  const name = String(body.name || '').trim().slice(0,60);
  let domain = String(body.domain || '').trim().toLowerCase();
  try {
    const parsed = new URL(domain.includes('://') ? domain : 'https://' + domain);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid');
    domain = parsed.hostname;
  } catch { throw new HttpError(400,'invalid_source_domain','Informe somente o domínio HTTPS do site (ex.: exemplo.com).'); }
  if (!name || domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))
    throw new HttpError(400,'invalid_source','Nome ou domínio inválido.');
  await env.DB.prepare('INSERT INTO du_gallery_sources(id,name,domain,enabled,added_at) VALUES(?,?,?,1,?) ON CONFLICT(domain) DO UPDATE SET name=excluded.name,enabled=1').bind(uuid(),name,domain,nowSeconds()).run();
  return json({ok:true,items:(await env.DB.prepare('SELECT id,name,domain,enabled,added_at FROM du_gallery_sources ORDER BY name COLLATE NOCASE').all()).results});
}

async function adminDuGallerySourceDelete(request: Request, env: Env, id: string): Promise<Response> {
  await authenticateAdmin(request, env);
  await ensureBannerTables(env);
  await env.DB.prepare('DELETE FROM du_gallery_sources WHERE id=?').bind(id).run();
  return json({ok:true});
}

async function authorizeGalleryOwner(discordId: string, licenseKey: string, env: Env): Promise<string> {
  requireConfiguredSecrets(env);
  if (!BANNER_DISCORD_ID_RE.test(discordId))
    throw new HttpError(400, 'invalid_discord_id', 'ID Discord inválido.');
  if (!licenseKey) throw new HttpError(401, 'no_license', 'Licença obrigatória.');
  const keyHash = await licenseHash(env, licenseKey);
  const license = await env.DB.prepare(
    'SELECT id,status,expires_at FROM licenses WHERE key_hash=?'
  ).bind(keyHash).first<LicenseRow>();
  const now = nowSeconds();
  if (!license || license.status !== 'active' || (license.expires_at !== null && license.expires_at <= now))
    throw new HttpError(401, 'license_denied', 'Licença inválida, revogada ou expirada.');
  return keyHash;
}

async function getDuBannerGallery(
  env: Env,
  ownerDiscordId = '',
  ownerKeyHash = '',
  includePrivate = false
): Promise<Response> {
  await ensureBannerTables(env);
  const settings = await getDuBannerSettings(env);
  if (!settings.storeEnabled && !includePrivate) return json({ ok: true, storeEnabled: false, items: [] });
  const fields = "id,name,url,thumbnail,category,COALESCE(target,'both') AS target," +
    "owner_discord_id,COALESCE(author_name,'Anônimo') AS author_name," +
    "COALESCE(visibility,'community') AS visibility,owner_license_key_hash";
  const query = includePrivate
    ? `SELECT ${fields} FROM du_banner_gallery ORDER BY category,name LIMIT 500`
    : ownerDiscordId
      ? `SELECT ${fields} FROM du_banner_gallery WHERE COALESCE(visibility,'community')='community' OR owner_discord_id=? ORDER BY category,name LIMIT 500`
      : `SELECT ${fields} FROM du_banner_gallery WHERE COALESCE(visibility,'community')='community' ORDER BY category,name LIMIT 500`;
  const statement = env.DB.prepare(query);
  const rows = ownerDiscordId && !includePrivate
    ? await statement.bind(ownerDiscordId).all<any>()
    : await statement.all<any>();
  const seen = new Set<string>();
  const items = [];
  for (const row of rows.results) {
    const media = duGalleryMediaInfo(String(row.url || ''));
    if (!includePrivate && (!media.available || !media.key || seen.has(media.key))) continue;
    if (!includePrivate) seen.add(media.key);
    items.push({
      id: row.id,
      name: row.name,
      url: row.url,
      thumbnail: media.thumbnail || row.thumbnail,
      category: row.category,
      target: row.target,
      ownerDiscordId: row.owner_discord_id || '',
      authorName: row.author_name || 'Anônimo',
      visibility: row.visibility || 'community',
      canEdit: !!ownerDiscordId && row.owner_discord_id === ownerDiscordId &&
        !!ownerKeyHash && row.owner_license_key_hash === ownerKeyHash
    });
  }
  return json({ ok: true, storeEnabled: true, items }, 200);
}

async function getOwnedDuBannerGallery(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{discordId?:string;licenseKey?:string}>(request);
  const discordId = String(body.discordId || '').trim();
  const keyHash = await authorizeGalleryOwner(discordId, String(body.licenseKey || ''), env);
  return getDuBannerGallery(env, discordId, keyHash);
}

async function adminDuBannerGallery(request: Request, env: Env): Promise<Response> {
  await authenticateAdmin(request, env);
  await ensureBannerTables(env);
  const body = await readJson<{
    action?: string; id?: string; name?: string; url?: string;
    thumbnail?: string; category?: string; target?: string;
  }>(request);
  if (body.action === 'add') {
    if (!body.url || !await isSafeMediaUrl(body.url, env))
      throw new HttpError(400, 'invalid_url', 'URL inválida.');
    const id = crypto.randomUUID();
    const validTargets = ['banner', 'avatar', 'both', 'theme'];
    const target = validTargets.includes(body.target || '') ? (body.target as string) : 'both';
    await env.DB.prepare(
      "INSERT INTO du_banner_gallery (id,name,url,thumbnail,category,target,added_at,author_name,visibility) VALUES (?,?,?,?,?,?,?,'Admin DU','community')"
    ).bind(id, body.name ?? 'Sem nome', body.url, body.thumbnail ?? body.url, body.category ?? 'Geral', target, nowSeconds()).run();
    return json({ ok: true, id });
  }
  if (body.action === 'edit' || body.action === 'update') {
    if (!body.id) throw new HttpError(400, 'missing_id', 'id obrigatório.');
    const existing = await env.DB.prepare('SELECT id, name, category, target, url, owner_discord_id FROM du_banner_gallery WHERE id = ?').bind(body.id).first<{
      id: string; name: string; category: string; target: string; url: string; owner_discord_id: string|null;
    }>();
    if (!existing) throw new HttpError(404, 'not_found', 'Item não encontrado.');
    const validTargets = ['banner', 'avatar', 'both', 'theme'];
    // Itens enviados pela comunidade só podem ser renomeados pelo próprio dono autenticado.
    // O painel administrativo continua podendo moderar categoria, destino, URL e exclusão.
    const newName = existing.owner_discord_id
      ? existing.name
      : ((body.name !== undefined ? body.name.trim() : existing.name) || 'Sem nome');
    const newCat = (body.category !== undefined ? body.category.trim() : existing.category) || 'Geral';
    const newTarget = (body.target && validTargets.includes(body.target)) ? body.target : existing.target;
    const newUrl = (body.url && await isSafeMediaUrl(body.url, env)) ? body.url.trim() : existing.url;
    await env.DB.prepare(
      'UPDATE du_banner_gallery SET name = ?, category = ?, target = ?, url = ?, thumbnail = ? WHERE id = ?'
    ).bind(newName, newCat, newTarget, newUrl, newUrl, body.id).run();
    return json({ ok: true, id: body.id, name: newName, nameLocked: !!existing.owner_discord_id, category: newCat, target: newTarget, url: newUrl });
  }
  if (body.action === 'remove') {
    if (!body.id) throw new HttpError(400, 'missing_id', 'id obrigatório.');
    await env.DB.prepare('DELETE FROM du_banner_gallery WHERE id = ?').bind(body.id).run();
    return json({ ok: true });
  }
  if (body.action === 'admin_delete_user') {
    if (!body.id || !BANNER_DISCORD_ID_RE.test(body.id))
      throw new HttpError(400, 'invalid_id', 'ID Discord inválido.');
    await env.DB.prepare('DELETE FROM du_banners WHERE discord_id = ?').bind(body.id).run();
    return json({ ok: true });
  }
  throw new HttpError(400, 'invalid_action', 'Ação inválida. Use: add, edit, remove, admin_delete_user.');
}

async function renameDuBannerGalleryItem(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ id?: string; name?: string; discordId?:string; licenseKey?:string }>(request);
  if (!body.id) throw new HttpError(400, 'missing_id', 'id obrigatório.');
  const newName = (body.name || '').trim().slice(0, 80);
  if (!newName) throw new HttpError(400, 'invalid_name', 'Nome não pode ser vazio.');
  await ensureBannerTables(env);
  const discordId = String(body.discordId || '').trim();
  const keyHash = await authorizeGalleryOwner(discordId, String(body.licenseKey || ''), env);
  const item = await env.DB.prepare(
    'SELECT owner_discord_id,owner_license_key_hash FROM du_banner_gallery WHERE id=?'
  ).bind(body.id).first<{owner_discord_id:string|null;owner_license_key_hash:string|null}>();
  if (!item) throw new HttpError(404, 'not_found', 'GIF não encontrado.');
  if (item.owner_discord_id !== discordId || !item.owner_license_key_hash || item.owner_license_key_hash !== keyHash)
    throw new HttpError(403, 'forbidden', 'Somente o dono marcado pelo DCID pode alterar este nome.');
  await env.DB.prepare(
    'UPDATE du_banner_gallery SET name = ? WHERE id = ?'
  ).bind(newName, body.id).run();
  return json({ ok: true, id: body.id, name: newName });
}

async function clientRoutes(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === '/v1/motd' && request.method === 'GET') return publicMotd(request, env);
  if (url.pathname === '/v1/client-config' && request.method === 'GET') return clientConfig(request, env);
  if (url.pathname === '/v1/support/guest' && request.method === 'POST') return createGuestSupport(request, env);
  if (/^\/v1\/support\/[0-9a-f-]+$/i.test(url.pathname) && request.method === 'GET') return readGuestSupport(url, env);
  if (/^\/v1\/support\/[0-9a-f-]+$/i.test(url.pathname) && request.method === 'POST') return sendGuestSupport(request, url, env);
  if (url.pathname === '/v1/session' && request.method === 'POST') {
    return openSession(request, env);
  }
  if (url.pathname === '/v1/realtime' && request.method === 'GET') return openRealtimeConnection(request, url, env);
  const who = await authenticateClient(request, env);
  if (url.pathname === '/v1/realtime-ticket' && request.method === 'POST') {
    return json({ ok: true, ticket: await issueRealtimeTicket(env, who) });
  }
  if (url.pathname === '/v1/me' && request.method === 'GET') return getMe(who, env);
  if (url.pathname === '/v1/me' && request.method === 'PATCH') return updateMe(request, who, env);
  if (url.pathname === '/v1/me/public-id/reset' && request.method === 'POST') return resetId(who, env);
  if (url.pathname === '/v1/requests' && request.method === 'GET') return listRequests(who, env);
  if (url.pathname === '/v1/requests' && request.method === 'POST') return createRequest(request, who, env);
  if (url.pathname === '/v1/admin-contact' && request.method === 'POST') return contactAdmin(request, who, env);
  if (url.pathname === '/v1/conversations' && request.method === 'GET') return listConversations(who, env);
  if (url.pathname === '/v1/attachments/config' && request.method === 'GET') return attachmentConfig(env);
  if (url.pathname === '/v1/attachments/register' && request.method === 'POST') {
    return registerAttachment(request, who, env);
  }

  let match = url.pathname.match(/^\/v1\/requests\/([0-9a-f-]+)\/(accept|decline|block)$/);
  if (match && request.method === 'POST') {
    return decideRequest(match[1]!, match[2] as 'accept' | 'decline' | 'block', who, env);
  }
  match = url.pathname.match(/^\/v1\/conversations\/([0-9a-f-]+)\/messages$/);
  if (match && request.method === 'GET') return listMessages(url, match[1]!, who, env);
  if (match && request.method === 'POST') return sendMessage(request, match[1]!, who, env);
  match = url.pathname.match(/^\/v1\/conversations\/([0-9a-f-]+)\/read$/);
  if (match && request.method === 'POST') return markRead(match[1]!, who, env);
  throw new HttpError(404, 'not_found', 'Rota não encontrada.');
}

async function adminRoutes(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === '/admin-api/overview' && request.method === 'GET') {
    return adminOverview(request, env);
  }
  if (url.pathname === '/admin-api/motd' && request.method === 'GET') return adminGetMotd(request, env);
  if (url.pathname === '/admin-api/motd' && request.method === 'PUT') return adminUpdateMotd(request, env);
  if (url.pathname === '/admin-api/timings' && request.method === 'GET') return adminGetTimings(request, env);
  if (url.pathname === '/admin-api/timings' && request.method === 'PUT') return adminUpdateTimings(request, env);
  if (url.pathname === '/admin-api/profiles' && request.method === 'GET') {
    return adminProfiles(request, url, env);
  }
  if (url.pathname === '/admin-api/licenses' && request.method === 'GET') {
    return adminLicenses(request, env);
  }  if (url.pathname === '/admin-api/history' && request.method === 'GET') {
    return adminHistory(request, url, env);
  }  if (url.pathname === '/admin-api/history' && request.method === 'DELETE') {
    return clearHistory(request, env);
  }
  if (url.pathname === '/admin-api/licenses' && request.method === 'POST') {
    return createLicense(request, env);
  }
  if (url.pathname === '/admin-api/devices' && request.method === 'GET') {
    return adminDevices(request, url, env);
  }
  if (url.pathname === '/admin-api/conversations' && request.method === 'POST') {
    return adminMessage(request, env);
  }
  let match = url.pathname.match(/^\/admin-api\/history\/([0-9a-f-]+)$/);
  if (match && request.method === 'GET') return adminHistoryMessages(request, match[1]!, env);
  if (match && request.method === 'DELETE') return clearHistory(request, env, match[1]!);
  match = url.pathname.match(/^\/admin-api\/profiles\/([^/]+)$/);
  if (match && request.method === 'DELETE') return deleteProfile(request, match[1]!, env);
  match = url.pathname.match(/^\/admin-api\/profiles\/([^/]+)\/promote$/);
  if (match && request.method === 'POST') return promote(request, match[1]!, env);
  if (url.pathname === '/admin-api/hwid-bans' && request.method === 'POST') return banRawHwid(request, env);
  if (url.pathname === '/admin-api/hwid-bans' && request.method === 'DELETE') return unbanRawHwid(request, env);
  match = url.pathname.match(/^\/admin-api\/devices\/([0-9a-f-]+)\/ban$/);
  if (match && request.method === 'POST') return banDevice(request, match[1]!, env);
  match = url.pathname.match(/^\/admin-api\/devices\/([0-9a-f-]+)\/unban$/);
  if (match && request.method === 'POST') return unbanDevice(request, match[1]!, env);
  // Mantém compatibilidade com o painel anterior: "revogar" agora aplica banimento por HWID.
  match = url.pathname.match(/^\/admin-api\/devices\/([0-9a-f-]+)\/revoke$/);
  if (match && request.method === 'POST') return banDevice(request, match[1]!, env);
  match = url.pathname.match(/^\/admin-api\/licenses\/([0-9a-f-]+)$/);
  if (match && request.method === 'PATCH') return updateLicense(request, match[1]!, env);
  if (match && request.method === 'DELETE') return deleteRevokedLicense(request, match[1]!, env);
  match = url.pathname.match(/^\/admin-api\/licenses\/([0-9a-f-]+)\/revoke$/);
  if (match && request.method === 'POST') return revokeLicense(request, match[1]!, env);
  if (url.pathname === '/admin-api/du-banner/settings' && (request.method === 'GET' || request.method === 'PUT')) return adminDuBannerSettings(request, env);
  if (url.pathname === '/admin-api/du-banner/sources' && (request.method === 'GET' || request.method === 'POST')) return adminDuGallerySources(request, env);
  const sourceMatch = url.pathname.match(/^\/admin-api\/du-banner\/sources\/([^/]+)$/);
  if (sourceMatch && request.method === 'DELETE') return adminDuGallerySourceDelete(request, env, sourceMatch[1]!);
  if (url.pathname === '/admin-api/du-banner/gallery' && request.method === 'GET') { await authenticateAdmin(request, env); return getDuBannerGallery(env, '', '', true); }
  if (url.pathname === '/admin-api/du-banner/gallery' && request.method === 'POST') return adminDuBannerGallery(request, env);
  throw new HttpError(404, 'not_found', 'Rota administrativa não encontrada.');
}

async function cleanup(env: Env): Promise<void> {
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments WHERE expires_at<=?').bind(now),
    env.DB.prepare('DELETE FROM messages WHERE expires_at<=?').bind(now),
    env.DB.prepare("DELETE FROM message_requests WHERE status<>'pending' AND created_at<=?")
      .bind(now - HISTORY_SECONDS),
    env.DB.prepare('DELETE FROM audit_logs WHERE created_at<=?').bind(now - 90 * 86400),
    env.DB.prepare('DELETE FROM auth_rate_limits WHERE expires_at<=?').bind(now)
  ]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
            'Access-Control-Max-Age': '86400'
          }
        });
      }
      if (url.pathname === '/health') {
        return json({ ok: true, service: 'discord-unlock-api', storage: 'gofile', time: nowSeconds() });
      }
      // DU Banner — public routes (no auth)
      if (url.pathname === '/du-banner/capabilities' && request.method === 'GET') return json({ok:true, profileSyncProtocol:2});
      if (url.pathname === '/du-banner/css' && request.method === 'GET') return await getDuBannerCss(env);
      if (url.pathname === '/du-banner/customizations' && request.method === 'GET') return await getDuNetworkCustomizations(env);
      if (url.pathname === '/du-banner/settings' && request.method === 'GET') return await publicDuBannerSettings(env);
      if (url.pathname === '/du-banner/klipy' && request.method === 'GET') return await proxyDuKlipy(url, env);
      if (url.pathname === '/du-banner/gallery' && request.method === 'GET') return await getDuBannerGallery(env);
      if (url.pathname === '/du-banner/gallery' && request.method === 'POST') return await getOwnedDuBannerGallery(request, env);
      if (url.pathname === '/du-banner/gallery/rename' && request.method === 'POST') return await renameDuBannerGalleryItem(request, env);
      const duBannerMatch = url.pathname.match(/^\/du-banner\/(\d{17,21})$/);
      if (duBannerMatch && request.method === 'GET') return await getDuBannerForUser(duBannerMatch[1]!, env);
      // DU Banner — licensed user routes
      if (url.pathname === '/du-banner' && request.method === 'POST') return await registerDuBanner(request, env);
      if (url.pathname === '/du-banner' && request.method === 'DELETE') return await deleteDuBanner(request, env);
      if (url.pathname.startsWith('/v1/')) return await clientRoutes(request, url, env);
      if (url.pathname.startsWith('/admin-api/')) return await adminRoutes(request, url, env);
      return env.ASSETS.fetch(request);
    } catch (cause) {
      if (cause instanceof HttpError) return error(cause.message, cause.status, cause.code);
      console.error('Unhandled request error', cause);
      return error('Erro interno do servidor.', 500, 'internal_error');
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
  }
} satisfies ExportedHandler<Env>;



