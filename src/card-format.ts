const SUIT_MAP: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

export function formatCard(card: string): string {
  if (card.length !== 2) return card;
  const rank = card[0];
  const suit = SUIT_MAP[card[1]];
  if (!suit) return card;
  return rank + suit;
}

export function formatCards(cards: string[]): string {
  return cards.map(formatCard).join(' ');
}
