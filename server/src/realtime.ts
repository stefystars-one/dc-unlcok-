import { DurableObject } from 'cloudflare:workers';
import { authenticateRealtimeTicket } from './auth';
import type { Env } from './types';
import { HttpError } from './utils';

type RealtimeAttachment = { profileId: string; expiresAt: number };
const hubName = 'discord-unlock-realtime-hub';
const profileTag = (profileId: string) => 'profile:' + profileId;

export class RealtimeHub extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket esperado.', { status: 426 });
      const profileId = String(request.headers.get('X-DU-Realtime-Profile') ?? '');
      const expiresAt = Number(request.headers.get('X-DU-Realtime-Expires') ?? 0);
      if (!/^[0-9a-f-]{36}$/i.test(profileId) || !Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
        return new Response('Sessão inválida.', { status: 401 });
      }
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server, [profileTag(profileId)]);
      server.serializeAttachment({ profileId, expiresAt } satisfies RealtimeAttachment);
      server.send(JSON.stringify({ type: 'realtime_ready' }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/publish' && request.method === 'POST') {
      const body = await request.json<{ profileIds?: string[]; event?: Record<string, unknown> }>();
      if (!body.event || typeof body.event.type !== 'string') return new Response('Evento inválido.', { status: 400 });
      const profileIds = Array.isArray(body.profileIds) ? [...new Set(body.profileIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))] : [];
      const sockets = profileIds.length ? profileIds.flatMap((profileId) => this.ctx.getWebSockets(profileTag(profileId))) : this.ctx.getWebSockets();
      const encoded = JSON.stringify(body.event);
      const now = Math.floor(Date.now() / 1000);
      for (const socket of sockets) {
        const attachment = socket.deserializeAttachment() as RealtimeAttachment | null;
        if (!attachment || attachment.expiresAt <= now) { socket.close(4001, 'Sessão expirada'); continue; }
        try { socket.send(encoded); } catch { socket.close(1011, 'Falha no envio'); }
      }
      return new Response(null, { status: 204 });
    }
    return new Response('Não encontrado.', { status: 404 });
  }
  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void { if (message === 'ping') socket.send('pong'); }
  webSocketClose(socket: WebSocket, code: number, reason: string): void { socket.close(code, reason); }
}

export async function openRealtimeConnection(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'websocket_required', 'Conexão WebSocket necessária.');
  const ticket = String(url.searchParams.get('ticket') ?? '');
  if (!ticket || ticket.length > 4096) throw new HttpError(401, 'missing_realtime_ticket', 'Sessão de conexão necessária.');
  const identity = await authenticateRealtimeTicket(ticket, env);
  const headers = new Headers(request.headers);
  headers.set('X-DU-Realtime-Profile', identity.profileId);
  headers.set('X-DU-Realtime-Expires', String(identity.expiresAt));
  return env.REALTIME_HUB.getByName(hubName).fetch(new Request('https://realtime.internal/connect', { headers }));
}

export async function publishRealtime(env: Env, profileIds: string[] | null, event: Record<string, unknown>): Promise<void> {
  try {
    await env.REALTIME_HUB.getByName(hubName).fetch('https://realtime.internal/publish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds: profileIds ?? undefined, event })
    });
  } catch (error) {
    console.warn('Realtime publish failed', error);
  }
}
