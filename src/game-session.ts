/**
 * GameSession — owns all per-game mutable state and the methods that operate on it.
 *
 * Extracted from clawplay-listener.ts module-level variables and inline logic.
 * The SSE handler in clawplay-listener.ts delegates to methods here.
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSummary,
  buildHandResultSummary,
  buildDecisionPrompt,
  buildReflectionPrompt,
  formatRecentHand,
  formatOpponentStats,
  controlSignals,
  WARMUP_MESSAGE,
} from './prompts.js';
import { processStateEvent } from './state-processor.js';
import { readPlaybook, readNotes, readClawPlayConfig, SKILL_ROOT } from './review.js';
import type {
  PlayerView,
  PlayerInfo,
  ListenerContext,
  ListenerOutput,
  DecisionResponse,
  GameTransition,
} from './types.js';
import type { GatewayWsClient } from './gateway-client.js';

// ── Config passed to constructor ────────────────────────────────────

export interface GameSessionConfig {
  channel: string;
  chatId: string;
  agentId: string;
  backendUrl: string;
  apiKey: string;
  deliveryAccount: string | null;
  reflectEveryNHands: number;
  suppressedSignals?: string[];
  tableChatReactive?: boolean;
  receiveOpponentChat?: boolean;
  gatewayClient: GatewayWsClient;
  debugFn: (label: string, data: Record<string, unknown>) => void;
  emitFn: (obj: Record<string, unknown> | ListenerOutput) => void;
}

// ── Session insights file ───────────────────────────────────────────

const INSIGHTS_FILE = join(SKILL_ROOT, 'poker-session-insights.txt');

function readSessionInsights(): string {
  try {
    return readFileSync(INSIGHTS_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeSessionInsights(insights: string): void {
  try { writeFileSync(INSIGHTS_FILE, insights + '\n'); } catch {}
}

function readHandNotes(): string {
  try {
    return readFileSync(join(SKILL_ROOT, 'poker-hand-notes.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

function handSessionId(gameId: string, handNumber: number): string {
  return `poker-${gameId}-h${handNumber}`;
}

// ── GameSession class ───────────────────────────────────────────────

export class GameSession {
  // Config (immutable after construction)
  readonly channel: string;
  readonly chatId: string;
  readonly agentId: string;
  readonly backendUrl: string;
  readonly apiKey: string;
  readonly deliveryAccount: string | null;
  readonly reflectEveryNHands: number;
  private readonly suppressedSignals: Set<string>;
  readonly gatewayClient: GatewayWsClient;
  private readonly debug: (label: string, data: Record<string, unknown>) => void;
  private readonly emit: (obj: Record<string, unknown> | ListenerOutput) => void;

  // Per-game mutable state
  gameId = 'unknown';
  currentHandNumber: number | null = null;
  decisionSeq = 0;
  lastDecision: Promise<void> = Promise.resolve();
  consecutiveDecisionFailures = 0;
  onFatalDecisionFailure: ((reason: string) => void) | null = null;
  onRefetchState: ((state: PlayerView & { transitions?: GameTransition[] }) => void) | null = null;

  // Reflection state
  reflectionTimeouts = 0;
  reflectionsSent = 0;
  handsSinceReflection = 0;
  reflectionInFlight = false;

  // Hand tracking
  lastHandUpdateTime = 0;
  gameStartedEmitted = false;
  recentEvents: string[] = [];
  currentHandEvents: string[] = [];
  chatHistory: string[] = [];         // chat-only, rolling max 30, survives reflections (for decisions)
  chatSinceReflection: string[] = []; // chat accumulator for reflection window, max 200, cleared after each reflection
  private firstHandNumber: number | null = null; // set on first state event; filters pre-join recentHands
  stackBeforeHand: number | null = null;
  foldedInHand: number | null = null;
  shortStackNotified = false; // prevents repeated HAND_UPDATE signals while persistently short-stacked

  // Hand cap tracking
  handsPlayedThisSession = 0;
  maxHandsPerDay: number | null = null; // set from config
  handsAtSessionStart = 0; // baseline from heartbeat handsToday
  /** Called when daily hand limit is reached; triggers leave + graceful exit. */
  onHandLimitReached: ((handsToday: number, max: number) => void) | null = null;
  /** Called when paused flag detected mid-game. */
  onPausedDetected: (() => void) | null = null;

  // Personality context (loaded once at startup)
  personalityContext = '';

  // Decision counter (total decisions attempted across all hands)
  decisionCount = 0;

  // SSE connection state
  sseFirstConnect = true;
  lastEventTime = Date.now();
  lastStateEventTime = Date.now();
  reconnectAttempts = 0;

  // Transitions from SSE (hook point for Phase 2 chat)
  lastTransitions: GameTransition[] = [];

  // Reactive chat state
  decisionInFlight = false;
  reactionInFlight = false;
  private readonly tableChatReactive: boolean;
  private readonly receiveOpponentChat: boolean;

  // Constants
  static readonly MAX_CONSECUTIVE_FAILURES = 3;
  static readonly HAND_UPDATE_COOLDOWN_MS = 30_000;
  static readonly MAX_CHAT_MESSAGE_LENGTH = 150;

  constructor(config: GameSessionConfig) {
    this.channel = config.channel;
    this.chatId = config.chatId;
    this.agentId = config.agentId;
    this.backendUrl = config.backendUrl;
    this.apiKey = config.apiKey;
    this.deliveryAccount = config.deliveryAccount;
    this.reflectEveryNHands = config.reflectEveryNHands;
    this.suppressedSignals = new Set(config.suppressedSignals ?? []);
    this.tableChatReactive = config.tableChatReactive ?? true;
    this.receiveOpponentChat = config.receiveOpponentChat ?? true;
    this.gatewayClient = config.gatewayClient;
    this.debug = config.debugFn;
    this.emit = config.emitFn;
  }

  // ── Game lifecycle ──────────────────────────────────────────────

  /** Reset per-game state when transitioning back to lobby (game ended, left, or table closed). */
  resetForNewGame(): void {
    this.gameId = 'unknown';
    this.currentHandNumber = null;
    this.decisionSeq = 0;
    this.lastDecision = Promise.resolve();
    this.consecutiveDecisionFailures = 0;
    this.reflectionTimeouts = 0;
    this.reflectionsSent = 0;
    this.handsSinceReflection = 0;
    this.reflectionInFlight = false;
    this.lastHandUpdateTime = 0;
    this.gameStartedEmitted = false;
    this.recentEvents = [];
    this.currentHandEvents = [];
    this.chatHistory = [];
    this.chatSinceReflection = [];
    this.firstHandNumber = null;
    this.stackBeforeHand = null;
    this.foldedInHand = null;
    this.shortStackNotified = false;
    this.lastTransitions = [];
    this.decisionInFlight = false;
    this.reactionInFlight = false;

    // Clear per-game files so stale data doesn't bleed into the next game
    try { unlinkSync(join(SKILL_ROOT, 'poker-notes.txt')); } catch {}
    try { unlinkSync(join(SKILL_ROOT, 'poker-hand-notes.txt')); } catch {}
    try { unlinkSync(INSIGHTS_FILE); } catch {}
  }

  /** Reset consecutive failure count (e.g. after gateway reconnects). */
  resetDecisionFailures(): void {
    this.consecutiveDecisionFailures = 0;
  }

  // ── SSE onopen handler ──────────────────────────────────────────

  onSSEOpen(): void {
    this.lastEventTime = Date.now();
    this.lastStateEventTime = Date.now();
    this.reconnectAttempts = 0;
    this.consecutiveDecisionFailures = 0;

    if (this.sseFirstConnect) {
      this.sseFirstConnect = false;
      // Clear per-game files to prevent stale reads
      try { unlinkSync(join(SKILL_ROOT, 'poker-notes.txt')); } catch {}
      try { unlinkSync(join(SKILL_ROOT, 'poker-hand-notes.txt')); } catch {}
      try { unlinkSync(INSIGHTS_FILE); } catch {}

      this.debug('SESSION_WARMUP', { gameId: this.gameId });
      this.gatewayClient.callAgent({
        agentId: this.agentId,
        sessionKey: `agent:${this.agentId}:subagent:poker-warmup`,
        sessionId: 'poker-warmup',
        message: WARMUP_MESSAGE,
        thinking: 'low',
        timeout: 15,
      }, 20_000).then(() => {
        this.emit({ type: 'SESSION_WARMUP_OK' });
      }).catch((e: unknown) => {
        this.emit({ type: 'WARMUP_FAILED', error: e instanceof Error ? e.message : String(e) });
      });
    } else {
      this.emit({ type: 'SSE_RECONNECT' });
    }
  }

  // ── Main state event handler ────────────────────────────────────

  handleStateEvent(
    data: PlayerView & { transitions?: GameTransition[] },
    context: ListenerContext,
    gracefulExit: (reason: string, exitCode: number) => void,
  ): void {
    this.lastEventTime = Date.now();
    this.lastStateEventTime = Date.now();

    const view: PlayerView = data;
    const transitions: GameTransition[] = data.transitions ?? [];
    this.lastTransitions = transitions;
    if (transitions.length > 0) {
      this.debug('TRANSITIONS', { count: transitions.length, types: transitions.map(t => t.type) });
    }

    // Track the first hand number seen — used to filter pre-join recentHands for mid-game joins
    if (this.firstHandNumber === null && view.handNumber) {
      this.firstHandNumber = view.handNumber;
    }

    // Extract table-chat transitions from other players into hand events and chat buffers
    for (const t of transitions) {
      if (t.type === 'table-chat' && t.seat !== view.yourSeat) {
        // Skip opponent chat entirely if disabled
        if (!this.receiveOpponentChat) continue;
        // Truncate message to 150 chars to limit injection payload size
        const rawMsg = String(t.message ?? '');
        const maxLen = GameSession.MAX_CHAT_MESSAGE_LENGTH;
        const msg = rawMsg.length > maxLen ? rawMsg.slice(0, maxLen) + '…' : rawMsg;
        // Attribution wrapping — clearly marks content as opponent-generated
        const chatLine = `[H${view.handNumber ?? this.currentHandNumber}] [OPPONENT CHAT] ${t.playerName as string}: "${msg}"`;
        this.currentHandEvents.push(chatLine);
        this.recentEvents.push(chatLine);
        if (this.recentEvents.length > 20) this.recentEvents.shift();
        this.chatHistory.push(chatLine);
        if (this.chatHistory.length > 30) this.chatHistory.shift();
        this.chatSinceReflection.push(chatLine);
        if (this.chatSinceReflection.length > 200) this.chatSinceReflection.shift();
      }
    }

    if (this.gameId === 'unknown' && view.gameId) this.gameId = view.gameId;
    this.reconnectAttempts = 0;

    const prevHandNumber = this.currentHandNumber;
    const handJustChanged = view.handNumber !== this.currentHandNumber;
    this.currentHandNumber = view.handNumber;

    const prevPlayers = context.prevState?.players || [];
    const outputs = processStateEvent(view, context, transitions);

    // Process outputs BEFORE onHandChanged so processHandResult reads
    // the previous hand's stackBeforeHand (not the new hand's chips).
    this.handleOutputs(outputs, view, prevPlayers, context);

    if (handJustChanged) {
      this.onHandChanged(view, prevHandNumber);
    }

    // Proactive leave detection
    if (view.hasPendingLeave && (view.phase === 'SHOWDOWN' || view.phase === 'WAITING')) {
      gracefulExit('Left the table', 0);
    }
  }

  // ── Hand transition logic ───────────────────────────────────────

  private onHandChanged(view: PlayerView, prevHandNumber: number | null): void {
    this.debug('HAND_CHANGED', { from: prevHandNumber, to: view.handNumber, stack: view.yourChips });

    // Hand 1: onopen already warmed up. Hand 2+: reflection (every N hands).
    if (prevHandNumber !== null) {
      this.handsSinceReflection++;
      if (this.handsSinceReflection >= this.reflectEveryNHands && !this.reflectionInFlight) {
        this.triggerReflection(view);
      }
    }

    this.stackBeforeHand = view.yourChips;
    this.currentHandEvents = [];
    this.foldedInHand = null;
    try { unlinkSync(join(SKILL_ROOT, 'poker-hand-notes.txt')); } catch {}
  }

  // ── Reflection scheduling ───────────────────────────────────────

  private triggerReflection(view: PlayerView): void {
    this.handsSinceReflection = 0;
    this.reflectionsSent++;
    this.reflectionInFlight = true;

    const eligibleReflectionHands = view.recentHands
      ?.filter(h => this.firstHandNumber === null || h.handNumber >= this.firstHandNumber);
    const recentHandLines = eligibleReflectionHands?.length
      ? eligibleReflectionHands.slice(-5).map(formatRecentHand)
      : [];
    const opponentStatsLines = view.playerStats
      ? formatOpponentStats(view.playerStats)
      : [];
    const currentInsights = readSessionInsights() || 'No session insights yet.';
    const recentChatLines = this.chatSinceReflection;
    const reflectionPrompt = buildReflectionPrompt(opponentStatsLines, recentHandLines, currentInsights, recentChatLines);
    this.debug('REFLECTION_PROMPT', { hand: view.handNumber, prompt: reflectionPrompt });

    const reflectionHandNumber = view.handNumber;
    this.gatewayClient.callAgent({
      agentId: this.agentId,
      sessionKey: `agent:${this.agentId}:subagent:poker-${this.gameId}-reflect`,
      sessionId: `poker-${this.gameId}-reflect`,
      message: reflectionPrompt,
      timeout: 35,
      extraSystemPrompt: this.personalityContext || undefined,
    }, 40_000).then(result => {
      const agentText = [...(result.payloads || [])].reverse().find((p: { text?: string }) => p.text)?.text || '';
      const innerStart = agentText.indexOf('{');
      const innerEnd = agentText.lastIndexOf('}');
      if (innerStart >= 0 && innerEnd > innerStart) {
        const parsed = JSON.parse(agentText.slice(innerStart, innerEnd + 1));
        if (parsed.insights && typeof parsed.insights === 'string') {
          writeSessionInsights(parsed.insights.trim());
          this.chatSinceReflection = [];
          this.debug('REFLECTION_RESPONSE', { hand: reflectionHandNumber, insights: parsed.insights.trim(), rawAgentText: agentText.slice(0, 500) });
          this.emit({ type: 'SESSION_INSIGHTS_UPDATED', hand: reflectionHandNumber });
        }
      }
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = msg.includes('aborted') || msg.includes('timeout') || msg.includes('Timeout');
      this.reflectionTimeouts += isTimeout ? 1 : 0;
      this.emit({ type: isTimeout ? 'REFLECTION_TIMEOUT' : 'REFLECTION_ERROR', error: msg });
    }).finally(() => { this.reflectionInFlight = false; });
  }

  // ── Output dispatch (the switch statement) ──────────────────────

  handleOutputs(outputs: ListenerOutput[], view: PlayerView, prevPlayers: PlayerInfo[], context: ListenerContext): void {
    for (const output of outputs) {
      const outputHand = 'handNumber' in output ? output.handNumber : this.currentHandNumber;
      if (this.foldedInHand != null && outputHand === this.foldedInHand
          && output.type !== 'YOUR_TURN' && output.type !== 'REBUY_AVAILABLE') {
        continue;
      }
      switch (output.type) {
        case 'EVENT':
          if (!this.gameStartedEmitted && output.message.includes('[Hand #')) {
            this.emit({ type: 'GAME_STARTED' });
            this.gameStartedEmitted = true;
          }
          this.recentEvents.push(output.message);
          if (this.recentEvents.length > 20) this.recentEvents.shift();
          this.currentHandEvents.push(output.message);
          break;

        case 'YOUR_TURN': {
          // Guard: skip if we haven't seen a valid game state yet (spurious YOUR_TURN)
          if (!output.state.handNumber || !output.state.gameId) {
            this.debug('YOUR_TURN_SKIPPED', { reason: 'no valid game state' });
            break;
          }
          const playbook = readPlaybook();
          const notes = readNotes();
          const handNotes = readHandNotes();
          const sessionInsights = readSessionInsights();

          const eligibleHands = output.state.recentHands
            ?.filter(h => this.firstHandNumber === null || h.handNumber >= this.firstHandNumber);
          const recentHandLines = eligibleHands?.length
            ? eligibleHands.slice(-3).map(formatRecentHand)
            : this.recentEvents.filter(e => e.includes(' won ')).slice(-3);

          // Only include opponent stats if at least one opponent has a reliable sample (5+ hands)
          const hasReliableSample = Object.values(output.state.playerStats ?? {})
            .some(s => s.handsPlayed >= 5);
          const opponentStatsLines = hasReliableSample && output.state.playerStats
            ? formatOpponentStats(output.state.playerStats)
            : [];

          // Last 5 chat lines from prior hands (current-hand chat is already in THIS HAND).
          // Use startsWith to avoid [H5] accidentally matching [H50], [H500], etc.
          const currentHandPrefix = `[H${this.currentHandNumber}] `;
          const previousHandChatLines = this.chatHistory
            .filter(e => !e.startsWith(currentHandPrefix))
            .slice(-5);

          const prompt = buildDecisionPrompt(
            output.summary,
            playbook,
            this.currentHandEvents,
            recentHandLines,
            opponentStatsLines,
            sessionInsights,
            notes,
            handNotes,
            previousHandChatLines,
          );
          this.debug('YOUR_TURN', {
            hand: this.currentHandNumber,
            summary: output.summary,
            playbook: playbook.slice(0, 100) + (playbook.length > 100 ? '...' : ''),
            hasNotes: !!notes,
            hasHandNotes: !!handNotes,
            hasInsights: !!sessionInsights,
            previousHandChatCount: previousHandChatLines.length,
          });
          this.debug('DECISION_PROMPT', { hand: this.currentHandNumber, prompt });
          this.sendDecision(prompt, context);
          break;
        }

        case 'HAND_RESULT':
          this.handsPlayedThisSession++;
          this.processHandResult(view, output.handNumber || this.currentHandNumber, prevPlayers);
          this.checkHandCap();
          this.checkPaused();
          break;

        case 'WAITING_FOR_PLAYERS':
          this.notifyAgentSilent(controlSignals.waitingForPlayers(this.gameId));
          break;

        case 'REBUY_AVAILABLE': {
          const amt = output.state?.rebuyAmount || 'the default amount';
          this.notifyAgentSilent(controlSignals.rebuyAvailable(this.gameId, amt));
          break;
        }

        case 'DRAMA_MOMENT': {
          // Skip if reactive chat disabled, it's our turn, decision in-flight, or already reacting
          if (!this.tableChatReactive) break;
          if (output.state.isYourTurn) break;
          if (this.decisionInFlight) break;
          if (this.reactionInFlight) break;
          // Fire-and-forget on a separate async path
          this.sendReaction(output.description, output.handNumber).catch(() => {});
          break;
        }

        default:
          this.emit(output);
      }
    }
  }

  // ── Hand cap + pause checks ─────────────────────────────────────

  private checkHandCap(): void {
    if (this.maxHandsPerDay == null) return;
    const handsToday = this.handsAtSessionStart + this.handsPlayedThisSession;
    if (handsToday >= this.maxHandsPerDay) {
      this.emit({ type: 'HAND_LIMIT_REACHED', handsToday, maxHandsPerDay: this.maxHandsPerDay });
      this.onHandLimitReached?.(handsToday, this.maxHandsPerDay);
    }
  }

  private checkPaused(): void {
    try {
      const config = readClawPlayConfig();
      if (config.paused) {
        this.emit({ type: 'PAUSED_DETECTED' });
        this.onPausedDetected?.();
      }
    } catch { /* ignore read errors */ }
  }

  // ── Hand result + big-event detection ───────────────────────────

  private processHandResult(view: PlayerView, handNumber: number | null, prevPlayers: PlayerInfo[]): void {
    const summary = buildHandResultSummary(view, handNumber);
    const msg = summary || 'Hand complete.';
    this.recentEvents.push(msg);
    if (this.recentEvents.length > 20) this.recentEvents.shift();

    const stackAfter = view.yourChips;
    const bb = view.forcedBets?.bigBlind || 20;
    if (this.stackBeforeHand != null && this.stackBeforeHand > 0) {
      const change = Math.abs(stackAfter - this.stackBeforeHand);
      const changeRatio = change / this.stackBeforeHand;
      const changeBBs = change / bb;

      let updateReason: string | null = null;
      let highPriority = false;

      // Reset short-stack flag when stack recovers above threshold
      if (stackAfter >= bb * 15) this.shortStackNotified = false;

      if (stackAfter >= this.stackBeforeHand * 2) {
        updateReason = `Doubled up! ${msg} (${this.stackBeforeHand} → ${stackAfter})`;
        highPriority = true;
      } else if (changeRatio > 0.3) {
        const direction = stackAfter > this.stackBeforeHand ? 'Won big' : 'Lost big';
        updateReason = `${direction}! ${msg} (${this.stackBeforeHand} → ${stackAfter})`;
        highPriority = true;
      } else if (stackAfter > 0 && stackAfter < bb * 15 && !this.shortStackNotified) {
        // Fire once on entering short-stack territory; stays silent while condition persists
        updateReason = `Short-stacked (${stackAfter} chips, ${Math.floor(stackAfter / bb)} BB). ${msg}`;
        this.shortStackNotified = true;
      } else if (changeBBs >= 5 && stackAfter > this.stackBeforeHand) {
        updateReason = `Nice pot! ${msg} (${this.stackBeforeHand} → ${stackAfter}, +${Math.round(changeBBs)} BB)`;
      }

      // Opponent bust detection
      if (!updateReason) {
        const busted = view.players?.filter(p =>
          p.seat !== view.yourSeat && p.chips === 0 &&
          prevPlayers.some(pp => pp.seat === p.seat && (pp.chips ?? 0) > 0)
        );
        if (busted && busted.length > 0) {
          const names = busted.map(p => p.name).join(', ');
          updateReason = `${names} busted! ${msg}`;
        }
      }

      if (updateReason) {
        const now = Date.now();
        if (highPriority || now - this.lastHandUpdateTime > GameSession.HAND_UPDATE_COOLDOWN_MS) {
          this.lastHandUpdateTime = now;
          this.notifyAgent(controlSignals.handUpdate(updateReason));
        }
      }
    }
  }

  // ── Decision orchestration ──────────────────────────────────────

  sendDecision(prompt: string, context: ListenerContext): void {
    const mySeq = ++this.decisionSeq;
    this.decisionCount++;
    const myHandNumber = this.currentHandNumber;
    this.decisionInFlight = true;

    this.lastDecision = this.lastDecision.then(async () => {
      if (mySeq !== this.decisionSeq) {
        this.emit({ type: 'DECISION_STALE', skipped: mySeq, current: this.decisionSeq });
        this.debug('DECISION_STALE', { skipped: mySeq, current: this.decisionSeq });
        return;
      }

      let agentText = '';
      try {
        const sessionKey = `agent:${this.agentId}:subagent:${handSessionId(this.gameId, myHandNumber!)}`;
        const result = await this.gatewayClient.callAgent({
          agentId: this.agentId,
          sessionKey,
          sessionId: handSessionId(this.gameId, myHandNumber!),
          message: prompt,
          thinking: 'low',
          timeout: 55,
          extraSystemPrompt: this.personalityContext || undefined,
        }, 65_000);

        agentText = [...(result.payloads || [])].reverse().find((p: { text?: string }) => p.text)?.text || '';
      } catch (err) {
        if (mySeq !== this.decisionSeq) {
          this.emit({ type: 'DECISION_STALE', skipped: mySeq, current: this.decisionSeq });
          this.debug('DECISION_STALE', { skipped: mySeq, current: this.decisionSeq, context: 'callAgent_error' });
          this.notifyAgent(controlSignals.decisionTimedOut());
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.consecutiveDecisionFailures++;
        this.emit({ type: 'DECISION_FAILURE', consecutive: this.consecutiveDecisionFailures, error: msg, gwConnected: this.gatewayClient.isConnected() });
        this.debug('DECISION_FAILURE', { hand: myHandNumber, consecutive: this.consecutiveDecisionFailures, error: msg, gwConnected: this.gatewayClient.isConnected() });
        if (this.consecutiveDecisionFailures >= GameSession.MAX_CONSECUTIVE_FAILURES && this.onFatalDecisionFailure) {
          const reason = `${this.consecutiveDecisionFailures} consecutive decision failures`;
          await this.notifyAgent(controlSignals.decisionFailureExit(this.consecutiveDecisionFailures));
          this.onFatalDecisionFailure(reason);
          return;
        }
        this.notifyAgent(controlSignals.decisionAutoFolded());
        return;
      }

      if (mySeq !== this.decisionSeq) {
        this.emit({ type: 'DECISION_STALE', skipped: mySeq, current: this.decisionSeq });
        this.debug('DECISION_STALE', { skipped: mySeq, current: this.decisionSeq, context: 'post_callAgent' });
        this.notifyAgent(controlSignals.decisionTimedOut());
        return;
      }

      let decision: DecisionResponse | undefined;
      try {
        const decStart = agentText.indexOf('{');
        const decEnd = agentText.lastIndexOf('}');
        if (decStart >= 0 && decEnd > decStart) {
          decision = JSON.parse(agentText.slice(decStart, decEnd + 1));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.emit({ type: 'DECISION_PARSE_ERROR', error: msg, agentText: agentText.slice(0, 300) });
        this.debug('DECISION_PARSE_ERROR', { hand: myHandNumber, error: msg, agentText: agentText.slice(0, 300) });
      }

      if (decision) {
        this.debug('DECISION_RESPONSE', { hand: myHandNumber, decision, rawAgentText: agentText.slice(0, 500) });
      }

      if (!decision?.action) {
        this.consecutiveDecisionFailures++;
        this.emit({ type: 'DECISION_FAILURE', consecutive: this.consecutiveDecisionFailures, reason: 'no_action', agentText: agentText.slice(0, 300) });
        this.debug('DECISION_FAILURE', { hand: myHandNumber, consecutive: this.consecutiveDecisionFailures, reason: 'no_action', agentText: agentText.slice(0, 300) });
        if (this.consecutiveDecisionFailures >= GameSession.MAX_CONSECUTIVE_FAILURES && this.onFatalDecisionFailure) {
          const reason = `${this.consecutiveDecisionFailures} consecutive decision failures`;
          await this.notifyAgent(controlSignals.decisionFailureExit(this.consecutiveDecisionFailures));
          this.onFatalDecisionFailure(reason);
          return;
        }
        this.notifyAgent(controlSignals.decisionAutoFolded());
        return;
      }

      this.consecutiveDecisionFailures = 0;

      if (decision.action === 'fold') {
        this.foldedInHand = myHandNumber;
      }

      // Submit action to poker server — but first check if hand moved on
      if (this.currentHandNumber !== myHandNumber) {
        this.emit({ type: 'DECISION_STALE_HAND', decidedHand: myHandNumber, currentHand: this.currentHandNumber, action: decision.action });
        this.debug('DECISION_STALE_HAND', { decidedHand: myHandNumber, currentHand: this.currentHandNumber, action: decision.action });
        this.notifyAgent(controlSignals.decisionStaleHand(decision.action));
        return;
      }

      const body: { action: string; amount?: number; reasoning?: string; chat?: string } = {
        action: decision.action,
      };
      if (decision.amount != null) body.amount = decision.amount;
      if (decision.narration) body.reasoning = decision.narration;
      if (decision.chat) body.chat = decision.chat;

      try {
        const resp = await fetch(`${this.backendUrl}/api/me/game/action`, {
          method: 'POST',
          headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        this.debug('ACTION_SUBMITTED', { hand: myHandNumber, action: decision.action, amount: decision.amount, narration: decision.narration, status: resp.status });
        if (resp.ok) {
          if (decision.narration) {
            this.recentEvents.push(decision.narration);
            if (this.recentEvents.length > 20) this.recentEvents.shift();
          }
        } else {
          const reason = await resp.text().catch(() => null);
          this.emit({ type: 'ACTION_REJECTED', status: resp.status, action: decision.action, reason });
          this.debug('ACTION_REJECTED', { hand: myHandNumber, status: resp.status, action: decision.action, reason });

          if (resp.status === 429) {
            const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
            const backoffMs = Math.max(retryAfter * 1000, 5000);
            this.emit({ type: 'ACTION_THROTTLED', backoffMs, action: decision.action });
            this.debug('ACTION_THROTTLED', { hand: myHandNumber, backoffMs, action: decision.action });
            await new Promise(r => setTimeout(r, backoffMs));
          } else {
            this.notifyAgent(controlSignals.actionRejected(resp.status, reason || 'unknown reason'));
          }

          context.lastTurnKey = null;

          // Active retry: re-fetch state to trigger fresh YOUR_TURN
          // (server won't re-send state after 400 since nothing changed)
          if (resp.status === 400 && this.onRefetchState) {
            try {
              const stateResp = await fetch(`${this.backendUrl}/api/me/game`, {
                headers: { 'x-api-key': this.apiKey },
                signal: AbortSignal.timeout(5_000),
              });
              if (stateResp.ok) {
                const freshState = await stateResp.json() as PlayerView;
                this.emit({ type: 'ACTION_REJECTED_REFETCH' });
                this.onRefetchState(freshState);
              }
            } catch { /* best-effort */ }
          }
        }
      } catch (actionErr: unknown) {
        const actionErrMsg = actionErr instanceof Error ? (actionErr as Error).message : String(actionErr);
        this.emit({ type: 'ACTION_SUBMIT_ERROR', error: actionErrMsg, action: decision.action });
        this.debug('ACTION_SUBMIT_ERROR', { hand: myHandNumber, error: actionErrMsg, action: decision.action });

        // Retry once after 3s
        await new Promise(r => setTimeout(r, 3000));
        try {
          const retryResp = await fetch(`${this.backendUrl}/api/me/game/action`, {
            method: 'POST',
            headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });
          if (retryResp.ok) {
            this.emit({ type: 'ACTION_RETRY_OK', action: decision.action });
            if (decision.narration) {
              this.recentEvents.push(decision.narration);
              if (this.recentEvents.length > 20) this.recentEvents.shift();
            }
          } else {
            this.emit({ type: 'ACTION_RETRY_REJECTED', status: retryResp.status, action: decision.action });
          }
        } catch (retryErr: unknown) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          this.emit({ type: 'ACTION_RETRY_FAILED', error: retryMsg, action: decision.action });
        }
        context.lastTurnKey = null;
      }
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.emit({ type: 'DECISION_CHAIN_ERROR', error: msg });
      this.debug('DECISION_CHAIN_ERROR', { error: msg });
    }).finally(() => {
      this.decisionInFlight = false;
    });
  }

  // ── Reactive chat ─────────────────────────────────────────────

  private async sendReaction(description: string, handNumber: number): Promise<void> {
    if (this.decisionInFlight || this.reactionInFlight) return;
    this.reactionInFlight = true;

    try {
      const prompt = `Something just happened at the table: ${description}. You can react with a short message (one sentence max) or say nothing. Respond with JSON: {"chat": "..."} or {"chat": ""} to stay silent.`;

      const result = await this.gatewayClient.callAgent({
        agentId: this.agentId,
        sessionKey: `agent:${this.agentId}:subagent:${handSessionId(this.gameId, handNumber)}`,
        sessionId: handSessionId(this.gameId, handNumber),
        message: prompt,
        thinking: 'low',
        timeout: 15,
        extraSystemPrompt: this.personalityContext || undefined,
      }, 20_000);

      // If a decision started while we were waiting, discard the reaction
      if (this.decisionInFlight) {
        this.debug('REACTION_DISCARDED', { reason: 'decision_started', description });
        return;
      }

      const agentText = [...(result.payloads || [])].reverse().find((p: { text?: string }) => p.text)?.text || '';
      const jsonStart = agentText.indexOf('{');
      const jsonEnd = agentText.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(agentText.slice(jsonStart, jsonEnd + 1));
        if (parsed.chat && typeof parsed.chat === 'string' && parsed.chat.trim()) {
          // POST to standalone chat endpoint
          await fetch(`${this.backendUrl}/api/me/game/chat`, {
            method: 'POST',
            headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: parsed.chat.trim().slice(0, 200) }),
            signal: AbortSignal.timeout(5_000),
          });
          this.debug('REACTION_SENT', { description, chat: parsed.chat.trim() });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.debug('REACTION_ERROR', { description, error: msg });
    } finally {
      this.reactionInFlight = false;
    }
  }

  // ── Signal suppression ─────────────────────────────────────────

  /** Extract signal type from `[POKER CONTROL SIGNAL: TYPE] ...` messages. */
  private extractSignalType(message: string): string | null {
    const match = message.match(/\[POKER CONTROL SIGNAL: (\w+)\]/);
    return match ? match[1] : null;
  }

  /** Check if a control signal message should be suppressed. GAME_OVER and CONNECTION_ERROR are never suppressed. */
  private isSuppressed(message: string): boolean {
    const type = this.extractSignalType(message);
    if (!type) return false;
    if (type === 'GAME_OVER' || type === 'CONNECTION_ERROR') return false;
    return this.suppressedSignals.has(type);
  }

  // ── Agent notification helpers ──────────────────────────────────

  notifyAgent(message: string): Promise<void> {
    if (this.isSuppressed(message)) {
      this.emit({ type: 'SIGNAL_SUPPRESSED', signal: this.extractSignalType(message) });
      return Promise.resolve();
    }
    const accountArgs = this.deliveryAccount ? ['--reply-account', this.deliveryAccount] : [];
    return new Promise(resolve => {
      execFile('openclaw', [
        'agent',
        '--agent', this.agentId,
        '--message', message,
        '--deliver',
        '--reply-channel', this.channel,
        '--reply-to', this.chatId,
        ...accountArgs,
      ], { timeout: 60_000 }, (err) => {
        if (err) this.emit({ type: 'NOTIFY_AGENT_ERROR', error: err.message });
        resolve();
      });
    });
  }

  notifyAgentSilent(message: string): Promise<void> {
    if (this.isSuppressed(message)) {
      this.emit({ type: 'SIGNAL_SUPPRESSED', signal: this.extractSignalType(message) });
      return Promise.resolve();
    }
    return new Promise(resolve => {
      execFile('openclaw', [
        'agent',
        '--agent', this.agentId,
        '--message', message,
      ], { timeout: 60_000 }, (err) => {
        if (err) this.emit({ type: 'NOTIFY_AGENT_ERROR', error: err.message });
        resolve();
      });
    });
  }

  // ── Reflection stats for game-over signals ──────────────────────

  getReflectionStats(): string | undefined {
    return this.reflectionsSent > 0
      ? `${this.reflectionTimeouts} reflection timeout${this.reflectionTimeouts !== 1 ? 's' : ''} out of ${this.reflectionsSent} reflection${this.reflectionsSent !== 1 ? 's' : ''}`
      : undefined;
  }
}
