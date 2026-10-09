// Motor de Texas Hold'em No-Limit. Todo el estado es JSON plano para poder guardarlo en disco.
// No sabe nada de red: el servidor lo llama y decide qué mostrarle a cada quien.

import { fullDeck, shuffle as defaultShuffle, bestHand, compareScores } from './cards.js';

export const MAX_SEATS = 8;
const STREETS = ['preflop', 'flop', 'turn', 'river'];

export class PokerError extends Error {}

export function createTable(settings = {}) {
  return {
    settings: { startingStack: 1000, sb: 10, bb: 20, actionTimeout: 60, ...settings },
    seats: Array(MAX_SEATS).fill(null),
    button: -1,
    handNo: 0,
    hand: null,
  };
}

// ---------- Jugadores ----------

export function addPlayer(t, { id, name }, preferredSeat = null) {
  if (t.seats.some((s) => s && s.id === id)) throw new PokerError('Ese jugador ya está sentado');
  const clean = cleanName(name);
  let seat = preferredSeat !== null && t.seats[preferredSeat] === null ? preferredSeat : t.seats.indexOf(null);
  if (seat === -1) throw new PokerError('La mesa está llena (8 jugadores)');
  t.seats[seat] = { id, name: clean, stack: t.settings.startingStack, sitOut: false, leaving: false };
  return seat;
}

export function cleanName(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 14);
  if (!n) throw new PokerError('Poné un nombre');
  return n;
}

export function seatOf(t, id) {
  return t.seats.findIndex((s) => s && s.id === id);
}

// Saca a un jugador. Si está en una mano, se retira y su asiento se libera al terminar la mano.
export function removePlayer(t, seat) {
  const s = t.seats[seat];
  if (!s) throw new PokerError('Asiento vacío');
  if (handInProgress(t) && t.hand.players[seat] && !t.hand.players[seat].folded) {
    s.leaving = true;
    foldOutOfTurn(t, seat);
    return;
  }
  if (handInProgress(t) && t.hand.players[seat]) {
    s.leaving = true;
    return;
  }
  t.seats[seat] = null;
}

export function handInProgress(t) {
  return !!t.hand && !t.hand.ended;
}

const canBeDealt = (s) => s && !s.sitOut && !s.leaving && s.stack > 0;

// ---------- Mano ----------

function nextSeat(from, seats) {
  // Siguiente asiento (en sentido horario) que esté en la lista `seats`.
  for (let k = 1; k <= MAX_SEATS; k++) {
    const i = (from + k + MAX_SEATS) % MAX_SEATS;
    if (seats.includes(i)) return i;
  }
  return -1;
}

export function startHand(t, { shuffle = defaultShuffle } = {}) {
  if (handInProgress(t)) throw new PokerError('Ya hay una mano en juego');
  // Liberar los asientos de quienes se fueron.
  t.seats = t.seats.map((s) => (s && s.leaving ? null : s));
  const dealt = t.seats.map((s, i) => (canBeDealt(s) ? i : -1)).filter((i) => i >= 0);
  if (dealt.length < 2) throw new PokerError('Se necesitan al menos 2 jugadores con fichas');

  const { sb, bb } = t.settings;
  t.button = nextSeat(t.button < 0 ? -1 : t.button, dealt);
  const headsUp = dealt.length === 2;
  const sbSeat = headsUp ? t.button : nextSeat(t.button, dealt);
  const bbSeat = nextSeat(sbSeat, dealt);

  const deck = shuffle(fullDeck());
  const players = {};
  for (const i of dealt) {
    players[i] = { cards: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, canRaise: true, lastAction: null };
  }
  // Repartir de a una, empezando a la izquierda del botón.
  for (let round = 0; round < 2; round++) {
    let i = t.button;
    for (let k = 0; k < dealt.length; k++) {
      i = nextSeat(i, dealt);
      players[i].cards.push(deck.pop());
    }
  }

  t.handNo += 1;
  t.hand = {
    no: t.handNo,
    deck,
    board: [],
    stage: 'preflop',
    players,
    order: dealt,
    sbSeat,
    bbSeat,
    currentBet: 0,
    minRaise: bb,
    toAct: null,
    runout: false,
    ended: false,
    results: null,
    pots: null,
    log: [],
    actionStartedAt: null,
  };

  post(t, sbSeat, sb, 'sb');
  post(t, bbSeat, bb, 'bb');
  t.hand.currentBet = bb;

  const first = headsUp ? sbSeat : nextSeat(bbSeat, dealt);
  setNextToAct(t, first, true);
  return t.hand;
}

function post(t, seat, amount, label) {
  const p = t.hand.players[seat];
  const s = t.seats[seat];
  const paid = Math.min(amount, s.stack);
  putChips(t, seat, paid);
  p.lastAction = { type: label, amount: paid };
  t.hand.log.push({ seat, type: label, amount: paid });
}

function putChips(t, seat, amount) {
  const p = t.hand.players[seat];
  const s = t.seats[seat];
  s.stack -= amount;
  p.bet += amount;
  p.total += amount;
  if (s.stack === 0) p.allIn = true;
}

