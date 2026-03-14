import { formatCards } from './card-format.js';
import type { PlayerView } from './types.js';

// ── Warmup message ───────────────────────────────────────────────────

export const WARMUP_MESSAGE = '(system: session warmup — no action needed)';

// ── Control signal messages ──────────────────────────────────────────

export const controlSignals = {
  decisionTimedOut: () =>
    `[POKER CONTROL SIGNAL: DECISION_STATUS] Timed out — the hand moved on before I could decide.`,
  decisionAutoFolded: () =>
    `[POKER CONTROL SIGNAL: DECISION_STATUS] Decision timed out — auto-folded.`,
  decisionStaleHand: (action: string) =>
    `[POKER CONTROL SIGNAL: DECISION_STATUS] Hand moved on while deciding — skipped ${action}.`,
  actionRejected: (status: number, reason: string) =>
    `[POKER CONTROL SIGNAL: DECISION_STATUS] Action rejected (${status}): ${reason}`,
  actionRejectedNoReason: (status: number) =>
    `[POKER CONTROL SIGNAL: DECISION_STATUS] Action rejected (${status}) — could not read reason.`,
  gameOver: (gameId: string, reason: string, finalStack: unknown, reflectionStats?: string) =>
    `[POKER CONTROL SIGNAL: GAME_OVER] Game ended on table ${gameId}. Reason: ${reason}. Final stack: ${finalStack}.${reflectionStats ? ` ${reflectionStats}.` : ''} Run post-game review per SKILL.md instructions. (Respond to this signal only — do not respond with HEARTBEAT_OK.)`,
  connectionError: (gameId: string, reason: string, finalStack: unknown, reflectionStats?: string) =>
    `[POKER CONTROL SIGNAL: CONNECTION_ERROR] Lost connection to table ${gameId}. Reason: ${reason}. Last known stack: ${finalStack}.${reflectionStats ? ` ${reflectionStats}.` : ''} Offer to check status or reconnect. (Respond to this signal only — do not respond with HEARTBEAT_OK.)`,
  handUpdate: (msg: string) =>
    `[POKER CONTROL SIGNAL: HAND_UPDATE] ${msg}`,
  waitingForPlayers: (gameId: string) =>
    `[POKER CONTROL SIGNAL: WAITING_FOR_PLAYERS] All opponents left table ${gameId}. Decide whether to wait or leave — check your skill instructions.`,
  rebuyAvailable: (gameId: string, amount: unknown) =>
    `[POKER CONTROL SIGNAL: REBUY_AVAILABLE] Busted on table ${gameId}. Rebuy available for ${amount} chips. Decide whether to rebuy or leave — check your skill instructions.`,
  decisionFailureExit: (count: number) =>
    `[POKER CONTROL SIGNAL: DECISION_STATUS] ${count} consecutive decisions failed (timeout/error) — listener exiting. The game session may have a file lock or routing issue. Tell the user something went wrong with your decision-making and you had to leave the table.`,
  inviteReceived: (inviterName: string, gameMode: string, inviteId: string, tableId: string) =>
    `[POKER CONTROL SIGNAL: INVITE_RECEIVED] ${inviterName} invited you to play ${gameMode} at table ${tableId}. Invite ID: ${inviteId}. Decide whether to accept or decline — check your skill instructions.`,
  newFollower: (followerName: string) =>
    `[POKER CONTROL SIGNAL: NEW_FOLLOWER] ${followerName} is now following you. (Respond to this signal only — do not respond with HEARTBEAT_OK.)`,
  inviteAccepted: (inviteeName: string) =>
    `[POKER CONTROL SIGNAL: INVITE_RESPONSE] ${inviteeName} accepted your invite and joined the table. (Respond to this signal only — do not respond with HEARTBEAT_OK.)`,
  inviteDeclined: (inviteeName: string) =>
    `[POKER CONTROL SIGNAL: INVITE_RESPONSE] ${inviteeName} declined your invite. (Respond to this signal only — do not respond with HEARTBEAT_OK.)`,
};

// ── Formatting helpers (used by prompt builders) ─────────────────────

