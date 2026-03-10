/**
 * Mock SSE server for integration testing.
 *
 * Creates a minimal HTTP server that serves scripted SSE events on /api/me/stream
 * and /api/me/game/stream. Also captures POST requests to /api/me/game/action
 * for assertion.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PlayerView } from '../../types.js';

interface ActionCapture {
  action: string;
  amount?: number;
  reasoning?: string;
  timestamp: number;
}

export class MockSSEServer {
  private server: Server;
  private sseClients: ServerResponse[] = [];
  private actionCaptures: ActionCapture[] = [];
  private leaveCaptures: number[] = [];
  port = 0;

  constructor() {
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients = [];

    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // ── SSE event methods ──────────────────────────────────────────

  /** Send a state SSE event to all connected clients. */
  sendState(view: Partial<PlayerView>): void {
    this.sendEvent('state', JSON.stringify(view));
  }

  /** Send a closed SSE event (table closed). */
  sendClosed(): void {
    this.sendEvent('closed', '{}');
  }

  /** Send a left SSE event (player left). */
  sendLeft(): void {
    this.sendEvent('left', '{}');
  }

  /** Send a keepalive SSE event. */
  sendKeepalive(): void {
    this.sendEvent('keepalive', '{}');
  }

  /** Send an invite SSE event. */
  sendInvite(data: { inviterName: string; gameMode: string; inviteId: string; tableId: string }): void {
    this.sendEvent('invite', JSON.stringify(data));
  }

  /** Send a follow SSE event. */
  sendFollow(data: { followerId: string; followerName: string }): void {
    this.sendEvent('follow', JSON.stringify(data));
  }

  /** Drop all SSE connections (simulates network failure). */
  dropConnections(): void {
    for (const client of this.sseClients) {
      client.destroy();
    }
    this.sseClients = [];
  }

  // ── Captured data ──────────────────────────────────────────────

  /** Get all captured action submissions. */
  getActions(): ActionCapture[] {
    return [...this.actionCaptures];
  }

  /** Get timestamps of captured leave requests. */
  getLeaves(): number[] {
    return [...this.leaveCaptures];
  }

  /** Clear all captured data. */
  clearCaptures(): void {
    this.actionCaptures = [];
    this.leaveCaptures = [];
  }

  get clientCount(): number {
    return this.sseClients.length;
  }

  // ── Internal ───────────────────────────────────────────────────

  private sendEvent(event: string, data: string): void {
    const payload = `event: ${event}\ndata: ${data}\n\n`;
    for (const client of this.sseClients) {
      client.write(payload);
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '';

    // SSE streams
    if (url.startsWith('/api/me/stream') || url.startsWith('/api/me/game/stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      this.sseClients.push(res);

      req.on('close', () => {
        this.sseClients = this.sseClients.filter(c => c !== res);
      });
      return;
    }

    // Action submission
    if (url === '/api/me/game/action' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          this.actionCaptures.push({
            action: parsed.action,
            amount: parsed.amount,
            reasoning: parsed.reasoning,
            timestamp: Date.now(),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch {
          res.writeHead(400);
          res.end('Bad request');
        }
      });
      return;
    }

    // Leave endpoint
    if (url === '/api/me/game/leave' && req.method === 'POST') {
      this.leaveCaptures.push(Date.now());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // Game status check
    if (url === '/api/me/game' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"gameId":"test-game"}');
      return;
    }

    // Default 404
    res.writeHead(404);
    res.end('Not found');
  }
}
