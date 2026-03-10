import { readFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import { readClawPlayConfig, resolveApiKey, readLocalVersion, SKILL_ROOT } from './review.js';
import { controlSignals } from './prompts.js';
import type { ListenerContext, ListenerOutput } from './types.js';
import { GatewayWsClient } from './gateway-client.js';
import { GameSession } from './game-session.js';
export { processStateEvent } from './state-processor.js';

// ── Debug logging ────────────────────────────────────────────────────

let debugStream: WriteStream | null = null;

function initDebugLog(): void {
  const logPath = join(SKILL_ROOT, 'poker-debug.log');
  debugStream = createWriteStream(logPath, { flags: 'w' });
  debugStream.on('error', () => { debugStream = null; });
}

function debug(label: string, data: Record<string, unknown>): void {
  if (!debugStream) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const lines: string[] = [`[${ts}] ${label}`];
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'string' && val.includes('\n')) {
      lines.push(`  ${key}: |`);
      for (const line of val.split('\n')) lines.push(`    ${line}`);
    } else {
      lines.push(`  ${key}: ${JSON.stringify(val)}`);
    }
  }
  debugStream.write(lines.join('\n') + '\n\n');
}

// ── Delivery args ────────────────────────────────────────────────────

const CHANNEL_ALIASES = new Set(['--channel']);
const CHAT_ID_ALIASES = new Set(['--chat-id', '--target', '--to']);
const ACCOUNT_ALIASES = new Set(['--account']);

const MODE_ALIASES = new Set(['--mode']);

export function parseDirectArgs(argv: string[]): { enabled: boolean; channel: string | null; chatId: string | null; account: string | null; debug: boolean; mode: 'game' | 'lobby' | null } {
  let channel: string | null = null;
  let chatId: string | null = null;
  let account: string | null = null;
  let debugFlag = false;
  let mode: 'game' | 'lobby' | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (CHANNEL_ALIASES.has(argv[i]) && argv[i + 1]) channel = argv[i + 1];
    if (CHAT_ID_ALIASES.has(argv[i]) && argv[i + 1]) chatId = argv[i + 1];
    if (ACCOUNT_ALIASES.has(argv[i]) && argv[i + 1]) account = argv[i + 1];
    if (MODE_ALIASES.has(argv[i]) && argv[i + 1]) {
      const m = argv[i + 1];
      mode = m === 'game' ? 'game' : 'lobby';
    }
    if (argv[i] === '--debug') debugFlag = true;
  }

  const enabled = !!(channel && chatId);
  return { enabled, channel, chatId, account, debug: debugFlag, mode };
}

// ── Crash handlers ──────────────────────────────────────────────────

process.on('uncaughtException', (err: Error) => {
  emit({ type: 'CRASH', error: err.message });
  debugStream?.end();
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  emit({ type: 'CRASH', error: msg });
  debugStream?.end();
  process.exit(1);
});

// ── Unified mode SSE ────────────────────────────────────────────────

interface UnifiedModeConfig {
  backendUrl: string;
  apiKey: string;
  session: GameSession;
  EventSourceClass: new (url: string) => EventSource;
  gatewayClient: GatewayWsClient;
  startupVersion: string;
}

/**
 * Connects to /api/me/stream (unified player stream) and handles ALL events:
 * lobby (invite, follow), game (state, closed, left), invite-response, keepalive.
 * Never exits except for fatal errors, SIGTERM, or version staleness.
 */
