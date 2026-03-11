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
import { readPlaybook, readNotes, SKILL_ROOT } from './review.js';
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
  stackBeforeHand: number | null = null;
  foldedInHand: number | null = null;

  // Personality context (loaded once at startup)
  personalityContext = '';

  // SSE connection state
  sseFirstConnect = true;
  lastEventTime = Date.now();
  lastStateEventTime = Date.now();
  reconnectAttempts = 0;

  // Transitions from SSE (hook point for Phase 2 chat)
  lastTransitions: GameTransition[] = [];

  // Constants
  static readonly MAX_CONSECUTIVE_FAILURES = 3;
  static readonly HAND_UPDATE_COOLDOWN_MS = 30_000;

  constructor(config: GameSessionConfig) {
    this.channel = config.channel;
    this.chatId = config.chatId;
    this.agentId = config.agentId;
    this.backendUrl = config.backendUrl;
    this.apiKey = config.apiKey;
    this.deliveryAccount = config.deliveryAccount;
    this.reflectEveryNHands = config.reflectEveryNHands;
    this.suppressedSignals = new Set(config.suppressedSignals ?? []);
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
    this.stackBeforeHand = null;
    this.foldedInHand = null;
    this.lastTransitions = [];

    // Clear per-game files so stale data doesn't bleed into the next game
    try { unlinkSync(join(SKILL_ROOT, 'poker-notes.txt')); } catch {}
    try { unlinkSync(join(SKILL_ROOT, 'poker-hand-notes.txt')); } catch {}
    try { unlinkSync(INSIGHTS_FILE); } catch {}
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
      }, 20_000).then(() => {}).catch(() => {});
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

    if (this.gameId === 'unknown' && view.gameId) this.gameId = view.gameId;
    this.reconnectAttempts = 0;

    const prevHandNumber = this.currentHandNumber;
    const handJustChanged = view.handNumber !== this.currentHandNumber;
    this.currentHandNumber = view.handNumber;

    const prevPlayers = context.prevState?.players || [];
    const outputs = processStateEvent(view, context);

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

    const recentHandLines = view.recentHands?.length
      ? view.recentHands.slice(-5).map(formatRecentHand)
      : [];
    const opponentStatsLines = view.playerStats
      ? formatOpponentStats(view.playerStats)
      : [];
    const currentInsights = readSessionInsights() || 'No session insights yet.';
    const reflectionPrompt = buildReflectionPrompt(opponentStatsLines, recentHandLines, currentInsights);
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
          const playbook = readPlaybook();
          const notes = readNotes();
          const handNotes = readHandNotes();
          const sessionInsights = readSessionInsights();

          const recentHandLines = output.state.recentHands?.length
            ? output.state.recentHands.slice(-5).map(formatRecentHand)
            : this.recentEvents.filter(e => e.includes(' won ')).slice(-3);

          const opponentStatsLines = output.state.playerStats
            ? formatOpponentStats(output.state.playerStats)
            : [];

          const prompt = buildDecisionPrompt(
            output.summary,
            playbook,
            this.currentHandEvents,
            recentHandLines,
            opponentStatsLines,
            sessionInsights,
            notes,
            handNotes,
          );
          this.debug('YOUR_TURN', {
            hand: this.currentHandNumber,
            summary: output.summary,
            playbook: playbook.slice(0, 100) + (playbook.length > 100 ? '...' : ''),
            hasNotes: !!notes,
            hasHandNotes: !!handNotes,
            hasInsights: !!sessionInsights,
          });
          this.debug('DECISION_PROMPT', { hand: this.currentHandNumber, prompt });
          this.sendDecision(prompt, context);
          break;
        }

        case 'HAND_RESULT':
          this.processHandResult(view, output.handNumber || this.currentHandNumber, prevPlayers);
          break;

        case 'WAITING_FOR_PLAYERS':
          this.notifyAgentSilent(controlSignals.waitingForPlayers(this.gameId));
          break;

        case 'REBUY_AVAILABLE': {
          const amt = output.state?.rebuyAmount || 'the default amount';
          this.notifyAgentSilent(controlSignals.rebuyAvailable(this.gameId, amt));
          break;
        }

        default:
          this.emit(output);
      }
    }
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

      if (stackAfter >= this.stackBeforeHand * 2) {
        updateReason = `Doubled up! ${msg} (${this.stackBeforeHand} → ${stackAfter})`;
        highPriority = true;
      } else if (changeRatio > 0.3) {
        const direction = stackAfter > this.stackBeforeHand ? 'Won big' : 'Lost big';
        updateReason = `${direction}! ${msg} (${this.stackBeforeHand} → ${stackAfter})`;
        highPriority = true;
      } else if (stackAfter > 0 && stackAfter < bb * 15) {
        updateReason = `Short-stacked (${stackAfter} chips, ${Math.floor(stackAfter / bb)} BB). ${msg}`;
        highPriority = true;
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
    const myHandNumber = this.currentHandNumber;

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

      const body: { action: string; amount?: number; reasoning?: string } = {
        action: decision.action,
      };
      if (decision.amount != null) body.amount = decision.amount;
      if (decision.narration) body.reasoning = decision.narration;

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
    });
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