export function buildSummary(view: PlayerView): string {
  const cards = view.yourCards?.length ? formatCards(view.yourCards) : '??';
  const board = view.boardCards?.length ? formatCards(view.boardCards) : '';
  const phase = view.phase;
  const pot = view.pot;
  const stack = view.yourChips;
  const active = view.players?.filter(p => p.status === 'active').length || 0;
  const actions = (view.availableActions || []).map(a => {
    if (a.type === 'fold' || a.type === 'check' || a.type === 'call') return a.amount ? `${a.type} ${a.amount}` : a.type;
    if (a.minAmount != null) return `${a.type} ${a.minAmount}-${a.maxAmount}`;
    return a.type;
  }).join(', ');
  return board
    ? `${phase} | Board: ${board} | ${cards} | Pot:${pot} | Stack:${stack} | ${active} active | Actions: ${actions}`
    : `${phase} | ${cards} | Pot:${pot} | Stack:${stack} | ${active} active | Actions: ${actions}`;
}

export function buildHandResultSummary(state: PlayerView, handNumber: number | null): string | null {
  const result = state.lastHandResult;
  const hdr = handNumber ? `**[Hand #${handNumber}]**` : '';
  if (!result) return null;
  const winners = result.players
    ?.filter(p => result.winners?.includes(p.seat))
    .map(p => p.name) || [];
  const pot = result.potResults?.[0]?.amount || 0;
  const myStack = result.players?.find(p => p.seat === state.yourSeat)?.chips || state.yourChips;
  return `${hdr} ${winners.join(', ')} won ${pot}. Stack: ${myStack}.`;
}

type RecentHand = NonNullable<PlayerView['recentHands']>[number];
export function formatRecentHand(hand: RecentHand): string {
  const num = hand.handNumber;
  const outcome = hand.yourOutcome;
  if (!outcome) return `#${num}: (no outcome data)`;

  const winnerNames = hand.result.winners.map(w => w.name).join(', ');
  const pot = hand.result.potSize;
  const board = hand.boardCards.length > 0 ? formatCards(hand.boardCards) : '';

  if (outcome.action === 'folded') {
    const phase = outcome.phase ? ` on ${outcome.phase.toLowerCase()}` : ' preflop';
    return `#${num}: You folded${phase}. ${winnerNames} won ${pot}.`;
  }

  if (outcome.action === 'won') {
    const showdownHands = hand.result.showdownHands;
    if (showdownHands && showdownHands.length > 0) {
      const myHand = outcome.holeCards ? formatCards(outcome.holeCards) : '??';
      const ranking = outcome.handRanking || 'unknown';
      const losers = showdownHands
        .filter(sh => !hand.result.winners.some(w => w.name === sh.name))
        .map(sh => `${sh.name}: ${formatCards(sh.holeCards)} (${sh.handRanking || '?'})`)
        .join(', ');
      return `#${num}: Showdown — You won ${pot} with ${myHand} (${ranking}).${losers ? ` ${losers} lost.` : ''} Board: ${board}`;
    }
    return `#${num}: You won ${pot} uncontested.`;
  }

  // lost
  const myHand = outcome.holeCards ? formatCards(outcome.holeCards) : '??';
  const ranking = outcome.handRanking || 'unknown';
  const invested = outcome.invested ?? 0;
  const showdownWinner = hand.result.showdownHands?.find(sh =>
    hand.result.winners.some(w => w.name === sh.name));
  const winnerInfo = showdownWinner
    ? `${winnerNames} won ${pot} with ${formatCards(showdownWinner.holeCards)} (${showdownWinner.handRanking || '?'}). `
    : `${winnerNames} won ${pot}. `;
  return `#${num}: Showdown — ${winnerInfo}You lost ${invested} with ${myHand} (${ranking}). Board: ${board}`;
}

export function formatOpponentStats(stats: NonNullable<PlayerView['playerStats']>): string[] {
  const lines: string[] = [];
  for (const [name, s] of Object.entries(stats)) {
    const archetype = s.handsPlayed < 10
      ? '(small sample)'
      : `${s.vpip >= 30 ? 'Loose' : 'Tight'}-${s.af >= 1.2 ? 'aggressive' : 'passive'}`;
    lines.push(
      `${name} (${s.handsPlayed} hands): VPIP ${s.vpip}% · PFR ${s.pfr}% · 3-bet ${s.threeBet}% · AF ${s.af} · Fold-to-raise ${s.foldToRaise}%\n→ ${archetype}`
    );
  }
  return lines;
}

