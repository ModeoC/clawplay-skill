/**
 * Minimal gateway WS client for the poker listener.
 *
 * Handles the challenge-response auth handshake and two-phase agent responses.
 * Uses Node 22's built-in WHATWG WebSocket — no extra dependencies.
 */

import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_ROOT } from './review.js';

const PROTOCOL_VERSION = 3;

// ── Device Identity ─────────────────────────────────────────────────

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;   // PEM
  privateKey: string;  // PEM
}

export interface CachedDeviceToken {
  token: string;
  role?: string;
  scopes?: string[];
}

export function loadOrCreateDeviceKeys(dir: string): DeviceIdentity {
  const keyFile = join(dir, '.device-identity.json');
  if (existsSync(keyFile)) {
    try { return JSON.parse(readFileSync(keyFile, 'utf8')); } catch {}
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // Device ID = SHA-256 of raw Ed25519 public key bytes (last 32 bytes of SPKI DER)
  const derBase64 = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const rawKey = Buffer.from(derBase64, 'base64').subarray(-32);
  const deviceId = createHash('sha256').update(rawKey).digest('hex');
  const identity: DeviceIdentity = { deviceId, publicKey, privateKey };
  writeFileSync(keyFile, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

export interface SignParams {
  privateKeyPem: string;
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce: string;
  platform: string;
}

export function buildAndSign(params: SignParams): string {
  // v3 payload format: v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|
  const payload = [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    params.platform,
    '', // deviceFamily (empty)
  ].join('|');
  return sign(null, Buffer.from(payload), params.privateKeyPem).toString('base64url');
}

export function loadCachedDeviceToken(dir: string): CachedDeviceToken | null {
  try { return JSON.parse(readFileSync(join(dir, '.device-token.json'), 'utf8')); } catch { return null; }
}

export function saveCachedDeviceToken(dir: string, data: CachedDeviceToken): void {
  writeFileSync(join(dir, '.device-token.json'), JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ── Types ───────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  expectFinal: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface AgentCallParams {
  message: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  thinking?: string;
  timeout?: number; // seconds (server-side)
  idempotencyKey?: string;
  extraSystemPrompt?: string;
  /** Model override — passed through to gateway RPC. Format: "model-id" (e.g. "mistralai/mistral-small-2603"). */
  modelOverride?: string;
  /** Provider override — passed through to gateway RPC. Format: "provider-id" (e.g. "openrouter"). */
  providerOverride?: string;
}

export interface AgentCallResult {
  payloads: Array<{ text?: string; [key: string]: unknown }>;
  meta?: Record<string, unknown>;
}

// ── Token resolution ────────────────────────────────────────────────

function resolveGatewayToken(): string | undefined {
  // 1. Environment variable (available when spawned by the gateway process)
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim()
    || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envToken) return envToken;

  // 2. Config file at gateway.auth.token
  try {
    const home = process.env.HOME || '/root';
    const cfg = JSON.parse(readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf8'));
    const token = cfg?.gateway?.auth?.token;
    if (typeof token === 'string' && token.trim()) return token.trim();
  } catch {}

  return undefined;
}

function resolveGatewayUrl(): string {
  try {
    const home = process.env.HOME || '/root';
    const cfg = JSON.parse(readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf8'));
    const port = cfg?.gateway?.port || 18789;
    return `ws://127.0.0.1:${port}`;
  } catch {
    return 'ws://127.0.0.1:18789';
  }
}

// ── Gateway Client ──────────────────────────────────────────────────

export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private token: string | undefined;
  private url: string;
  private _connected = false;
  private closed = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private wasEverConnected = false;
  private nonce: string | null = null;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private emitFn: ((obj: Record<string, unknown>) => void) | null = null;
  private deviceIdentity: DeviceIdentity | null = null;
  private cachedDeviceToken: CachedDeviceToken | null = null;

  /** Called when the gateway reconnects after a previous successful connection. Not called on initial connect. */
  onReconnect: (() => void) | null = null;

  constructor(opts?: { emit?: (obj: Record<string, unknown>) => void }) {
    this.token = resolveGatewayToken();
    this.url = resolveGatewayUrl();
    this.emitFn = opts?.emit ?? null;
    try {
      this.deviceIdentity = loadOrCreateDeviceKeys(SKILL_ROOT);
      this.cachedDeviceToken = loadCachedDeviceToken(SKILL_ROOT);
    } catch {}
  }

  /** Whether the WS is currently connected and authenticated. */
  isConnected(): boolean {
    return this._connected;
  }

  /** Connect to the gateway and complete the auth handshake. */
  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.connectPromise) return this.connectPromise;

    // Cancel any pending reconnect — we're connecting now
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.startConnection();
    });

    return this.connectPromise;
  }

  private startConnection(): void {
    if (this.closed) return;
    this.nonce = null;

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
      this.ws = ws;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connectReject?.(new Error(`WebSocket create failed: ${msg}`));
      return;
    }

    // Challenge timeout — if no challenge within 5s, abandon this WS.
    // Don't wait for onclose (may be delayed if gateway is busy).
    this.challengeTimer = setTimeout(() => {
      this.challengeTimer = null;
      if (!this._connected && this.ws === ws) {
        // Nullify handlers so stale onclose can't interfere
        ws.onclose = null;
        ws.onmessage = null;
        ws.onopen = null;
        this.ws = null;
        ws.close(); // Best-effort close (fire-and-forget)
        this.flushPending(new Error('Gateway connect challenge timeout'));
        this.connectReject?.(new Error('Gateway connect challenge timeout'));
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
        if (!this.closed) this.scheduleReconnect();
      }
    }, 5000);

    ws.onopen = () => {
      this.emit({ type: 'GW_WS_OPEN' });
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return; // Stale WS, ignore
      try {
        const msg = JSON.parse(String(event.data));
        this.handleMessage(msg);
      } catch {}
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // Already abandoned by challenge timer
      if (this.challengeTimer) { clearTimeout(this.challengeTimer); this.challengeTimer = null; }
      this.stopKeepalive();
      const wasConnected = this._connected;
      this._connected = false;
      this.ws = null;
      this.flushPending(new Error('Gateway connection closed'));

      if (!this.closed && (wasConnected || this.wasEverConnected)) {
        // Drop after active connection OR failed reconnect attempt → keep retrying
        // Reject any outstanding connect promise so callers don't hang
        this.connectReject?.(new Error('Gateway connection closed during reconnect'));
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
        this.scheduleReconnect();
      } else if (!wasConnected) {
        // Initial connect failed (never connected before) → reject, let caller handle
        this.connectReject?.(new Error('Gateway connection closed before auth'));
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
        // Schedule background reconnect even on initial failure so the client
        // proactively retries instead of sitting dead until callAgent's retry
        if (!this.closed) {
          this.wasEverConnected = true;
          this.scheduleReconnect();
        }
      }
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Event frame (challenge, tick, etc.)
    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        const payload = msg.payload as { nonce?: string } | undefined;
        this.nonce = payload?.nonce?.toString().trim() ?? null;
        if (this.nonce) this.sendConnectRequest();
      }
      return;
    }

    // Response frame
    if (msg.type === 'res') {
      const id = msg.id as string;
      const pending = this.pending.get(id);
      if (!pending) return;

      // Two-phase: skip "accepted" if we expect a final response
      const payload = msg.payload as Record<string, unknown> | undefined;
      if (pending.expectFinal && payload?.status === 'accepted') return;

      this.pending.delete(id);
      clearTimeout(pending.timer);

      if (msg.ok) {
        pending.resolve(payload);
      } else {
        const errMsg = (msg.error as { message?: string })?.message ?? 'Unknown gateway error';
        pending.reject(new Error(errMsg));
      }
    }
  }

  private sendConnectRequest(): void {
    const params: Record<string, unknown> = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: 'gateway-client',
        version: 'dev',
        platform: process.platform,
        mode: 'backend',
      },
      caps: [],
      role: 'operator',
      scopes: ['operator.admin', 'operator.write'],
    };

    // Include device identity so the gateway preserves our scopes
    const signedAt = Date.now();
    const authToken = this.cachedDeviceToken?.token || this.token || '';
    if (this.deviceIdentity && this.nonce) {
      params.device = {
        id: this.deviceIdentity.deviceId,
        publicKey: this.deviceIdentity.publicKey,
        signature: buildAndSign({
          privateKeyPem: this.deviceIdentity.privateKey,
          deviceId: this.deviceIdentity.deviceId,
          clientId: (params.client as Record<string, string>).id,
          clientMode: (params.client as Record<string, string>).mode,
          role: params.role as string,
          scopes: params.scopes as string[],
          signedAtMs: signedAt,
          token: authToken,
          nonce: this.nonce,
          platform: process.platform,
        }),
        signedAt,
        nonce: this.nonce,
      };
    }

    // Prefer cached device token (preserves scopes), fall back to shared gateway token
    if (this.cachedDeviceToken?.token) {
      params.auth = { deviceToken: this.cachedDeviceToken.token };
    } else if (this.token) {
      params.auth = { token: this.token };
    }

    this.request('connect', params, { timeoutMs: 5000 })
      .then((result) => {
        // Cache device token if gateway issued one
        const auth = (result as Record<string, unknown>)?.auth as Record<string, unknown> | undefined;
        if (auth?.deviceToken) {
          this.cachedDeviceToken = {
            token: auth.deviceToken as string,
            role: auth.role as string | undefined,
            scopes: auth.scopes as string[] | undefined,
          };
          try { saveCachedDeviceToken(SKILL_ROOT, this.cachedDeviceToken); } catch {}
        }

        const isReconnect = this.wasEverConnected;
        this._connected = true;
        this.wasEverConnected = true;
        this.backoffMs = 1000; // Reset backoff only after successful auth
        if (this.challengeTimer) { clearTimeout(this.challengeTimer); this.challengeTimer = null; }
        this.startKeepalive();
        this.connectResolve?.();
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
        this.emit({ type: 'GW_CONNECTED' });
        if (isReconnect) this.onReconnect?.();
      })
      .catch((err) => {
        this.connectReject?.(err);
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
        this.ws?.close();
      });
  }

  /** Send an RPC request to the gateway. */
  private request(
    method: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number; expectFinal?: boolean },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }

      const id = randomUUID();
      const timeoutMs = opts?.timeoutMs ?? 30_000;
      const expectFinal = opts?.expectFinal ?? false;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timeout (${method}, ${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, expectFinal, timer });

      const frame = { type: 'req', id, method, params };
      this.ws.send(JSON.stringify(frame));
    });
  }

  /** Call the agent RPC method. Handles two-phase response. */
  async callAgent(params: AgentCallParams, timeoutMs = 60_000): Promise<AgentCallResult> {
    if (!this._connected) {
      // Retry connect up to 3 times with exponential backoff (1s, 2s, 4s)
      let lastErr: Error | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.connect();
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < 2) {
            const delay = 1000 * 2 ** attempt;
            this.emit({ type: 'GW_CALLAGENT_RETRY', attempt: attempt + 1, delayMs: delay });
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      if (lastErr) throw lastErr;
    }

    const rpcParams: Record<string, unknown> = {
      message: params.message,
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
    };
    if (params.agentId) rpcParams.agentId = params.agentId;
    if (params.sessionKey) rpcParams.sessionKey = params.sessionKey;
    if (params.sessionId) rpcParams.sessionId = params.sessionId;
    if (params.thinking) rpcParams.thinking = params.thinking;
    if (params.timeout != null) rpcParams.timeout = params.timeout;
    if (params.extraSystemPrompt) rpcParams.extraSystemPrompt = params.extraSystemPrompt;
    if (params.modelOverride) rpcParams.modelOverride = params.modelOverride;
    if (params.providerOverride) rpcParams.providerOverride = params.providerOverride;

    const result = await this.request('agent', rpcParams, {
      timeoutMs,
      expectFinal: true,
    }) as { result?: AgentCallResult; status?: string };

    return result?.result ?? { payloads: [] };
  }

  /** Disconnect and stop reconnecting. */
  stop(): void {
    this.closed = true;
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error('Gateway client stopped'));
  }

  // ── Keepalive ───────────────────────────────────────────────────────

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (!this._connected || !this.ws) return;
      this.request('health', {}, { timeoutMs: 5000 })
        .then(() => {
          this.emit({ type: 'GW_KEEPALIVE_OK' });
        })
        .catch(() => {
          this.emit({ type: 'GW_KEEPALIVE_FAILED' });
          // Force-close to trigger reconnect
          this.ws?.close();
        });
    }, 30_000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.emit({ type: 'GW_RECONNECT', delayMs: this.backoffMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectPromise = new Promise<void>((resolve, reject) => {
        this.connectResolve = resolve;
        this.connectReject = reject;
        this.startConnection();
      });
      // Prevent unhandled rejection crash if nobody's awaiting the reconnect
      this.connectPromise.catch(() => {});
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private emit(obj: Record<string, unknown>): void {
    this.emitFn?.(obj);
  }
}
