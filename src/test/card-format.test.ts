import { describe, it, expect } from 'vitest';
import { formatCard, formatCards } from '../card-format.js';

describe('formatCard', () => {
  it('converts backend card string to display format', () => {
    expect(formatCard('As')).toBe('A\u2660');
    expect(formatCard('Kh')).toBe('K\u2665');
    expect(formatCard('Td')).toBe('T\u2666');
    expect(formatCard('2c')).toBe('2\u2663');
  });

  it('handles all suits', () => {
    expect(formatCard('Qs')).toBe('Q\u2660');
    expect(formatCard('Qh')).toBe('Q\u2665');
    expect(formatCard('Qd')).toBe('Q\u2666');
    expect(formatCard('Qc')).toBe('Q\u2663');
  });

  it('returns raw string for unknown format', () => {
    expect(formatCard('??')).toBe('??');
  });
});

describe('formatCards', () => {
  it('formats an array of cards separated by spaces', () => {
    expect(formatCards(['As', 'Kh'])).toBe('A\u2660 K\u2665');
  });

  it('returns empty string for empty array', () => {
    expect(formatCards([])).toBe('');
  });
});
