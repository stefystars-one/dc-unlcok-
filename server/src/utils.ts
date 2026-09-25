export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const HISTORY_SECONDS = 30 * 24 * 60 * 60;
export const ATTACHMENT_SECONDS = 7 * 24 * 60 * 60;

const PUBLIC_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav'
]);

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomPublicId(randomBytes?: Uint8Array): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(10));
  if (bytes.length < 10) throw new Error('São necessários 10 bytes aleatórios');
  let value = '';
  for (let i = 0; i < 10; i += 1) {
    value += PUBLIC_ID_ALPHABET[bytes[i]! % PUBLIC_ID_ALPHABET.length];
  }
  return `DU-${value.slice(0, 5)}-${value.slice(5)}`;
}

export function normalizePublicId(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

export function normalizeLicenseKey(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

export function cleanDisplayName(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

export function cleanMessage(value: unknown): string {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

export function safeFileName(value: unknown): string {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'arquivo';
}

export function isAllowedAttachment(mimeType: string, byteSize: number): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType.toLowerCase()) &&
    Number.isInteger(byteSize) && byteSize > 0 && byteSize <= MAX_ATTACHMENT_BYTES;
}

export function normalizeGofileContentId(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) {
    throw new HttpError(400, 'invalid_gofile_id', 'Identificador do GoFile inválido.');
  }
  return id;
}

export function normalizeGofileShareUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new HttpError(400, 'invalid_gofile_url', 'Link do GoFile inválido.');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (host !== 'gofile.io' && !host.endsWith('.gofile.io'))) {
    throw new HttpError(400, 'invalid_gofile_url', 'Somente links HTTPS oficiais do GoFile são aceitos.');
  }
  url.hash = '';
  return url.toString();
}
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
};

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export function error(message: string, status = 400, code = 'bad_request'): Response {
  return json({ ok: false, error: code, message }, status);
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'content_type', 'Envie um corpo JSON.');
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON inválido.');
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}