const needsAction = (h, p) => !p.folded && !p.allIn && (!p.acted || p.bet < h.currentBet);

// Busca quién sigue a partir de `from` (incluyéndolo si inclusive=true). Si nadie, cierra la ronda.
function setNextToAct(t, from, inclusive = false) {
  const h = t.hand;
  const live = h.order.filter((i) => !h.players[i].folded);
  if (live.length === 1) return winUncontested(t, live[0]);

  const start = inclusive ? (from - 1 + MAX_SEATS) % MAX_SEATS : from;
  for (let k = 1; k <= MAX_SEATS; k++) {
    const i = (start + k) % MAX_SEATS;
    const p = h.players[i];
    if (p && needsAction(h, p)) {
      h.toAct = i;
      h.actionStartedAt = Date.now();
      return;
    }
  }
  endStreet(t);
}

function endStreet(t) {
  const h = t.hand;
  for (const i of h.order) {
    const p = h.players[i];
    p.bet = 0;
    p.acted = false;
    p.canRaise = true;
  }
  h.currentBet = 0;
  h.minRaise = t.settings.bb;
  h.toAct = null;

  if (h.stage === 'river') return showdown(t);

  dealStreet(t);
  const canAct = h.order.filter((i) => !h.players[i].folded && !h.players[i].allIn);
  if (canAct.length < 2) {
    // Todos (o todos menos uno) están all-in: se reparte el resto sin apuestas.
    h.runout = true;
    return;
  }
  setNextToAct(t, t.button);
}

function dealStreet(t) {
  const h = t.hand;
  const idx = STREETS.indexOf(h.stage);
  h.stage = STREETS[idx + 1];
  const n = h.stage === 'flop' ? 3 : 1;
  h.deck.pop(); // carta quemada
  for (let k = 0; k < n; k++) h.board.push(h.deck.pop());
  h.log.push({ type: 'street', stage: h.stage, board: [...h.board] });
}

// Con todos all-in, el servidor llama esto cada ~1.5 s para repartir calle por calle.
export function stepRunout(t) {
  const h = t.hand;
  if (!h || h.ended || !h.runout) return false;
  if (h.stage === 'river') {
    showdown(t);
    return true;
  }
  dealStreet(t);
  return true;
}

// ---------- Acciones ----------

export function legalActions(t, seat) {
  const h = t.hand;
  if (!handInProgress(t) || h.toAct !== seat) return null;
  const p = h.players[seat];
  const s = t.seats[seat];
  const toCall = Math.max(0, h.currentBet - p.bet);
  const maxTo = p.bet + s.stack;
  const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
  // Subir no tiene sentido si todos los demás ya están all-in o retirados.
  const othersCanAct = h.order.some((i) => i !== seat && !h.players[i].folded && !h.players[i].allIn);
  const canRaise = p.canRaise && maxTo > h.currentBet && othersCanAct;
  return {
    canCheck: toCall === 0,
    canCall: toCall > 0,
    callAmount: Math.min(toCall, s.stack),
    canRaise,
    minRaiseTo: canRaise ? minTo : null,
    maxRaiseTo: canRaise ? maxTo : null,
    isBet: h.currentBet === 0,
  };
}

export function act(t, seat, { type, amount }) {
  const h = t.hand;
  if (!handInProgress(t) || h.runout) throw new PokerError('No hay apuestas en este momento');
  if (h.toAct !== seat) throw new PokerError('No es tu turno');
  const p = h.players[seat];
  const s = t.seats[seat];
  const legal = legalActions(t, seat);
  const toCall = h.currentBet - p.bet;

  switch (type) {
    case 'fold':
      p.folded = true;
      break;
    case 'check':
      if (!legal.canCheck) throw new PokerError(`Tenés que igualar ${toCall} o retirarte`);
      break;
    case 'call':
      if (!legal.canCall) throw new PokerError('No hay nada que igualar: pasá');
      putChips(t, seat, legal.callAmount);
      break;
    case 'allin':
      if (legal.canRaise) return act(t, seat, { type: 'raise', amount: legal.maxRaiseTo });
      if (legal.canCall) return act(t, seat, { type: 'call' });
      throw new PokerError('No podés ir all-in ahora');
    case 'raise': {
      if (!legal.canRaise) throw new PokerError('No podés subir ahora, solo igualar o retirarte');
      const target = Math.min(Math.floor(Number(amount)), legal.maxRaiseTo);
      if (!Number.isFinite(target) || target <= h.currentBet) throw new PokerError('Monto inválido');
      const isAllIn = target === legal.maxRaiseTo;
      const raiseSize = target - h.currentBet;
      if (raiseSize < h.minRaise && !isAllIn) throw new PokerError(`La subida mínima es a ${h.currentBet + h.minRaise}`);
      putChips(t, seat, target - p.bet);
      const full = raiseSize >= h.minRaise;
      for (const i of h.order) {
        if (i === seat) continue;
        const o = h.players[i];
        if (o.folded || o.allIn) continue;
        if (full) {
          o.acted = false;
          o.canRaise = true;
        } else if (o.acted) {
          // Subida corta (all-in por menos del mínimo): no reabre las apuestas para quien ya actuó.
          o.canRaise = false;
        }
      }
      if (full) h.minRaise = raiseSize;
      h.currentBet = target;
      break;
    }
    default:
      throw new PokerError('Acción inválida');
  }

  p.acted = true;
  const amountNow = type === 'raise' || type === 'call' ? p.bet : 0;
  p.lastAction = { type: p.allIn && type !== 'fold' ? 'allin' : type, amount: amountNow };
  h.log.push({ seat, type: p.lastAction.type, amount: amountNow });
  setNextToAct(t, seat);
  return p.lastAction;
}

