import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import type { Env, SessionIdentity } from './types';
import { HttpError, normalizeLicenseKey, nowSeconds } from './utils';

const encoder = new TextEncoder();
const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function requireConfiguredSecrets(env: Env): void {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    throw new HttpError(503, 'server_not_configured', 'JWT_SECRET não foi configurado corretamente.');
  }
  if (!env.IDENTIFIER_PEPPER || env.IDENTIFIER_PEPPER.length < 32) {
    throw new HttpError(503, 'server_not_configured', 'IDENTIFIER_PEPPER não foi configurado corretamente.');
  }
}

export async function licenseHash(env: Env, licenseKey: unknown): Promise<string> {
  const normalized = normalizeLicenseKey(licenseKey);
  if (normalized.length < 8 || normalized.length > 128) {
    throw new HttpError(400, 'invalid_license', 'Formato de licença inválido.');
  }
  return hmacHex(env.IDENTIFIER_PEPPER, `license:${normalized}`);
}

export async function hwidHash(env: Env, hwid: unknown): Promise<string> {
  const normalized = String(hwid ?? '').trim().toUpperCase();
  if (normalized.length < 6 || normalized.length > 512) {
    throw new HttpError(400, 'invalid_hwid', 'Identificador do dispositivo inválido.');
  }
  return hmacHex(env.IDENTIFIER_PEPPER, `hwid:${normalized}`);
}

export async function issueSessionToken(env: Env, identity: SessionIdentity): Promise<string> {
  return new SignJWT({
    did: identity.deviceId,
    pid: identity.publicId,
    role: identity.role,
    sv: identity.sessionVersion
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('discord-unlock-api')
    .setAudience('discord-unlock-client')
    .setSubject(identity.profileId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(encoder.encode(env.JWT_SECRET));
}

export async function authenticateClient(request: Request, env: Env): Promise<SessionIdentity> {
  requireConfiguredSecrets(env);
  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) {
    throw new HttpError(401, 'missing_token', 'Sessão necessária.');
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(authorization.slice(7), encoder.encode(env.JWT_SECRET), {
      issuer: 'discord-unlock-api',
      audience: 'discord-unlock-client',
      algorithms: ['HS256']
    }));
  } catch {
    throw new HttpError(401, 'invalid_token', 'Sessão inválida ou expirada.');
  }

  const profileId = String(payload.sub ?? '');
  const deviceId = String(payload.did ?? '');
  const publicId = String(payload.pid ?? '');
  const role = payload.role === 'admin' ? 'admin' : 'user';
  const sessionVersion = Number(payload.sv ?? 0);
  if (!profileId || !deviceId || !publicId || !Number.isInteger(sessionVersion)) {
    throw new HttpError(401, 'invalid_token', 'Sessão incompleta.');
  }

  const device = await env.DB.prepare(
    `SELECT d.status, d.session_version, l.status AS license_status, l.expires_at
       FROM devices d
       JOIN licenses l ON l.id = d.license_id
      WHERE d.id = ? AND d.profile_id = ?`
  ).bind(deviceId, profileId).first<{
    status: string;
    session_version: number;
    license_status: string;
    expires_at: number | null;
  }>();
  const now = nowSeconds();
  if (!device || device.status !== 'active' || device.license_status !== 'active' ||
      (device.expires_at !== null && device.expires_at <= now) ||
      device.session_version !== sessionVersion) {
    throw new HttpError(401, 'session_revoked', 'A sessão foi revogada.');
  }
  return { profileId, deviceId, publicId, role, sessionVersion };
}

export async function authenticateAdmin(request: Request, env: Env): Promise<string> {
  if (env.ENVIRONMENT !== 'production' && env.ADMIN_DEV_TOKEN) {
    const candidate = request.headers.get('X-Admin-Dev-Token') ?? '';
    if (candidate && candidate === env.ADMIN_DEV_TOKEN) return 'dev-admin';
  }

  const assertion = request.headers.get('Cf-Access-Jwt-Assertion') ?? '';
  if (!assertion || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAIL) {
    throw new HttpError(401, 'admin_auth_required', 'Autenticação administrativa necessária.');
  }
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const issuer = `https://${domain}`;
  let keySet = accessKeySets.get(domain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    accessKeySets.set(domain, keySet);
  }
  try {
    const { payload } = await jwtVerify(assertion, keySet, {
      issuer,
      audience: env.ACCESS_AUD
    });
    const email = String(payload.email ?? '').toLowerCase();
    if (email !== env.ADMIN_EMAIL.toLowerCase()) throw new Error('email não autorizado');
    return email;
  } catch {
    throw new HttpError(403, 'admin_forbidden', 'Conta administrativa não autorizada.');
  }
}

export async function issueRealtimeTicket(env: Env, identity: SessionIdentity): Promise<string> {
  return new SignJWT({ did: identity.deviceId, pid: identity.publicId, role: identity.role, sv: identity.sessionVersion })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('discord-unlock-api')
    .setAudience('discord-unlock-realtime')
    .setSubject(identity.profileId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(encoder.encode(env.JWT_SECRET));
}

export async function authenticateRealtimeTicket(ticket: string, env: Env): Promise<SessionIdentity & { expiresAt: number }> {
  requireConfiguredSecrets(env);
  let payload;
  try {
    ({ payload } = await jwtVerify(ticket, encoder.encode(env.JWT_SECRET), {
      issuer: 'discord-unlock-api', audience: 'discord-unlock-realtime', algorithms: ['HS256']
    }));
  } catch {
    throw new HttpError(401, 'invalid_realtime_ticket', 'Conexão em tempo real inválida.');
  }
  const profileId = String(payload.sub ?? '');
  const deviceId = String(payload.did ?? '');
  const publicId = String(payload.pid ?? '');
  const role = payload.role === 'admin' ? 'admin' : 'user';
  const sessionVersion = Number(payload.sv ?? 0);
  const expiresAt = Number(payload.exp ?? 0);
  if (!profileId || !deviceId || !publicId || !Number.isInteger(sessionVersion) || !expiresAt) {
    throw new HttpError(401, 'invalid_realtime_ticket', 'Conexão em tempo real incompleta.');
  }
  const device = await env.DB.prepare(
    `SELECT d.status, d.session_version, l.status AS license_status, l.expires_at
       FROM devices d JOIN licenses l ON l.id=d.license_id
      WHERE d.id=? AND d.profile_id=?`
  ).bind(deviceId, profileId).first<{ status: string; session_version: number; license_status: string; expires_at: number | null }>();
  const now = nowSeconds();
  if (!device || device.status !== 'active' || device.license_status !== 'active' ||
      (device.expires_at !== null && device.expires_at <= now) || device.session_version !== sessionVersion) {
    throw new HttpError(401, 'session_revoked', 'A sessão foi revogada.');
  }
  return { profileId, deviceId, publicId, role, sessionVersion, expiresAt };
}
