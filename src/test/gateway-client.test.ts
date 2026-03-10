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

// Mock crypto for deterministic UUIDs
let uuidCounter = 0;
vi.mock('node:crypto', () => ({
  randomUUID: () => `test-uuid-${++uuidCounter}`,
}));

// Mock fs to prevent reading real config files
vi.mock('node:fs', () => ({
  readFileSync: () => { throw new Error('mock: file not found'); },
}));

// Now import the class under test
const { GatewayWsClient } = await import('../gateway-client.js');

// ── Test helpers ────────────────────────────────────────────────────

function sendChallenge(ws: MockWSInstance, nonce = 'test-nonce'): void {
  ws.onmessage?.({ data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce } }) });
}

function sendConnectResponse(ws: MockWSInstance, id: string, ok = true): void {
  ws.onmessage?.({ data: JSON.stringify({ type: 'res', id, ok, payload: ok ? {} : undefined, error: ok ? undefined : { message: 'Auth failed' } }) });
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

    it('callAgent emits GW_CALLAGENT_RETRY and propagates error when both attempts fail', async () => {
      const emitted: Record<string, unknown>[] = [];
      const client = new GatewayWsClient({ emit: (obj) => emitted.push(obj) });

      // First connect attempt — immediate close
      const callPromise = client.callAgent({ message: 'decide' }, 10000);
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      mockWsInstance.onclose?.();

      // Let the catch block in callAgent run (microtask propagation)
      await vi.advanceTimersByTimeAsync(0);

      // Should emit retry event
      expect(emitted.some(e => e.type === 'GW_CALLAGENT_RETRY')).toBe(true);

      // Advance past the 1s retry delay
      await vi.advanceTimersByTimeAsync(1001);

      // Second connect attempt — also fails
      await vi.advanceTimersByTimeAsync(1); // trigger onopen
      mockWsInstance.onclose?.();

      // Should propagate the error to the caller
      await expect(callPromise).rejects.toThrow();

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
});