// ── Decision prompt builder ──────────────────────────────────────────
//
// Assembles the full prompt sent to the subagent for each decision turn.
// Called by game-session.ts → handleOutputs() → YOUR_TURN case.
//
// What the agent sees, section by section:
//
//   PLAYBOOK  (unconditional)
//     Content of poker-playbook.md — the agent's evolving play style, meta reads,
//     and self-coaching notes. Editable mid-session. Falls back to a generic
//     "play intelligently" line if missing.
//
//   SITUATION  (always present)
//     One-line snapshot built by buildSummary(): phase, hole cards, board,
//     pot, stack, active player count, and legal actions with bet ranges.
//
//   THIS HAND  (if any events exist for this hand)
//     Street-by-street action log for the current hand — raises, calls, checks,
//     folds — plus opponent table-chat messages ([H${N}] Name: text). Both
//     come from game-session.currentHandEvents, which is reset at each new hand
//     and populated from: (1) state-differ output strings, and (2) table-chat
//     SSE transitions from other players. The agent's own narrations are NOT
//     included here.
//
//   RECENT CHAT  (last 5 chat lines from previous hands, from chatHistory)
//     Chat lines labeled with [H${N}] hand tags from hands prior to the current
//     one. Omitted when no cross-hand chat has occurred. Gives decisions reliable
//     access to recent table banter without competing with action events for space.
//
//   OPPONENT PROFILE  (if playerStats present AND at least one opponent has 5+ hands)
//     Per-opponent aggregate stats computed from the DB: VPIP, PFR, 3-bet%,
//     Aggression Factor, Fold-to-raise%, hands played, and archetype label
//     (Loose/Tight × aggressive/passive). Covers the full session history for
//     each opponent, not just this game. Omitted early in the game when sample
//     sizes are too small to be reliable.
//
//   SESSION INSIGHTS  (if poker-session-insights.txt is non-empty)
//     The latest reflection output — a 2–3 sentence summary the model wrote
//     during the most recent between-hand reflection. May include social reads
//     synthesized from table-chat. Written to disk by triggerReflection() and
//     read fresh on each YOUR_TURN. Does NOT contain raw chat lines — only
//     what the reflection model chose to distill into insights.
//
//   RECENT HANDS  (last 3 hands from PlayerView.recentHands filtered to hands
//                  the agent actually played, or last 3 win events from
//                  recentEvents if recentHands unavailable)
//     Outcome-only summaries: fold phase, showdown hands/rankings, won/lost
//     amounts. Built by formatRecentHand(). Filtered via firstHandNumber to
//     exclude pre-join hands for agents who join mid-game.
//
//   TACTICAL NOTES  (if either file is non-empty)
//     Session notes: poker-notes.txt — persistent user nudges, survive hand
//     changes, manually cleared.
//     THIS HAND ONLY: poker-hand-notes.txt — one-shot nudges, auto-cleared
//     at the next hand change.

export function buildDecisionPrompt(
  summary: string,              // buildSummary(view) — phase/cards/board/pot/stack/actions one-liner
  playbook: string,             // poker-playbook.md contents (agent's style guide)
  handEvents: string[],         // current hand: action strings + opponent chat (currentHandEvents)
  recentHandLines: string[],    // last 3 hand outcomes from recentHands[] or recentEvents
  opponentStatsLines: string[], // formatted VPIP/PFR/AF/etc per opponent (empty if sample too small)
  sessionInsights: string,      // poker-session-insights.txt — latest reflection output
  notes = '',                   // poker-notes.txt — persistent session nudges from user
  handNotes = '',               // poker-hand-notes.txt — one-shot hand nudge, cleared next hand
  previousHandChat: string[] = [], // last 5 chat lines from prior hands (from chatHistory)
): string {
  const playbookSection = playbook
    || 'You are a skilled poker player. Play intelligently and mix your play.';

  const handActionSection = handEvents.length > 0
    ? `\n═══ THIS HAND ═══\n${handEvents.join('\n')}\n`
    : '';

  const recentChatSection = previousHandChat.length > 0
    ? `\n═══ RECENT CHAT ═══\n${previousHandChat.join('\n')}\n`
    : '';

  const opponentSection = opponentStatsLines.length > 0
    ? `\n═══ OPPONENT PROFILE ═══\n${opponentStatsLines.join('\n\n')}\n`
    : '';

  const insightsSection = sessionInsights
    ? `\n═══ SESSION INSIGHTS ═══\n${sessionInsights}\n`
    : '';

  const recentHandsSection = recentHandLines.length > 0
    ? `\n═══ RECENT HANDS (last ${recentHandLines.length}) ═══\n${recentHandLines.join('\n')}\n`
    : '';

  const notesParts: string[] = [];
  if (notes) notesParts.push(`Session notes:\n${notes}`);
  if (handNotes) notesParts.push(`THIS HAND ONLY:\n${handNotes}`);
  const notesSection = notesParts.length > 0
    ? `\nTactical notes from your human partner:\n${notesParts.join('\n\n')}\n`
    : '';

  return `You are playing No-Limit Hold'em poker. It is your turn to act.

${playbookSection}

═══ SITUATION ═══
${summary}
${handActionSection}${recentChatSection}${opponentSection}${insightsSection}${recentHandsSection}${notesSection}
"chat" is optional. When you do speak, it's table talk everyone at the table can see: banter, trash talk, casual conversation, whatever feels right for your character. You're not limited to poker talk. Silence is valid — skip it entirely if nothing fits.

Play your best poker. Trust your judgment on hand strength, position, pot odds, and opponent tendencies. Use ONLY the exact action types listed in Actions above. 'bet' and 'raise' are DIFFERENT: 'bet' = first wager on a street (no one has bet yet), 'raise' = increasing an existing bet. If Actions shows 'bet 10-640', you MUST use "bet", NOT "raise". If Actions shows 'raise 40-500', you MUST use "raise", NOT "bet". Your amount MUST be within the shown range.

Respond with ONLY a JSON object, no other text:
{"action": "fold|check|call|bet|raise|all_in", "amount": <number if bet/raise, omit otherwise>, "narration": "<one sentence: what you did and why, in your own voice>", "chat": "<optional table talk — banter, reactions, casual chat, or omit to stay silent>"}`;
}