function runUnifiedMode(config: UnifiedModeConfig): Promise<void> {
  const { backendUrl, apiKey, session, EventSourceClass, gatewayClient, startupVersion } = config;
  const sseUrl = `${backendUrl}/api/me/stream?token=${apiKey}`;

  return new Promise<void>((resolve) => {
    let context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
    let inGame = false;
    let es: EventSource;
    const HEARTBEAT_TIMEOUT_MS = 90_000;
    const MAX_RECONNECT_ATTEMPTS = 3;
    const RECONNECT_DELAY_MS = 3_000;

    let heartbeatCheckRunning = false;
    const heartbeatCheck = setInterval(async () => {
      if (heartbeatCheckRunning) return;
      if (Date.now() - session.lastEventTime > HEARTBEAT_TIMEOUT_MS) {
        heartbeatCheckRunning = true;
        try {
          emit({ type: 'HEARTBEAT_TIMEOUT', lastEventAge: Date.now() - session.lastEventTime });

          if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            fatalExit('Connection lost after reconnect attempts');
          } else {
            session.reconnectAttempts++;
            emit({ type: 'SSE_RECONNECT_ATTEMPT', attempt: session.reconnectAttempts });
            es.close();
            setTimeout(() => connectSSE(), RECONNECT_DELAY_MS * 2 ** (session.reconnectAttempts - 1));
          }
        } finally {
          heartbeatCheckRunning = false;
        }
      }
    }, 15_000);

    function fatalExit(reason: string): void {
      clearInterval(heartbeatCheck);
      emit({ type: 'FATAL_EXIT', reason });
      es?.close();
      gatewayClient.stop();
      debugStream?.end();
      resolve();
    }

    /**
     * Called when the current game ends (closed, left, or connection error).
     * Notifies the agent, resets session state, continues listening.
     */
    async function onGameEnd(reason: string, isError = false): Promise<void> {
      if (!inGame) {
        emit({ type: 'GAME_END_DUPLICATE', reason });
        return;
      }
      inGame = false;

      const finalStack = context.prevState?.yourChips ?? 'unknown';
      const reflectionStats = session.getReflectionStats();

      // Best-effort leave API call (only for non-table-closed endings)
      if (reason !== 'Table closed') {
        fetch(`${backendUrl}/api/me/game/leave`, {
          method: 'POST',
          headers: { 'x-api-key': apiKey },
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }

      // Notify agent — use connectionError for fatal failures, gameOver for normal endings
      const signal = isError
        ? controlSignals.connectionError(session.gameId, reason, finalStack, reflectionStats)
        : controlSignals.gameOver(session.gameId, reason, finalStack, reflectionStats);
      await session.notifyAgent(signal);

      // Reset session and context for next game
      session.resetForNewGame();
      context = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };

      emit({ type: 'GAME_ENDED', reason });

      // Check for version staleness after game ends
      const currentVersion = readLocalVersion();
      if (startupVersion !== 'unknown' && currentVersion !== startupVersion) {
        emit({ type: 'VERSION_STALE', startupVersion, currentVersion });
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        fatalExit('Version stale — restarting');
      }
    }

    // Wire up fatal decision failure handler
    session.onFatalDecisionFailure = (reason: string) => {
      void onGameEnd(reason, true);
    };

    function connectSSE(): void {
      if (es) es.close();
      es = new EventSourceClass(sseUrl);
      session.lastEventTime = Date.now();
      session.lastStateEventTime = Date.now();

      es.onopen = () => {
        session.onSSEOpen();
      };

      // ── Game events ──────────────────────────────────────────
      es.addEventListener('state', (event: MessageEvent) => {
        session.lastEventTime = Date.now();
        session.lastStateEventTime = Date.now();
        session.reconnectAttempts = 0;
        try {
          const data = JSON.parse(event.data);
          if (!inGame) {
            inGame = true;
            emit({ type: 'GAME_STARTED', gameId: data.gameId });
          }
          session.handleStateEvent(data, context, (reason: string, _exitCode: number) => {
            void onGameEnd(reason);
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          emit({ type: 'CONNECTION_ERROR', error: `Failed to process state event: ${msg}` });
        }
      });

      es.addEventListener('closed', () => {
        session.lastEventTime = Date.now();
        void onGameEnd('Table closed');
      });

      es.addEventListener('left', () => {
        session.lastEventTime = Date.now();
        void onGameEnd('Left the table');
      });

      // ── Lobby events ─────────────────────────────────────────
      es.addEventListener('invite', (event: MessageEvent) => {
        session.lastEventTime = Date.now();
        try {
          const data = JSON.parse(event.data);
          emit({ type: 'LOBBY_INVITE_RECEIVED', data });
          session.notifyAgent(
            controlSignals.inviteReceived(data.inviterName, data.gameMode, data.inviteId, data.tableId),
          ).catch(() => {});
        } catch {
          emit({ type: 'LOBBY_EVENT_PARSE_ERROR', raw: event.data });
        }
      });

      es.addEventListener('follow', (event: MessageEvent) => {
        session.lastEventTime = Date.now();
        try {
          const data = JSON.parse(event.data);
          emit({ type: 'LOBBY_FOLLOW_RECEIVED', data });
          session.notifyAgentSilent(controlSignals.newFollower(data.followerName)).catch(() => {});
        } catch {
          emit({ type: 'LOBBY_EVENT_PARSE_ERROR', raw: event.data });
        }
      });

      // ── Invite response events ───────────────────────────────
      es.addEventListener('invite-response', (event: MessageEvent) => {
        session.lastEventTime = Date.now();
        try {
          const data = JSON.parse(event.data) as { status: string; inviteeName: string };
          emit({ type: 'INVITE_RESPONSE_RECEIVED', data });
          if (data.status === 'accepted') {
            session.notifyAgentSilent(controlSignals.inviteAccepted(data.inviteeName)).catch(() => {});
          } else {
            session.notifyAgentSilent(controlSignals.inviteDeclined(data.inviteeName)).catch(() => {});
          }
        } catch {
          emit({ type: 'LOBBY_EVENT_PARSE_ERROR', raw: event.data });
        }
      });

      // ── Keepalive ────────────────────────────────────────────
      es.addEventListener('keepalive', () => {
        session.lastEventTime = Date.now();
        session.reconnectAttempts = 0;
      });

      es.onerror = (err: Event) => {
        const msg = 'message' in err ? (err as { message?: string }).message : 'unknown';
        emit({ type: 'CONNECTION_ERROR', error: `SSE connection error: ${msg || 'unknown'}` });
      };
    }

    connectSSE();

    // Signal handlers
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        emit({ type: 'SIGNAL_EXIT', signal });
        if (inGame) {
          // Best-effort leave
          fetch(`${backendUrl}/api/me/game/leave`, {
            method: 'POST',
            headers: { 'x-api-key': apiKey },
            signal: AbortSignal.timeout(3000),
          }).catch(() => {});
        }
        fatalExit('Session terminated');
      });
    }
  });
}

