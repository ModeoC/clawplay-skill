/**
 * Pure state processing — analyzes PlayerView changes and emits ListenerOutputs.
 *
 * Extracted to its own module to avoid circular imports between
 * game-session.ts and clawplay-listener.ts.
 */

import { diffStates } from './state-differ.js';
import { buildSummary } from './prompts.js';
import type {
  PlayerView,
  ListenerContext,
  ListenerOutput,
} from './types.js';

const ACTIVE_PHASES = new Set(['PREFLOP', 'FLOP', 'TURN', 'RIVER']);

export function processStateEvent(view: PlayerView, context: ListenerContext): ListenerOutput[] {
  const outputs: ListenerOutput[] = [];

  // ── Detect fast hand transition (hand N → N+1 without SHOWDOWN) ──
  const handChanged = context.prevState != null
    && context.prevState.handNumber !== view.handNumber;

  if (handChanged) {
    const prevHandNum = context.prevState!.handNumber;
    if (prevHandNum > (context.lastReportedHand || 0)) {
      // ── Detect folds from atomic hand transition ──
      const prevPhase = context.prevState!.phase;
      if (ACTIVE_PHASES.has(prevPhase)) {
        const prevHdr = `**[Hand #${prevHandNum}]**`;
        const winners = new Set(view.lastHandResult?.winners || []);
        for (const p of context.prevState!.players || []) {
          if (p.seat === context.prevState!.yourSeat) continue;
          if (p.status === 'active' && !winners.has(p.seat)) {
            outputs.push({ type: 'EVENT', message: `${prevHdr} ${p.name} folded`, handNumber: prevHandNum });
          }
        }
      }

      // If we busted and can rebuy, emit REBUY_AVAILABLE instead of HAND_RESULT
      if (view.yourChips === 0 && view.canRebuy) {
        outputs.push({ type: 'REBUY_AVAILABLE', state: view, handNumber: prevHandNum });
      } else {
        outputs.push({ type: 'HAND_RESULT', state: view, handNumber: prevHandNum });
      }
      context.lastReportedHand = prevHandNum;
    }
  }

  const prevPlayerCount = context.prevState?.players?.length ?? 0;

  const newEvents = diffStates(context.prevState, view);
  for (const message of newEvents) {
    outputs.push({ type: 'EVENT', message, handNumber: view.handNumber });
  }

  const prevPhase = context.prevPhase;

  context.prevState = view;
  context.prevPhase = view.phase;

  if (view.phase !== prevPhase) {
    context.lastActionType = null;
    context.lastTurnKey = null;
  }

  if (view.isYourTurn) {
    const turnKey = `${view.handNumber}:${view.phase}`;
    if (turnKey !== context.lastTurnKey) {
      context.lastTurnKey = turnKey;
      outputs.push({ type: 'YOUR_TURN', state: view, summary: buildSummary(view) });
      context.lastActionType = 'YOUR_TURN';
    }
    return outputs;
  }

  // Reset turnKey when it's not our turn, so re-entry in the same phase
  // (e.g., check → opponent bets → back to us) triggers a fresh decision.
  context.lastTurnKey = null;

  // Phase-based hand end — only if hand did NOT change (avoid double)
  if (!handChanged) {
    const handJustEnded =
      ACTIVE_PHASES.has(prevPhase!) &&
      (view.phase === 'SHOWDOWN' || view.phase === 'WAITING');

    if (handJustEnded) {
      const handNum = view.handNumber;
      if (handNum > (context.lastReportedHand || 0)) {
        if (view.yourChips === 0 && view.canRebuy) {
          outputs.push({ type: 'REBUY_AVAILABLE', state: view, handNumber: handNum });
          context.lastActionType = 'REBUY_AVAILABLE';
        } else {
          outputs.push({ type: 'HAND_RESULT', state: view, handNumber: handNum });
          context.lastActionType = 'HAND_RESULT';
        }
        context.lastReportedHand = handNum;
      }
      return outputs;
    }
  }

  if (view.phase === 'WAITING' && view.players && view.players.length < 2 && prevPlayerCount >= 2) {
    if (context.lastActionType !== 'WAITING_FOR_PLAYERS') {
      outputs.push({ type: 'WAITING_FOR_PLAYERS', state: view });
      context.lastActionType = 'WAITING_FOR_PLAYERS';
    }
    return outputs;
  }

  return outputs;
}