// ── Reflection prompt builder ────────────────────────────────────────
//
// Assembles the prompt for between-hand reflection runs — fires every N hands
// (configurable, default 3) via game-session.ts → triggerReflection(). Runs
// fire-and-forget on the persistent "poker-{gameId}-reflect" subagent session
// (never blocks decision-making). Output is saved to poker-session-insights.txt
// and picked up by the next buildDecisionPrompt() call.
//
// What the agent sees, section by section:
//
//   OPPONENT PROFILE  (if opponentStatsLines non-empty)
//     Same aggregate stats as in the decision prompt — full-session VPIP/PFR/
//     AF/3-bet/fold-to-raise per opponent. Gives the model the same statistical
//     baseline it uses for decisions.
//
//   RECENT HANDS  (last 5 hand outcomes)
//     Same formatRecentHand() output as in the decision prompt — fold phases,
//     showdown results, stack changes. No chat messages from those hands.
//
//   TABLE TALK  (all lines from chatSinceReflection — exact window coverage)
//     Raw chat lines from other players, spanning multiple recent hands.
//     This is the ONLY place previous-hand chat appears verbatim. Populated
//     from table-chat SSE transitions (game-session.ts lines 238–242). The
//     model can synthesize social reads from this into the updated insights —
//     but the raw lines do NOT carry over to future decision prompts directly.
//     Omitted if no chat has occurred.
//
//   CURRENT SESSION INSIGHTS  (always present)
//     The existing poker-session-insights.txt content — what the model wrote
//     last time. The model updates this in-place, preserving continuity.
//
// Output: {"insights": "..."} — 2–3 sentences written to poker-session-insights.txt.

export function buildReflectionPrompt(
  opponentStatsLines: string[], // same stats as decision prompt
  recentHandLines: string[],    // last 5 hand outcomes (outcomes only, no chat)
  currentInsights: string,      // existing poker-session-insights.txt to update
  recentChatLines: string[] = [], // all chat lines from chatSinceReflection — exact window, no eviction
): string {
  const parts: string[] = [
    'You are between hands in a poker session. Review the session so far and update your running insights.',
  ];
  if (opponentStatsLines.length > 0) {
    parts.push(`\n═══ OPPONENT PROFILE ═══\n${opponentStatsLines.join('\n\n')}`);
  }
  if (recentHandLines.length > 0) {
    parts.push(`\n═══ RECENT HANDS (last ${recentHandLines.length}) ═══\n${recentHandLines.join('\n')}`);
  }
  if (recentChatLines.length > 0) {
    parts.push(`\n═══ TABLE TALK (recent) ═══\n${recentChatLines.join('\n')}`);
  }
  parts.push(`\n═══ CURRENT SESSION INSIGHTS ═══\n${currentInsights}`);
  parts.push(
    '\nUpdate your session insights. Cover: opponent tendencies THIS SESSION, your strategy adjustments, stack management observations, and any social reads from table talk. 2-3 sentences. If nothing meaningful changed, return the same insights unchanged.',
    '\nRespond with ONLY JSON: {"insights": "..."}'
  );
  return parts.join('\n');
}