// ── Legacy lobby mode SSE (kept for --mode lobby backwards compat) ───

interface LobbyModeConfig {
  backendUrl: string;
  apiKey: string;
  session: GameSession;
  EventSourceClass: new (url: string) => EventSource;
}

function runLobbyMode(config: LobbyModeConfig): Promise<void> {
  const { backendUrl, apiKey, session, EventSourceClass } = config;
  const sseUrl = `${backendUrl}/api/lobby/stream?token=${apiKey}`;

  return new Promise<void>((resolve) => {
    emit({ type: 'LOBBY_MODE_START' });
    const es = new EventSourceClass(sseUrl);
    let lastEventTime = Date.now();

    const statusPoll = setInterval(async () => {
      try {
        const resp = await fetch(`${backendUrl}/api/lobby/status`, {
          headers: { 'x-api-key': apiKey },
          signal: AbortSignal.timeout(5_000),
        });
        if (resp.ok) {
          const data = await resp.json() as { status: string };
          if (data.status === 'playing') {
            emit({ type: 'LOBBY_GAME_DETECTED' });
            clearInterval(statusPoll);
            es.close();
            resolve();
          }
        }
      } catch {}
    }, 30_000);

    const lobbyHeartbeat = setInterval(() => {
      if (Date.now() - lastEventTime > 120_000) {
        emit({ type: 'LOBBY_HEARTBEAT_TIMEOUT' });
        clearInterval(lobbyHeartbeat);
        clearInterval(statusPoll);
        es.close();
        resolve();
      }
    }, 15_000);

    es.addEventListener('invite', (event: MessageEvent) => {
      lastEventTime = Date.now();
      try {
        const data = JSON.parse(event.data);
        emit({ type: 'LOBBY_INVITE_RECEIVED', data });
        session.notifyAgent(
          controlSignals.inviteReceived(data.inviterName, data.gameMode, data.inviteId, data.tableId),
        ).catch(() => {});
      } catch {
        emit({ type: 'LOBBY_EVENT_PARSE_ERROR', raw: event.data });
      }
    });

    es.addEventListener('follow', (event: MessageEvent) => {
      lastEventTime = Date.now();
      try {
        const data = JSON.parse(event.data);
        emit({ type: 'LOBBY_FOLLOW_RECEIVED', data });
        session.notifyAgentSilent(controlSignals.newFollower(data.followerName)).catch(() => {});
      } catch {
        emit({ type: 'LOBBY_EVENT_PARSE_ERROR', raw: event.data });
      }
    });

    es.addEventListener('keepalive', () => {
      lastEventTime = Date.now();
    });

    es.onerror = () => {
      emit({ type: 'LOBBY_SSE_ERROR' });
    };
  });
}

// ── Legacy game mode (kept for --mode game backwards compat) ────────

interface GameModeConfig {
  backendUrl: string;
  apiKey: string;
  session: GameSession;
  EventSourceClass: new (url: string) => EventSource;
  gatewayClient: GatewayWsClient;
  skipSignalHandlers?: boolean;
}

