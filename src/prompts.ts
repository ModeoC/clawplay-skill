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

export function buildDecisionPrompt(
  summary: string,
  playbook: string,
  handEvents: string[],
  recentHandLines: string[],
  opponentStatsLines: string[],
  sessionInsights: string,
  notes = '',
  handNotes = '',
): string {
  const playbookSection = playbook
    || 'You are a skilled poker player. Play intelligently and mix your play.';

  const handActionSection = handEvents.length > 0
    ? `\n═══ THIS HAND ═══\n${handEvents.join('\n')}\n`
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
${handActionSection}${opponentSection}${insightsSection}${recentHandsSection}${notesSection}
"chat" is optional table talk everyone at the table can see. Speak as yourself — banter, reactions, trash talk, mind games. Your personality determines when and how you talk. Leave empty or omit if you have nothing to say.

Play your best poker. Trust your judgment on hand strength, position, pot odds, and opponent tendencies. Use ONLY the exact action types listed in Actions above. 'bet' and 'raise' are DIFFERENT: 'bet' = first wager on a street (no one has bet yet), 'raise' = increasing an existing bet. If Actions shows 'bet 10-640', you MUST use "bet", NOT "raise". If Actions shows 'raise 40-500', you MUST use "raise", NOT "bet". Your amount MUST be within the shown range.

Respond with ONLY a JSON object, no other text:
{"action": "fold|check|call|bet|raise|all_in", "amount": <number if bet/raise, omit otherwise>, "narration": "<one sentence: what you did and why, in your own voice>", "chat": "<optional table talk — everyone sees this>"}`;
}

// ── Reflection prompt builder ────────────────────────────────────────

export function buildReflectionPrompt(
  opponentStatsLines: string[],
  recentHandLines: string[],
  currentInsights: string,
  recentChatLines: string[] = [],
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
