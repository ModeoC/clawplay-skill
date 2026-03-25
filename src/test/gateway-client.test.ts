/**
 * Tests for GatewayWsClient — WebSocket RPC client for OpenClaw gateway.
 *
 * Uses vi.mock() to replace the global WebSocket with a controllable mock,
 * enabling tests for:
 * - Challenge-response auth handshake
 * - callAgent request/response shape
 * - Timeout behavior
 * - Error responses
 * - Reconnection backoff
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock WebSocket ──────────────────────────────────────────────────

interface MockWSInstance {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let mockWsInstance: MockWSInstance;
let mockWsConstructorCalls: string[] = [];

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => {
    // Simulate close behavior
    setTimeout(() => this.onclose?.(), 0);
  });

  constructor(url: string) {
    mockWsConstructorCalls.push(url);
    mockWsInstance = this as unknown as MockWSInstance;
    // Auto-open after microtask
    setTimeout(() => this.onopen?.(), 0);
  }
}

// Set up global WebSocket mock before any imports
vi.stubGlobal('WebSocket', MockWebSocket);

// Mock crypto — deterministic UUIDs + real Ed25519 functions for device auth tests
let uuidCounter = 0;
vi.mock('node:crypto', async () => {
  const real = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    randomUUID: () => `test-uuid-${++uuidCounter}`,
    generateKeyPairSync: real.generateKeyPairSync,
    sign: real.sign,
    createHash: real.createHash,
  };
});

// Mock fs — spies so device auth tests can configure per-test behavior
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('mock: file not found'); }),
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
}));

// Import mocked fs functions for per-test configuration
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

// Now import the class under test
const { GatewayWsClient } = await import('../gateway-client.js');

// ── Test helpers ────────────────────────────────────────────────────

function sendChallenge(ws: MockWSInstance, nonce = 'test-nonce'): void {
  ws.onmessage?.({ data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce } }) });
}

function sendConnectResponse(ws: MockWSInstance, id: string, ok = true, payload?: Record<string, unknown>): void {
  ws.onmessage?.({ data: JSON.stringify({ type: 'res', id, ok, payload: payload ?? (ok ? {} : undefined), error: ok ? undefined : { message: 'Auth failed' } }) });
}

/** Extract the connect request frame from WS send calls. */
function getConnectFrame(ws: MockWSInstance): Record<string, unknown> | null {
  const call = ws.send.mock.calls.find(
    (c: string[]) => { try { return JSON.parse(c[0]).method === 'connect'; } catch { return false; } },
  );
  return call ? JSON.parse(call[0]) : null;
}