function runGameMode(config: GameModeConfig): Promise<void> {
  const { backendUrl, apiKey, session, EventSourceClass, gatewayClient } = config;
  const sseUrl = `${backendUrl}/api/me/game/stream?token=${apiKey}`;

  return new Promise<void>((resolve) => {
    const context: ListenerContext = { prevState: null, prevPhase: null, lastActionType: null, lastReportedHand: 0, lastTurnKey: null };
    let es: EventSource;
    const HEARTBEAT_TIMEOUT_MS = 90_000;
    const MAX_RECONNECT_ATTEMPTS = 3;
    const RECONNECT_DELAY_MS = 3_000;

    let heartbeatCheckRunning = false;
    const heartbeatCheck = setInterval(async () => {
      if (heartbeatCheckRunning) return;
      if (Date.now() - session.lastEventTime > HEARTBEAT_TIMEOUT_MS) {
        heartbeatCheckRunning = true;
        try {
          emit({ type: 'HEARTBEAT_TIMEOUT', lastEventAge: Date.now() - session.lastEventTime });

          try {
            const resp = await fetch(`${backendUrl}/api/me/game`, {
              headers: { 'x-api-key': apiKey },
              signal: AbortSignal.timeout(5_000),
            });
            if (!resp.ok) {
              emit({ type: 'STATUS_CHECK', status: resp.status });
              gracefulExit('Left the table', 0);
              return;
            }
          } catch {}

          if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            gracefulExit('Connection lost after reconnect attempts', 1);
          } else {
            session.reconnectAttempts++;
            emit({ type: 'SSE_RECONNECT_ATTEMPT', attempt: session.reconnectAttempts });
            es.close();
            setTimeout(() => connectSSE(), RECONNECT_DELAY_MS * 2 ** (session.reconnectAttempts - 1));
          }
        } finally {
          heartbeatCheckRunning = false;
        }
      }
      else if (Date.now() - session.lastStateEventTime > HEARTBEAT_TIMEOUT_MS) {
        heartbeatCheckRunning = true;
        try {
          emit({ type: 'STATE_SILENCE_DETECTED', lastStateAge: Date.now() - session.lastStateEventTime });
          try {
            const resp = await fetch(`${backendUrl}/api/me/game`, {
              headers: { 'x-api-key': apiKey },
              signal: AbortSignal.timeout(5_000),
            });
            if (!resp.ok) {
              emit({ type: 'STATUS_CHECK', status: resp.status });
              gracefulExit('Left the table', 0);
              return;
            }
            session.lastStateEventTime = Date.now();
          } catch {}
        } finally {
          heartbeatCheckRunning = false;
        }
      }
    }, 15_000);

    let exitInProgress = false;

    function gracefulExit(reason: string, exitCode: number): void {
      if (exitInProgress) return;
      exitInProgress = true;
      clearInterval(heartbeatCheck);

      const isRebuyState = exitCode !== 0
        && context.prevState?.canRebuy === true
        && context.prevState?.yourChips === 0;

      const finalStack = context.prevState?.yourChips ?? 'unknown';

      if (reason !== 'Table closed' && !isRebuyState) {
        fetch(`${backendUrl}/api/me/game/leave`, {
          method: 'POST',
          headers: { 'x-api-key': apiKey },
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }

      if (isRebuyState) {
        es?.close();
        resolve();
        return;
      }

      const reflectionStats = session.getReflectionStats();
      const notifyDone = exitCode === 0
        ? session.notifyAgent(controlSignals.gameOver(session.gameId, reason, finalStack, reflectionStats))
        : session.notifyAgent(controlSignals.connectionError(session.gameId, reason, finalStack, reflectionStats));

      notifyDone.then(() => { es?.close(); resolve(); });

      const forceExit = setTimeout(() => { es?.close(); resolve(); }, 30_000);
      forceExit.unref();
    }

    session.onFatalDecisionFailure = (reason: string) => gracefulExit(reason, 1);

    function connectSSE(): void {
      if (es) es.close();
      es = new EventSourceClass(sseUrl);
      session.lastEventTime = Date.now();
      session.lastStateEventTime = Date.now();

      es.onopen = () => {
        session.onSSEOpen();
      };

      es.addEventListener('state', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          session.handleStateEvent(data, context, gracefulExit);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          emit({ type: 'CONNECTION_ERROR', error: `Failed to process state event: ${msg}` });
          gracefulExit(`State parse error: ${msg}`, 1);
        }
      });

      es.addEventListener('keepalive', () => {
        session.lastEventTime = Date.now();
        session.reconnectAttempts = 0;
      });

      es.addEventListener('closed', () => {
        session.lastEventTime = Date.now();
        gracefulExit('Table closed', 0);
      });

      es.onerror = (err: Event) => {
        const msg = 'message' in err ? (err as { message?: string }).message : 'unknown';
        emit({ type: 'CONNECTION_ERROR', error: `SSE connection error: ${msg || 'unknown'}` });
      };
    }

    connectSSE();

    if (!config.skipSignalHandlers) {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
          emit({ type: 'SIGNAL_EXIT', signal });
          gatewayClient.stop();
          debugStream?.end();
          gracefulExit('Session terminated', 0);
        });
      }
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const backendUrl = 'https://api.clawplay.fun';
  const config = readClawPlayConfig();
  const apiKey = resolveApiKey(config) ?? '';

  if (!apiKey) {
    emit({ type: 'CONNECTION_ERROR', error: 'CLAWPLAY_API_KEY_PRIMARY must be set (env var, or apiKeyEnvVar in clawplay-config.json). Usage: node clawplay-listener.js --channel <name> --chat-id <id>' });
    process.exit(1);
  }

  const direct = parseDirectArgs(process.argv);
  if (!direct.enabled || !direct.channel || !direct.chatId) {
    emit({ type: 'CONNECTION_ERROR', error: '--channel and --chat-id are required' });
    process.exit(1);
  }
  initDebugLog(); // Always enable debug logging for post-mortem analysis
  const channel = direct.channel;
  const chatId = direct.chatId;
  const deliveryAccount = direct.account ?? config.accountId ?? null;
  const agentId = config.agentId ?? 'main';
  const listenerMode = direct.mode ?? config.listenerMode ?? 'lobby';
  const reflectEveryNHands = config.reflectEveryNHands ?? 3;
  const startupVersion = readLocalVersion();

  // Read agent personality files for subagent decision/reflection prompts
  let personalityContext = '';
  const home = process.env.HOME || '/root';
  const workspaceDir = join(home, '.openclaw', agentId === 'main' ? 'workspace' : `workspace-${agentId}`);
  for (const file of ['SOUL.md', 'IDENTITY.md']) {
    try {
      const content = readFileSync(join(workspaceDir, file), 'utf8').trim();
      if (content) personalityContext += `\n\n## ${file}\n${content}`;
    } catch {}
  }
  personalityContext = personalityContext.trim();
  emit({ type: 'PERSONALITY_CONTEXT', loaded: !!personalityContext, chars: personalityContext.length });

  emit({ type: 'DELIVERY_MODE', channel, chatId: '***', account: deliveryAccount ?? 'default', agentId });

  let EventSourceClass: new (url: string) => EventSource;
  try {
    const mod: Record<string, unknown> = await import('eventsource');
    EventSourceClass = (mod.default || mod.EventSource) as new (url: string) => EventSource;
  } catch {
    emit({ type: 'CONNECTION_ERROR', error: 'eventsource package not available' });
    process.exit(1);
  }

  // Create gateway WS client and game session
  const gatewayClient = new GatewayWsClient({
    emit: (obj) => {
      emit(obj);
      // Route GW events to debug log for post-mortem diagnostics
      const t = obj.type as string | undefined;
      if (t?.startsWith('GW_')) debug(t, obj);
    },
  });

  const suppressedSignals = config.suppressedSignals ?? [];

  const session = new GameSession({
    channel,
    chatId,
    agentId,
    backendUrl,
    apiKey,
    deliveryAccount,
    reflectEveryNHands,
    suppressedSignals,
    gatewayClient,
    debugFn: debug,
    emitFn: emit,
  });
  session.personalityContext = personalityContext;

  // Connect gateway WS client with retry (gateway may still be starting after restart)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await gatewayClient.connect();
      debug('GW_STARTUP_CONNECTED', { attempt });
      break;
    } catch (gwErr) {
      const msg = gwErr instanceof Error ? gwErr.message : String(gwErr);
      debug('GW_STARTUP_RETRY', { attempt, error: msg });
      emit({ type: 'GW_CONNECT_FAILED', error: msg, attempt });
      if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
      else debug('GW_STARTUP_EXHAUSTED', { attempts: 5 });
    }
  }

  // ── Lobby mode (default) ────────────────────────────────────────
  if (listenerMode !== 'game') {
    emit({ type: 'MODE', mode: 'lobby' });
    await runUnifiedMode({ backendUrl, apiKey, session, EventSourceClass, gatewayClient, startupVersion });
    return;
  }

  // ── Legacy game mode ──────────────────────────────────────────────
  emit({ type: 'MODE', mode: 'game' });
  await runGameMode({ backendUrl, apiKey, session, EventSourceClass, gatewayClient });
}

function emit(obj: Record<string, unknown> | ListenerOutput): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isDirectRun) {
  main();
}
