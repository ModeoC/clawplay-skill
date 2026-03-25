/**
 * Mock Gateway WebSocket server for integration testing.
 *
 * Implements OpenClaw's gateway protocol:
 * - Challenge-response auth handshake
 * - Agent RPC calls with two-phase responses
 * - Captures all call history for assertions
 */

import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

interface AgentCallCapture {
  id: string;
  params: Record<string, unknown>;
  timestamp: number;
}

export class MockGatewayWS {
  private httpServer: Server;
  private wss: WebSocketServer;
  private clients: WebSocket[] = [];
  private callHistory: AgentCallCapture[] = [];
  private lastConnectParams: Record<string, unknown> | null = null;
  private decisionResponse = '{"action":"fold","narration":"I fold."}';
  private reflectionResponse = '{"insights":"Opponent is passive."}';
  private responseDelay = 0;
  port = 0;

  constructor() {
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws) => {
      this.clients.push(ws);

      // Send challenge immediately
      const nonce = randomUUID();
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce },
      }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(ws, msg);
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        this.clients = this.clients.filter(c => c !== ws);
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) {
      ws.close();
    }
    this.wss.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  // ── Configuration ─────────────────────────────────────────────

  /** Set the response for agent decision calls. */
  setDecisionResponse(json: string): void {
    this.decisionResponse = json;
  }

  /** Set the response for reflection calls. */
  setReflectionResponse(json: string): void {
    this.reflectionResponse = json;
  }

  /** Set artificial delay before responding (ms). */
  setResponseDelay(ms: number): void {
    this.responseDelay = ms;
  }

  // ── Captured data ──────────────────────────────────────────────

  /** Get all captured agent call history. */
  getCallHistory(): AgentCallCapture[] {
    return [...this.callHistory];
  }

  /** Get decision calls only (not warmup or reflection). */
  getDecisionCalls(): AgentCallCapture[] {
    return this.callHistory.filter(c => {
      const key = c.params.sessionKey as string || '';
      return key.includes('-h') && !key.includes('warmup') && !key.includes('reflect');
    });
  }

  /** Get reflection calls only. */
  getReflectionCalls(): AgentCallCapture[] {
    return this.callHistory.filter(c => {
      const key = c.params.sessionKey as string || '';
      return key.includes('reflect');
    });
  }

  /** Clear call history. */
  clearHistory(): void {
    this.callHistory = [];
  }

  get clientCount(): number {
    return this.clients.length;
  }

  /** Get the params from the last connect handshake. */
  getLastConnectParams(): Record<string, unknown> | null {
    return this.lastConnectParams;
  }

  // ── Internal ───────────────────────────────────────────────────

  private handleMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    if (msg.type !== 'req') return;

    const id = msg.id as string;
    const method = msg.method as string;
    const params = (msg.params || {}) as Record<string, unknown>;

    if (method === 'connect') {
      this.lastConnectParams = params;
      // Auth handshake — always accept
      ws.send(JSON.stringify({
        type: 'res', id, ok: true, payload: { status: 'connected' },
      }));
      return;
    }

    if (method === 'agent') {
      this.callHistory.push({ id, params, timestamp: Date.now() });

      const sessionKey = (params.sessionKey as string) || '';
      const isReflection = sessionKey.includes('reflect');
      const responseText = isReflection ? this.reflectionResponse : this.decisionResponse;

      const respond = () => {
        // Phase 1: accepted
        ws.send(JSON.stringify({
          type: 'res', id, ok: true, payload: { status: 'accepted' },
        }));

        // Phase 2: final
        ws.send(JSON.stringify({
          type: 'res', id, ok: true,
          payload: {
            result: {
              payloads: [{ text: responseText }],
            },
          },
        }));
      };

      if (this.responseDelay > 0) {
        setTimeout(respond, this.responseDelay);
      } else {
        respond();
      }
    }
  }
}
