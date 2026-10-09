// Cartas y evaluación de manos de Texas Hold'em.
// Una carta es un string de 2 letras: valor + palo. Ej: "As" (as de picas), "Td" (10 de diamantes).

import crypto from 'node:crypto';

export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc'; // picas, corazones, diamantes, tréboles

export function fullDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

// Fisher-Yates con aleatoriedad criptográfica.
export function shuffle(cards, randomInt = crypto.randomInt) {
  const a = [...cards];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rankValue = (c) => RANKS.indexOf(c[0]) + 2;

// Categorías: 0 carta alta … 8 escalera de color.
// Devuelve un arreglo comparable: [categoría, desempates…].
export function evaluate5(cards) {
  const r = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const unique = [...new Set(r)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (r[0] - r[4] === 4) straightHigh = r[0];
    else if (r[0] === 14 && r[1] === 5) straightHigh = 5; // A-2-3-4-5
  }
  const counts = new Map();
  for (const v of r) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].map(([v, n]) => [n, v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const rest = (from) => groups.slice(from).map((g) => g[1]);

  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]];
  if (flush) return [5, ...r];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, groups[0][1], ...rest(1)];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, groups[0][1], groups[1][1], groups[2][1]];
  if (groups[0][0] === 2) return [1, groups[0][1], ...rest(1)];
  return [0, ...r];
}

export function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Mejor mano de 5 entre 5, 6 o 7 cartas.
export function bestHand(cards) {
  if (cards.length < 5) return null;
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluate5(five);
            if (!best || compareScores(score, best.score) > 0) best = { score, cards: five };
          }
  best.name = handName(best.score);
  return best;
}

const ONE = { 2: 'Dos', 3: 'Tres', 4: 'Cuatro', 5: 'Cinco', 6: 'Seis', 7: 'Siete', 8: 'Ocho', 9: 'Nueve', 10: 'Diez', 11: 'Jota', 12: 'Reina', 13: 'Rey', 14: 'As' };
const MANY = { 2: 'Doses', 3: 'Treses', 4: 'Cuatros', 5: 'Cincos', 6: 'Seises', 7: 'Sietes', 8: 'Ochos', 9: 'Nueves', 10: 'Dieces', 11: 'Jotas', 12: 'Reinas', 13: 'Reyes', 14: 'Ases' };

export function handName(score) {
  const [cat, a, b] = score;
  switch (cat) {
    case 8:
      return a === 14 ? 'Escalera real' : `Escalera de color al ${ONE[a]}`;
    case 7:
      return `Póker de ${MANY[a]}`;
    case 6:
      return `Full de ${MANY[a]} con ${MANY[b]}`;
    case 5:
      return `Color al ${ONE[a]}`;
    case 4:
      return `Escalera al ${ONE[a]}`;
    case 3:
      return `Trío de ${MANY[a]}`;
    case 2:
      return `Doble par: ${MANY[a]} y ${MANY[b]}`;
    case 1:
      return `Par de ${MANY[a]}`;
    default:
      return `Carta alta: ${ONE[a]}`;
  }
}

// Nombre de lo que lleva un jugador antes del river (2 a 6 cartas).
export function currentHandName(hole, board) {
  const all = [...hole, ...board];
  if (all.length >= 5) return bestHand(all).name;
  // Pre-flop: par o cartas altas
  const [x, y] = hole.map(rankValue).sort((p, q) => q - p);
  if (x === y) return `Par de ${MANY[x]}`;
  return `${ONE[x]} y ${ONE[y]}${hole[0][1] === hole[1][1] ? ' del mismo palo' : ''}`;
}
