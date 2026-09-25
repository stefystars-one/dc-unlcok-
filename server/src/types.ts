export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  JWT_SECRET: string;
  IDENTIFIER_PEPPER: string;
  ADMIN_DEV_TOKEN?: string;
  ADMIN_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  GOFILE_UPLOAD_URL: string;
  REALTIME_HUB: DurableObjectNamespace;
}

export interface SessionIdentity {
  profileId: string;
  deviceId: string;
  publicId: string;
  role: 'user' | 'admin';
  sessionVersion: number;
}

export interface ProfileRow {
  id: string;
  public_id: string;
  display_name: string;
  role: 'user' | 'admin';
  accept_requests: number;
  created_at: number;
  updated_at: number;
}