// Retirar a alguien fuera de su turno (lo saca el dealer o se desconectó y se fue).
export function foldOutOfTurn(t, seat) {
  const h = t.hand;
  const p = h?.players[seat];
  if (!handInProgress(t) || !p || p.folded) return;
  if (h.toAct === seat && !h.runout) {
    act(t, seat, { type: 'fold' });
    return;
  }
  p.folded = true;
  p.lastAction = { type: 'fold', amount: 0 };
  h.log.push({ seat, type: 'fold', amount: 0 });
  const live = h.order.filter((i) => !h.players[i].folded);
  if (live.length === 1) winUncontested(t, live[0]);
}

// ---------- Resultado ----------

function winUncontested(t, seat) {
  const h = t.hand;
  const total = h.order.reduce((sum, i) => sum + h.players[i].total, 0);
  t.seats[seat].stack += total;
  h.toAct = null;
  h.runout = false;
  h.ended = true;
  h.stage = 'showdown';
  h.pots = [{ amount: total, eligible: [seat] }];
  h.results = [{ seat, amount: total, uncontested: true }];
  h.log.push({ type: 'win', seat, amount: total });
}

// Arma el pozo principal y los side pots a partir de lo que puso cada quien.
export function buildPots(h) {
  const remaining = new Map(h.order.map((i) => [i, h.players[i].total]));
  const pots = [];
  while ([...remaining.values()].some((v) => v > 0)) {
    const contenders = h.order.filter((i) => !h.players[i].folded && remaining.get(i) > 0);
    if (!contenders.length) {
      // Solo queda plata de gente que se retiró: va al último pozo.
      const rest = [...remaining.values()].reduce((a, b) => a + b, 0);
      if (pots.length) pots[pots.length - 1].amount += rest;
      break;
    }
    const cap = Math.min(...contenders.map((i) => remaining.get(i)));
    let amount = 0;
    for (const [i, v] of remaining) {
      const take = Math.min(v, cap);
      amount += take;
      remaining.set(i, v - take);
    }
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === contenders.length && last.eligible.every((i) => contenders.includes(i))) {
      last.amount += amount;
    } else {
      pots.push({ amount, eligible: contenders });
    }
  }
  return pots;
}

function showdown(t) {
  const h = t.hand;
  h.stage = 'showdown';
  h.toAct = null;
  h.runout = false;
  const live = h.order.filter((i) => !h.players[i].folded);
  const hands = new Map(live.map((i) => [i, bestHand([...h.players[i].cards, ...h.board])]));
  const pots = buildPots(h);
  const won = new Map();

  for (const pot of pots) {
    let best = null;
    let winners = [];
    for (const i of pot.eligible) {
      const c = best ? compareScores(hands.get(i).score, best) : 1;
      if (c > 0) {
        best = hands.get(i).score;
        winners = [i];
      } else if (c === 0) winners.push(i);
    }
    // Fichas impares: al primer ganador a la izquierda del botón.
    winners.sort((a, b) => ((a - t.button + MAX_SEATS - 1) % MAX_SEATS) - ((b - t.button + MAX_SEATS - 1) % MAX_SEATS));
    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    for (const w of winners) {
      const amt = share + (odd > 0 ? 1 : 0);
      if (odd > 0) odd--;
      t.seats[w].stack += amt;
      won.set(w, (won.get(w) || 0) + amt);
    }
    pot.winners = winners;
  }

  h.pots = pots;
  h.results = live.map((i) => ({
    seat: i,
    amount: won.get(i) || 0,
    handName: hands.get(i).name,
    best: hands.get(i).cards,
    cards: h.players[i].cards,
  }));
  h.ended = true;
  h.log.push({ type: 'showdown' });
}

// Cancela la mano y devuelve a cada quien lo que puso.
export function cancelHand(t) {
  const h = t.hand;
  if (!handInProgress(t)) throw new PokerError('No hay mano en juego');
  for (const i of h.order) t.seats[i] && (t.seats[i].stack += h.players[i].total);
  t.hand = null;
}

// Pozo ya recogido (sin las apuestas de la calle actual).
export function collectedPot(h) {
  return h.order.reduce((sum, i) => sum + h.players[i].total - h.players[i].bet, 0);
}