function sendAgentResponse(ws: MockWSInstance, id: string, payloads: Array<{ text?: string }>, twoPhase = true): void {
  if (twoPhase) {
    // First phase: accepted
    ws.onmessage?.({ data: JSON.stringify({ type: 'res', id, ok: true, payload: { status: 'accepted' } }) });
  }
  // Final response
  ws.onmessage?.({ data: JSON.stringify({ type: 'res', id, ok: true, payload: { result: { payloads } } }) });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('GatewayWsClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    uuidCounter = 0;
    mockWsConstructorCalls = [];
    // Set env to provide a token
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  describe('connect', () => {
    it('creates WebSocket to default URL', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      sendChallenge(mockWsInstance);

      // Find the connect request
      const connectCall = mockWsInstance.send.mock.calls.find(
        (c: string[]) => JSON.parse(c[0]).method === 'connect',
      );
      expect(connectCall).toBeTruthy();
      const frame = JSON.parse(connectCall![0]);

      sendConnectResponse(mockWsInstance, frame.id);
      await connectPromise;

      expect(mockWsConstructorCalls[0]).toContain('ws://127.0.0.1:');
    });

    it('sends connect request with auth token after challenge', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'my-nonce');

      const connectCall = mockWsInstance.send.mock.calls.find(
        (c: string[]) => JSON.parse(c[0]).method === 'connect',
      );
      expect(connectCall).toBeTruthy();
      const frame = JSON.parse(connectCall![0]);

      expect(frame.type).toBe('req');
      expect(frame.method).toBe('connect');
      expect(frame.params.auth?.token).toBe('test-token');
      expect(frame.params.role).toBe('operator');

      sendConnectResponse(mockWsInstance, frame.id);
      await connectPromise;
    });

    it('rejects on challenge timeout', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection window
      const expectReject = expect(connectPromise).rejects.toThrow();
      // Don't send challenge — let the 5s timeout fire
      await vi.advanceTimersByTimeAsync(5001);

      // close fires, which triggers onclose
      await vi.advanceTimersByTimeAsync(1);

      await expectReject;
      client.stop();
    });

    it('is idempotent (second call does not create a new WebSocket)', async () => {
      const client = new GatewayWsClient();
      client.connect();
      client.connect();

      // Only one WebSocket should have been created
      expect(mockWsConstructorCalls).toHaveLength(1);

      // Clean up
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const frame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, frame.id);
    });
  });

  describe('callAgent', () => {
    it('sends agent RPC request and parses two-phase response', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      // Reset send mock to track only the agent call
      mockWsInstance.send.mockClear();

      const callPromise = client.callAgent({ message: 'What should I do?', agentId: 'main', sessionKey: 'poker-h1', timeout: 55 });

      // Verify the RPC request shape
      expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
      const agentFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(agentFrame.type).toBe('req');
      expect(agentFrame.method).toBe('agent');
      expect(agentFrame.params.message).toBe('What should I do?');
      expect(agentFrame.params.agentId).toBe('main');
      expect(agentFrame.params.sessionKey).toBe('poker-h1');
      expect(agentFrame.params.timeout).toBe(55);

      // Send two-phase response
      sendAgentResponse(mockWsInstance, agentFrame.id, [{ text: '{"action":"fold"}' }]);

      const result = await callPromise;
      expect(result.payloads).toHaveLength(1);
      expect(result.payloads[0].text).toBe('{"action":"fold"}');
    });

    it('auto-connects if not connected', async () => {
      const client = new GatewayWsClient();

      // callAgent without explicit connect — should auto-connect
      const callPromise = client.callAgent({ message: 'test' }, 5000);

      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);

      // Now the agent call goes out
      await vi.advanceTimersByTimeAsync(1);
      const agentFrame = JSON.parse(
        mockWsInstance.send.mock.calls.find(
          (c: string[]) => JSON.parse(c[0]).method === 'agent',
        )![0],
      );
      sendAgentResponse(mockWsInstance, agentFrame.id, [{ text: '{"action":"check"}' }]);

      const result = await callPromise;
      expect(result.payloads[0].text).toBe('{"action":"check"}');
    });

    it('times out on no response', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      const callPromise = client.callAgent({ message: 'test' }, 5000);

      // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection window
      const expectReject = expect(callPromise).rejects.toThrow('timeout');
      // Don't send any response — let it timeout
      await vi.advanceTimersByTimeAsync(5001);

      await expectReject;
      client.stop();
    });

    it('handles error responses', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      const callPromise = client.callAgent({ message: 'test' });

      const agentFrame = JSON.parse(mockWsInstance.send.mock.calls[1][0]);
      // Send error response
      mockWsInstance.onmessage?.({
        data: JSON.stringify({
          type: 'res', id: agentFrame.id, ok: false,
          error: { message: 'Agent not found' },
        }),
      });

      await expect(callPromise).rejects.toThrow('Agent not found');
    });

    it('skips accepted phase in two-phase response', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      const callPromise = client.callAgent({ message: 'test' });
      const agentFrame = JSON.parse(mockWsInstance.send.mock.calls[1][0]);

      // Send accepted first
      mockWsInstance.onmessage?.({
        data: JSON.stringify({ type: 'res', id: agentFrame.id, ok: true, payload: { status: 'accepted' } }),
      });

      // The promise should NOT resolve yet
      let resolved = false;
      callPromise.then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(false);

      // Now send final
      mockWsInstance.onmessage?.({
        data: JSON.stringify({
          type: 'res', id: agentFrame.id, ok: true,
          payload: { result: { payloads: [{ text: 'done' }] } },
        }),
      });

      const result = await callPromise;
      expect(result.payloads[0].text).toBe('done');
    });

    it('returns empty payloads when result is missing', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      const callPromise = client.callAgent({ message: 'test' });
      const agentFrame = JSON.parse(mockWsInstance.send.mock.calls[1][0]);

      // Send response with no result field
      mockWsInstance.onmessage?.({
        data: JSON.stringify({ type: 'res', id: agentFrame.id, ok: true, payload: {} }),
      });

      const result = await callPromise;
      expect(result.payloads).toEqual([]);
    });

    it('includes extraSystemPrompt when provided', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      mockWsInstance.send.mockClear();

      const callPromise = client.callAgent({
        message: 'decide',
        extraSystemPrompt: 'You are Jiro, a samurai poker player.',
      });

      const agentFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(agentFrame.params.extraSystemPrompt).toBe('You are Jiro, a samurai poker player.');

      sendAgentResponse(mockWsInstance, agentFrame.id, [{ text: '{"action":"fold"}' }]);
      await callPromise;
    });
  });

  describe('stop', () => {
    it('closes connection and rejects pending requests', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();

      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      // Start a request but don't respond
      const callPromise = client.callAgent({ message: 'test' }, 30000);

      // Stop the client
      client.stop();

      await expect(callPromise).rejects.toThrow('stopped');
    });
  });

  describe('reconnection', () => {
    it('schedules reconnect with exponential backoff after connection drop', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      // Initial connect
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      // Simulate connection drop
      mockWsInstance.onclose?.();

      // Should emit GW_RECONNECT
      const reconnect = emitted.find(e => e.type === 'GW_RECONNECT');
      expect(reconnect).toBeTruthy();
      expect(reconnect!.delayMs).toBe(1000);
    });

    it('rejects orphaned connect promise on failed reconnect attempt', async () => {
      const client = new GatewayWsClient();

      // Initial connect
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      // Simulate connection drop → triggers scheduleReconnect
      mockWsInstance.onclose?.();

      // Advance past backoff to trigger reconnect attempt
      await vi.advanceTimersByTimeAsync(1001);

      // New WS opens, but then immediately closes (gateway not ready)
      // The onclose should reject the reconnect's connectPromise (not hang)
      mockWsInstance.onclose?.();

      // Should still schedule another reconnect (not be stuck)
      await vi.advanceTimersByTimeAsync(2001); // 2s backoff
      // A third WS should have been created
      expect(mockWsConstructorCalls.length).toBeGreaterThanOrEqual(3);

      client.stop();
    });

    it('does not reset backoff on TCP connect — only after auth', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      // Initial connect
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      // Drop connection
      mockWsInstance.onclose?.();
      emitted.length = 0;

      // First reconnect at 1000ms
      await vi.advanceTimersByTimeAsync(1001);
      // TCP opens (onopen fires) but then connection closes before auth
      mockWsInstance.onclose?.();

      // Second reconnect should be at 2000ms (doubled), not 1000ms (reset)
      const reconnects = emitted.filter(e => e.type === 'GW_RECONNECT');
      // The second GW_RECONNECT should have delayMs > 1000
      expect(reconnects.length).toBeGreaterThanOrEqual(1);
      const lastReconnect = reconnects[reconnects.length - 1];
      expect(lastReconnect.delayMs).toBeGreaterThan(1000);

      client.stop();
    });

    it('callAgent retries connect once on failure', async () => {
      const client = new GatewayWsClient();

      // First connect attempt — simulate immediate close (gateway not up)
      const callPromise = client.callAgent({ message: 'decide' }, 10000);

      // First WS opens
      await vi.advanceTimersByTimeAsync(1);
      // Simulate immediate close (gateway refuses)
      mockWsInstance.onclose?.();

      // callAgent catch block waits 1000ms then retries
      await vi.advanceTimersByTimeAsync(1001);

      // Second WS opens — this time succeed
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(
        mockWsInstance.send.mock.calls.find(
          (c: string[]) => JSON.parse(c[0]).method === 'connect',
        )![0],
      );
      sendConnectResponse(mockWsInstance, connectFrame.id);

      // Agent call goes out
      await vi.advanceTimersByTimeAsync(1);
      const agentFrame = JSON.parse(
        mockWsInstance.send.mock.calls.find(
          (c: string[]) => JSON.parse(c[0]).method === 'agent',
        )![0],
      );
      sendAgentResponse(mockWsInstance, agentFrame.id, [{ text: '{"action":"fold"}' }]);

      const result = await callPromise;
      expect(result.payloads[0].text).toBe('{"action":"fold"}');
    });

    it('reconnects successfully after gateway restart', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      // Initial connect
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      // Simulate gateway restart — connection drops
      mockWsInstance.onclose?.();

      // Advance past backoff to trigger reconnect
      await vi.advanceTimersByTimeAsync(1001);

      // New WS opens — gateway is back
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'new-nonce');
      const reconnectFrame = JSON.parse(
        mockWsInstance.send.mock.calls.find(
          (c: string[]) => {
            try {
              const f = JSON.parse(c[0]);
              return f.method === 'connect' && f.id !== connectFrame.id;
            } catch { return false; }
          },
        )![0],
      );
      sendConnectResponse(mockWsInstance, reconnectFrame.id);

      // Wait for promise resolution
      await vi.advanceTimersByTimeAsync(1);

      // Verify we're connected and can make calls
      expect(emitted.filter(e => e.type === 'GW_CONNECTED')).toHaveLength(2);

      // callAgent should work
      mockWsInstance.send.mockClear();
      const callPromise = client.callAgent({ message: 'test' }, 5000);
      const agentFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendAgentResponse(mockWsInstance, agentFrame.id, [{ text: 'ok' }]);
      const result = await callPromise;
      expect(result.payloads[0].text).toBe('ok');

      client.stop();
    });

    it('callAgent emits GW_CALLAGENT_RETRY and propagates error when all 3 attempts fail', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      // First connect attempt — immediate close
      const callPromise = client.callAgent({ message: 'decide' }, 10000);
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      mockWsInstance.onclose?.();

      // Let the catch block in callAgent run (microtask propagation)
      await vi.advanceTimersByTimeAsync(0);

      // Should emit first retry event (attempt 1, delay 1s)
      expect(emitted.some(e => e.type === 'GW_CALLAGENT_RETRY' && e.attempt === 1)).toBe(true);

      // Advance past the 1s retry delay
      await vi.advanceTimersByTimeAsync(1001);

      // Second connect attempt — also fails
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      mockWsInstance.onclose?.();
      await vi.advanceTimersByTimeAsync(0);

      // Should emit second retry event (attempt 2, delay 2s)
      expect(emitted.some(e => e.type === 'GW_CALLAGENT_RETRY' && e.attempt === 2)).toBe(true);

      // Advance past the 2s retry delay
      await vi.advanceTimersByTimeAsync(2001);

      // Third connect attempt — also fails
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      mockWsInstance.onclose?.();

      // Should propagate the error to the caller after 3 failed attempts
      await expect(callPromise).rejects.toThrow();

      client.stop();
    });

    it('challenge timeout clears connect state and schedules reconnect (callAgent creates fresh WS)', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      // First connect — let challenge timeout fire (no challenge sent)
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      const expectReject = expect(connectPromise).rejects.toThrow('challenge timeout');

      // Advance past the 5s challenge timer
      await vi.advanceTimersByTimeAsync(5001);
      await expectReject;

      // connectPromise should be cleared — verify by checking that
      // a subsequent callAgent creates a fresh WS (not returning stale rejected promise)
      const wsCountAfterTimeout = mockWsConstructorCalls.length;

      // Advance past the reconnect backoff (1s)
      await vi.advanceTimersByTimeAsync(1001);

      // A background reconnect WS should have been created
      expect(mockWsConstructorCalls.length).toBeGreaterThan(wsCountAfterTimeout);

      // Complete the background reconnect
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(
        mockWsInstance.send.mock.calls.find(
          (c: string[]) => JSON.parse(c[0]).method === 'connect',
        )![0],
      );
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await vi.advanceTimersByTimeAsync(1);

      // Should be connected now
      expect(client.isConnected()).toBe(true);

      // callAgent should work on the fresh connection
      mockWsInstance.send.mockClear();
      const callPromise = client.callAgent({ message: 'decide' }, 5000);
      const agentFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendAgentResponse(mockWsInstance, agentFrame.id, [{ text: '{"action":"fold"}' }]);
      const result = await callPromise;
      expect(result.payloads[0].text).toBe('{"action":"fold"}');

      client.stop();
    });

    it('challenge timeout does not let stale onclose clobber new connection', async () => {
      const client = new GatewayWsClient();

      // First connect — challenge timeout fires
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      const firstWs = mockWsInstance;
      const expectReject = expect(connectPromise).rejects.toThrow('challenge timeout');

      await vi.advanceTimersByTimeAsync(5001);
      await expectReject;

      // The old WS handlers should be nullified — calling onclose on it should be a no-op
      // (If not nullified, it would set this.ws = null and break the next connection)

      // Advance past reconnect backoff
      await vi.advanceTimersByTimeAsync(1001);
      await vi.advanceTimersByTimeAsync(1); // trigger onopen for new WS
      const secondWs = mockWsInstance;

      // Simulate the old WS's delayed onclose firing (would happen if close() takes time)
      // This should be a no-op because handlers were nullified
      firstWs.onclose?.();

      // The second WS should still be referenced by the client
      // Verify by completing the auth on it
      sendChallenge(secondWs);
      const connectFrame = JSON.parse(
        secondWs.send.mock.calls.find(
          (c: string[]) => JSON.parse(c[0]).method === 'connect',
        )![0],
      );
      sendConnectResponse(secondWs, connectFrame.id);
      await vi.advanceTimersByTimeAsync(1);

      expect(client.isConnected()).toBe(true);
      client.stop();
    });

    it('challenge timeout flushes pending requests so stale reject cannot close new WS', async () => {
      const client = new GatewayWsClient();

      // Connect — challenge arrives at ~1ms, but connect response never comes
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      sendChallenge(mockWsInstance); // challenge arrives → sendConnectRequest fires

      // A connect request was sent with 5s timeout
      const connectCall = mockWsInstance.send.mock.calls.find(
        (c: string[]) => JSON.parse(c[0]).method === 'connect',
      );
      expect(connectCall).toBeTruthy();

      // Don't send a connect response — let the challenge timer fire at 5s
      const expectReject = expect(connectPromise).rejects.toThrow('challenge timeout');
      await vi.advanceTimersByTimeAsync(5001);
      await expectReject;

      // Advance past reconnect backoff — new WS is created
      await vi.advanceTimersByTimeAsync(1001);
      await vi.advanceTimersByTimeAsync(1); // trigger onopen for new WS
      const newWs = mockWsInstance;

      // The connect request's 5s timeout would fire at ~6s (1ms + 5000ms)
      // which has already passed. flushPending should have cleared its timer.
      // If NOT flushed, the reject would call this.ws?.close() on the new WS.

      // Verify the new WS was NOT closed — complete auth on it
      sendChallenge(newWs);
      const reconnectFrame = JSON.parse(
        newWs.send.mock.calls.find(
          (c: string[]) => JSON.parse(c[0]).method === 'connect',
        )![0],
      );
      sendConnectResponse(newWs, reconnectFrame.id);
      await vi.advanceTimersByTimeAsync(1);

      expect(client.isConnected()).toBe(true);
      // Verify close was NOT called on the new WS
      expect(newWs.close).not.toHaveBeenCalled();
      client.stop();
    });

    it('schedules background reconnect after initial connect failure', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      // Initial connect — simulate immediate close (gateway not up)
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      const expectReject = expect(connectPromise).rejects.toThrow();
      mockWsInstance.onclose?.();

      await expectReject;

      // Should have scheduled a background reconnect
      const reconnect = emitted.find(e => e.type === 'GW_RECONNECT');
      expect(reconnect).toBeTruthy();
      expect(reconnect!.delayMs).toBe(1000);

      // After the backoff, a new WS connection should be attempted
      const wsCountBefore = mockWsConstructorCalls.length;
      await vi.advanceTimersByTimeAsync(1001);
      expect(mockWsConstructorCalls.length).toBeGreaterThan(wsCountBefore);

      // Complete the background reconnect
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(
        mockWsInstance.send.mock.calls.find(
          (c: string[]) => JSON.parse(c[0]).method === 'connect',
        )![0],
      );
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await vi.advanceTimersByTimeAsync(1);

      // Should be connected now
      expect(client.isConnected()).toBe(true);
      expect(emitted.filter(e => e.type === 'GW_CONNECTED')).toHaveLength(1);

      client.stop();
    });

    it('emits events for observability', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);

      expect(emitted.some(e => e.type === 'GW_WS_OPEN')).toBe(true);

      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      expect(emitted.some(e => e.type === 'GW_CONNECTED')).toBe(true);
    });
  });

  describe('isConnected', () => {
    it('returns false before connecting', () => {
      const client = new GatewayWsClient();
      expect(client.isConnected()).toBe(false);
    });

    it('returns true after successful auth', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      expect(client.isConnected()).toBe(true);
      client.stop();
    });

    it('returns false after connection drop', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      mockWsInstance.onclose?.();
      expect(client.isConnected()).toBe(false);
      client.stop();
    });
  });

  describe('onReconnect callback', () => {
    it('fires onReconnect on successful reconnect but not on initial connect', async () => {
      let reconnectCount = 0;
      const client = new GatewayWsClient();
      client.onReconnect = () => { reconnectCount++; };

      // Initial connect — should NOT fire onReconnect
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      expect(reconnectCount).toBe(0);

      // Simulate connection drop
      mockWsInstance.onclose?.();

      // Advance past backoff to trigger reconnect
      await vi.advanceTimersByTimeAsync(1001);

      // New WS opens — gateway is back
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'new-nonce');
      const reconnectFrame = JSON.parse(
        mockWsInstance.send.mock.calls.find(
          (c: string[]) => {
            try {
              const f = JSON.parse(c[0]);
              return f.method === 'connect' && f.id !== connectFrame.id;
            } catch { return false; }
          },
        )![0],
      );
      sendConnectResponse(mockWsInstance, reconnectFrame.id);
      await vi.advanceTimersByTimeAsync(1);

      // NOW onReconnect should have fired
      expect(reconnectCount).toBe(1);

      client.stop();
    });

    it('does not crash if onReconnect is null', async () => {
      const client = new GatewayWsClient();
      // onReconnect is null by default — should not throw

      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      // Drop and reconnect
      mockWsInstance.onclose?.();
      await vi.advanceTimersByTimeAsync(1001);
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'new-nonce');
      const reconnectFrame = JSON.parse(
        mockWsInstance.send.mock.calls.find(
          (c: string[]) => {
            try {
              const f = JSON.parse(c[0]);
              return f.method === 'connect' && f.id !== connectFrame.id;
            } catch { return false; }
          },
        )![0],
      );
      sendConnectResponse(mockWsInstance, reconnectFrame.id);
      await vi.advanceTimersByTimeAsync(1);

      // Should not have thrown
      expect(client.isConnected()).toBe(true);
      client.stop();
    });
  });

  describe('keepalive', () => {
    it('sends health ping every 30s after auth and emits GW_KEEPALIVE_OK on success', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      mockWsInstance.send.mockClear();

      // Advance 30s to trigger keepalive
      await vi.advanceTimersByTimeAsync(30_000);

      // Should have sent a health request
      expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
      const healthFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(healthFrame.method).toBe('health');

      // Send success response
      mockWsInstance.onmessage?.({
        data: JSON.stringify({ type: 'res', id: healthFrame.id, ok: true, payload: {} }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(emitted.some(e => e.type === 'GW_KEEPALIVE_OK')).toBe(true);
      client.stop();
    });

    it('closes connection on keepalive timeout and emits GW_KEEPALIVE_FAILED', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;

      // Advance 30s to trigger keepalive
      await vi.advanceTimersByTimeAsync(30_000);

      // Don't respond to health — let it timeout (5s)
      await vi.advanceTimersByTimeAsync(5001);

      expect(emitted.some(e => e.type === 'GW_KEEPALIVE_FAILED')).toBe(true);
      // close() should have been called to trigger reconnect
      expect(mockWsInstance.close).toHaveBeenCalled();
      client.stop();
    });
  });

  describe('edge cases', () => {
    it('ignores malformed messages', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);

      // Send garbage — should not crash
      mockWsInstance.onmessage?.({ data: 'not json at all' });
      mockWsInstance.onmessage?.({ data: '{"type":"unknown_type"}' });
      mockWsInstance.onmessage?.({ data: '{"type":"res","id":"nonexistent"}' });

      // Should still be able to complete auth
      sendChallenge(mockWsInstance);
      const connectFrame = JSON.parse(
        mockWsInstance.send.mock.calls.find(
          (c: string[]) => JSON.parse(c[0]).method === 'connect',
        )![0],
      );
      sendConnectResponse(mockWsInstance, connectFrame.id);
      await connectPromise;
    });

    it('does not send connect request without nonce', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);

      // Challenge without nonce
      mockWsInstance.onmessage?.({
        data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: {} }),
      });

      // No connect request should have been sent
      const connectCalls = mockWsInstance.send.mock.calls.filter(
        (c: string[]) => {
          try { return JSON.parse(c[0]).method === 'connect'; } catch { return false; }
        },
      );
      expect(connectCalls).toHaveLength(0);

      // Clean up: catch rejection BEFORE advancing timers to avoid unhandled rejection window
      const catchPromise = connectPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(5001);
      await vi.advanceTimersByTimeAsync(1);
      await catchPromise;
      client.stop();
    });
  });

  // ── Device Auth in Connect Handshake ─────────────────────────────────
  //
  // These tests verify that GatewayWsClient properly includes Ed25519
  // device identity in connect handshakes (OpenClaw v2026.3.23+ scope
  // enforcement). The updated fs/crypto mocks allow the constructor to
  // generate a real Ed25519 keypair, so deviceIdentity is populated.

  describe('device auth in connect handshake', () => {
    // With the updated mocks (existsSync → false, real generateKeyPairSync),
    // the constructor generates a fresh device identity on each `new GatewayWsClient()`.
    // This is the default behavior for these tests.

    it('connect params include device field with id, publicKey, signature, signedAt, nonce', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'device-nonce-1');

      const frame = getConnectFrame(mockWsInstance)!;
      expect(frame).toBeTruthy();
      const params = frame.params as Record<string, unknown>;
      const device = params.device as Record<string, unknown>;

      expect(device).toBeTruthy();
      expect(device.id).toBeTruthy();
      expect(typeof device.id).toBe('string');
      expect(device.publicKey).toBeTruthy();
      expect(typeof device.publicKey).toBe('string');
      expect((device.publicKey as string)).toContain('BEGIN PUBLIC KEY');
      expect(device.signature).toBeTruthy();
      expect(typeof device.signature).toBe('string');
      expect(device.signedAt).toBeTruthy();
      expect(device.nonce).toBe('device-nonce-1');

      sendConnectResponse(mockWsInstance, frame.id as string);
      await connectPromise;
      client.stop();
    });

    it('connect params omit device field when device identity generation fails', async () => {
      // Make existsSync throw to prevent device identity creation
      vi.mocked(existsSync).mockImplementation(() => { throw new Error('fs broken'); });

      const client = new GatewayWsClient();

      // Restore for subsequent tests
      vi.mocked(existsSync).mockImplementation(() => false);

      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'no-device-nonce');

      const frame = getConnectFrame(mockWsInstance)!;
      const params = frame.params as Record<string, unknown>;
      expect(params.device).toBeUndefined();

      // Auth should fall back to shared token
      const auth = params.auth as Record<string, unknown>;
      expect(auth.token).toBe('test-token');

      sendConnectResponse(mockWsInstance, frame.id as string);
      await connectPromise;
      client.stop();
    });

    it('auth uses deviceToken when cached device token exists', async () => {
      // Mock readFileSync to return cached device token for .device-token.json
      const cachedToken = { token: 'dt_cached_abc', role: 'operator', scopes: ['operator.write'] };
      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        if (String(path).endsWith('.device-token.json')) return JSON.stringify(cachedToken);
        throw new Error('mock: file not found');
      });

      const client = new GatewayWsClient();

      // Restore default
      vi.mocked(readFileSync).mockImplementation(() => { throw new Error('mock: file not found'); });

      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'dt-nonce');

      const frame = getConnectFrame(mockWsInstance)!;
      const params = frame.params as Record<string, unknown>;
      const auth = params.auth as Record<string, unknown>;

      expect(auth.deviceToken).toBe('dt_cached_abc');
      expect(auth.token).toBeUndefined();

      sendConnectResponse(mockWsInstance, frame.id as string);
      await connectPromise;
      client.stop();
    });

    it('auth falls back to shared gateway token when no cached device token', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'fallback-nonce');

      const frame = getConnectFrame(mockWsInstance)!;
      const params = frame.params as Record<string, unknown>;
      const auth = params.auth as Record<string, unknown>;

      // No cached device token → shared token
      expect(auth.token).toBe('test-token');
      expect(auth.deviceToken).toBeUndefined();

      sendConnectResponse(mockWsInstance, frame.id as string);
      await connectPromise;
      client.stop();
    });

    it('caches device token when connect response includes auth.deviceToken', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'cache-nonce');

      const frame = getConnectFrame(mockWsInstance)!;

      // Send response with a device token
      sendConnectResponse(mockWsInstance, frame.id as string, true, {
        auth: { deviceToken: 'dt_new_xyz', role: 'operator', scopes: ['operator.write'] },
      });
      await connectPromise;

      // Verify writeFileSync was called with .device-token.json
      const writeCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => String(c[0]).endsWith('.device-token.json'),
      );
      expect(writeCall).toBeTruthy();
      const written = JSON.parse(writeCall![1] as string);
      expect(written.token).toBe('dt_new_xyz');
      expect(written.role).toBe('operator');

      client.stop();
    });

    it('does NOT cache device token when connect response has no auth.deviceToken', async () => {
      vi.mocked(writeFileSync).mockClear();

      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'no-cache-nonce');

      const frame = getConnectFrame(mockWsInstance)!;

      // Send response WITHOUT device token
      sendConnectResponse(mockWsInstance, frame.id as string, true, {});
      await connectPromise;

      // No write to .device-token.json
      const writeCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => String(c[0]).endsWith('.device-token.json'),
      );
      expect(writeCall).toBeUndefined();

      client.stop();
    });

    it('device signature nonce matches the challenge nonce', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'specific-nonce-42');

      const frame = getConnectFrame(mockWsInstance)!;
      const params = frame.params as Record<string, unknown>;
      const device = params.device as Record<string, unknown>;

      expect(device.nonce).toBe('specific-nonce-42');

      sendConnectResponse(mockWsInstance, frame.id as string);
      await connectPromise;
      client.stop();
    });

    it('constructor does not throw when device identity generation fails', () => {
      vi.mocked(existsSync).mockImplementation(() => { throw new Error('fs broken'); });
      // Should not throw
      const client = new GatewayWsClient();
      vi.mocked(existsSync).mockImplementation(() => false);
      // Client is usable — it just won't have device auth
      expect(client.isConnected()).toBe(false);
      client.stop();
    });

    it('cached device token persists across reconnects', async () => {
      const client = new GatewayWsClient();

      // First connect
      const connect1 = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'nonce-1');

      const frame1 = getConnectFrame(mockWsInstance)!;
      // Gateway issues a device token
      sendConnectResponse(mockWsInstance, frame1.id as string, true, {
        auth: { deviceToken: 'dt_persist_test' },
      });
      await connect1;

      // Force disconnect
      mockWsInstance.onclose?.();
      await vi.advanceTimersByTimeAsync(1);

      // Wait for reconnect (backoff is 1s)
      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(1);

      // After reconnect, check the connect params use the cached device token
      sendChallenge(mockWsInstance, 'nonce-2');
      await vi.advanceTimersByTimeAsync(1);

      // Find the LATEST connect frame (there will be two — one from initial, one from reconnect)
      const allConnectCalls = mockWsInstance.send.mock.calls.filter(
        (c: string[]) => { try { return JSON.parse(c[0]).method === 'connect'; } catch { return false; } },
      );
      const lastFrame = JSON.parse(allConnectCalls[allConnectCalls.length - 1][0]);
      const auth = (lastFrame.params as Record<string, unknown>).auth as Record<string, unknown>;
      expect(auth.deviceToken).toBe('dt_persist_test');

      sendConnectResponse(mockWsInstance, lastFrame.id as string);
      // Wait for connect to resolve
      await vi.advanceTimersByTimeAsync(1);
      client.stop();
    });

    it('scopes include operator.admin and operator.write in connect params', async () => {
      const client = new GatewayWsClient();
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'scope-nonce');

      const frame = getConnectFrame(mockWsInstance)!;
      const params = frame.params as Record<string, unknown>;
      const scopes = params.scopes as string[];

      expect(scopes).toContain('operator.admin');
      expect(scopes).toContain('operator.write');

      sendConnectResponse(mockWsInstance, frame.id as string);
      await connectPromise;
      client.stop();
    });

    it('connect works without any auth (no token, no device identity)', async () => {
      // No token
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      // No device identity
      vi.mocked(existsSync).mockImplementation(() => { throw new Error('no fs'); });

      const client = new GatewayWsClient();

      vi.mocked(existsSync).mockImplementation(() => false);

      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(1);
      sendChallenge(mockWsInstance, 'no-auth-nonce');

      const frame = getConnectFrame(mockWsInstance)!;
      const params = frame.params as Record<string, unknown>;

      // No device, no auth token — auth may be absent or empty
      expect(params.device).toBeUndefined();
      expect((params.auth as Record<string, unknown>)?.token).toBeUndefined();
      expect((params.auth as Record<string, unknown>)?.deviceToken).toBeUndefined();

      sendConnectResponse(mockWsInstance, frame.id as string);
      await connectPromise;
      expect(client.isConnected()).toBe(true);
      client.stop();
    });

    it('device identity file is written with mode 0600 during generation', async () => {
      vi.mocked(writeFileSync).mockClear();

      const _client = new GatewayWsClient();

      // Constructor generates device keys → writeFileSync called for .device-identity.json
      const identityWrite = vi.mocked(writeFileSync).mock.calls.find(
        (c) => String(c[0]).endsWith('.device-identity.json'),
      );
      expect(identityWrite).toBeTruthy();
      // Third arg is the options object with mode
      const opts = identityWrite![2] as { mode: number };
      expect(opts.mode).toBe(0o600);

      _client.stop();
    });
  });
});
