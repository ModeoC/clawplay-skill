/**
 * Shared test factories and mock helpers.
 *
 * Centralizes makeView(), makeContext(), makeMockGatewayClient(), and makeSession()
 * so individual test files don't duplicate factory boilerplate.
 */

import { GameSession } from '../game-session.js';
import type { GameSessionConfig } from '../game-session.js';
import type { PlayerView, PlayerInfo, ListenerContext, GameTransition } from '../types.js';

// ── PlayerView factory ──────────────────────────────────────────────

export function makeView(overrides: Partial<PlayerView> = {}): PlayerView {
  const base: PlayerView = {
    gameId: 'game-1',
    handNumber: 1,
    phase: 'PREFLOP',
    pot: 30,
    boardCards: [],
    yourSeat: 0,
    yourCards: ['As', 'Kh'],
    yourChips: 970,
    yourBet: 10,
    isYourTurn: false,
    canRebuy: false,
    availableActions: [],
    players: [
      {
        userId: 'user-hero', seat: 0, name: 'Hero', chips: 970, bet: 10,
        invested: 10, status: 'active', isDealer: true, isCurrentActor: false,
      },
      {
        userId: 'user-alice', seat: 1, name: 'Alice', chips: 980, bet: 20,
        invested: 20, status: 'active', isDealer: false, isCurrentActor: true,
      },
    ],
    dealerSeat: 0,
    numSeats: 6,
    forcedBets: { smallBlind: 10, bigBlind: 20, ante: 0 },
    sidePots: [],
    currentPlayerToAct: 1,
    timeoutAt: null,
  };

  const result = { ...base, ...overrides };
  if (overrides.players !== undefined) {
    result.players = overrides.players;
  }
  return result;
}

// ── PlayerInfo helper ───────────────────────────────────────────────

export function withPlayerUpdate(view: PlayerView, seat: number, playerOverrides: Partial<PlayerInfo>): PlayerView {
  const cloned = { ...view, players: view.players.map((p) => ({ ...p })) };
  const player = cloned.players.find((p) => p.seat === seat);
  if (player) {
    Object.assign(player, playerOverrides);
  }
  return cloned;
}

// ── ListenerContext factory ─────────────────────────────────────────

export function makeContext(overrides: Partial<ListenerContext> = {}): ListenerContext {
  return { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null, ...overrides };
}

// ── Mock gateway client ─────────────────────────────────────────────

export interface MockGatewayClient {
  callAgent: (...args: unknown[]) => Promise<{ payloads: Array<{ text?: string }> }>;
  connect: () => Promise<void>;
  stop: () => void;
}

export function makeMockGatewayClient(response = '{"action":"fold","narration":"I fold"}'): MockGatewayClient {
  return {
    callAgent: async () => ({ payloads: [{ text: response }] }),
    connect: async () => {},
    stop: () => {},
  };
}

// ── GameSession factory ─────────────────────────────────────────────

export interface SessionTestKit {
  session: GameSession;
  emitted: Array<Record<string, unknown>>;
  debugLog: Array<{ label: string; data: Record<string, unknown> }>;
  notifyCalls: string[];
}

export function makeSession(overrides: Partial<GameSessionConfig> = {}): SessionTestKit {
  const emitted: Array<Record<string, unknown>> = [];
  const debugLog: Array<{ label: string; data: Record<string, unknown> }> = [];
  const notifyCalls: string[] = [];

  const config: GameSessionConfig = {
    channel: 'telegram',
    chatId: '12345',
    agentId: 'main',
    backendUrl: 'http://127.0.0.1:1',  // Use an unreachable port — fetch fails fast
    apiKey: 'test-key',
    deliveryAccount: null,
    reflectEveryNHands: 3,
    gatewayClient: makeMockGatewayClient() as unknown as GameSessionConfig['gatewayClient'],
    debugFn: (label, data) => { debugLog.push({ label, data }); },
    emitFn: (obj) => { emitted.push(obj as Record<string, unknown>); },
    ...overrides,
  };

  const session = new GameSession(config);

  // Stub out notifyAgent/notifyAgentSilent to prevent execFile('openclaw', ...) in tests
  session.notifyAgent = async (msg: string) => { notifyCalls.push(msg); };
  session.notifyAgentSilent = async (msg: string) => { notifyCalls.push(msg); };

  return { session, emitted, debugLog, notifyCalls };
}

/**
 * Create a session WITHOUT stubbing notifyAgent/notifyAgentSilent.
 * The real methods will run — suppressed signals emit SIGNAL_SUPPRESSED and return early,
 * unsuppressed signals attempt execFile('openclaw') which fails in test → NOTIFY_AGENT_ERROR.
 */
export function makeRealNotifySession(suppressedSignals: string[]): { session: GameSession; emitted: Array<Record<string, unknown>> } {
  const emitted: Array<Record<string, unknown>> = [];
  const config: GameSessionConfig = {
    channel: 'telegram',
    chatId: '12345',
    agentId: 'main',
    backendUrl: 'http://127.0.0.1:1',
    apiKey: 'test-key',
    deliveryAccount: null,
    reflectEveryNHands: 3,
    suppressedSignals,
    gatewayClient: makeMockGatewayClient() as unknown as GameSessionConfig['gatewayClient'],
    debugFn: () => {},
    emitFn: (obj) => { emitted.push(obj as Record<string, unknown>); },
  };
  return { session: new GameSession(config), emitted };
}
