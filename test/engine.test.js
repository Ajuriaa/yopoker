import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate5, bestHand, compareScores, fullDeck } from '../cards.js';
import { createTable, addPlayer, startHand, act, legalActions, stepRunout, removePlayer, cancelHand, buildPots, handInProgress } from '../engine.js';

const cmp = (a, b) => compareScores(evaluate5(a.split(' ')), evaluate5(b.split(' ')));

test('orden de manos', () => {
  const ladder = [
    'As Ks Qs Js Ts', // escalera real
    '9h 8h 7h 6h 5h', // escalera de color
    'Ad Ac Ah As 2c', // póker
    'Kd Kc Kh 2s 2c', // full
    'Ah Jh 8h 4h 2h', // color
    'Td 9c 8h 7s 6c', // escalera
    'Qd Qc Qh 5s 2c', // trío
    'Jd Jc 4h 4s 9c', // doble par
    '8d 8c Ah 5s 2c', // par
    'Ad Jc 9h 5s 3c', // carta alta
  ];
  for (let i = 0; i < ladder.length - 1; i++) assert.ok(cmp(ladder[i], ladder[i + 1]) > 0, `${ladder[i]} > ${ladder[i + 1]}`);
});

test('escaleras con as y desempates', () => {
  assert.ok(cmp('5c 4d 3h 2s Ac', '6c 5d 4h 3s 2c') < 0, 'la rueda es la escalera más baja');
  assert.ok(cmp('Ac Kd Qh Js Tc', '5c 4d 3h 2s Ac') > 0);
  assert.equal(cmp('Ah Kh 8c 4d 2s', 'As Kd 8h 4c 2c'), 0, 'empate exacto');
  assert.ok(cmp('Ah Ad Kc 4d 2s', 'As Ac Qh Jd Tc') > 0, 'kicker del par');
  assert.ok(cmp('Kh Kd 5c 5d As', 'Kc Ks 5h 5s Qd') > 0, 'kicker del doble par');
  assert.ok(cmp('7h 7d 7c Ad As', '7h 7d 7c Kd Ks') > 0, 'full por el par');
});

test('mejor mano de 7 cartas y nombres', () => {
  const b = bestHand('Ah Kh 2c 7h Qh 9h 3d'.split(' '));
  assert.equal(b.score[0], 5);
  assert.equal(b.name, 'Color al As');
  assert.equal(bestHand('2c 2d 2h 9s 9c Kd Ks'.split(' ')).name, 'Full de Doses con Reyes');
  assert.equal(bestHand('As Ks Qs Js Ts 2d 3c'.split(' ')).name, 'Escalera real');
  assert.equal(bestHand('5c 4d 3h 2s Ac Kd Kc'.split(' ')).name, 'Escalera al Cinco');
});

// Arma un mazo para que salgan exactamente estas cartas.
// hole: { asiento: ['As','Kd'] }, el reparto va a la izquierda del botón, de a una carta.
function rig(t, hole, board = []) {
  const seats = Object.keys(hole).map(Number).sort((a, b) => a - b);
  const button = (() => {
    // startHand mueve el botón al siguiente asiento con jugador.
    for (let k = 1; k <= 8; k++) {
      const i = (t.button + k + 8) % 8;
      if (seats.includes(i)) return i;
    }
  })();
  const order = [];
  let i = button;
  for (let k = 0; k < seats.length; k++) {
    i = seats.find((s) => s > i) ?? seats[0];
    order.push(i);
  }
  const seq = [];
  for (let r = 0; r < 2; r++) for (const s of order) seq.push(hole[s][r]);
  const b = [...board];
  const used = new Set([...seq, ...b]);
  const fillers = fullDeck().filter((c) => !used.has(c));
  const burn = () => fillers.pop();
  if (b.length) {
    seq.push(burn(), b[0], b[1], b[2], burn(), b[3], burn(), b[4]);
  }
  const deck = [...fillers, ...seq.reverse()];
  return () => deck;
}

function table(n, stacks, settings = {}) {
  const t = createTable({ sb: 10, bb: 20, ...settings });
  for (let i = 0; i < n; i++) {
    addPlayer(t, { id: `p${i}`, name: `J${i}` });
    if (stacks) t.seats[i].stack = stacks[i];
  }
  return t;
}
const total = (t) => t.seats.reduce((s, x) => s + (x ? x.stack : 0), 0) + (t.hand && !t.hand.ended ? t.hand.order.reduce((s, i) => s + t.hand.players[i].total, 0) : 0);

test('ciegas y orden con 3 jugadores', () => {
  const t = table(3);
  const h = startHand(t);
  assert.equal(t.button, 0);
  assert.equal(h.sbSeat, 1);
  assert.equal(h.bbSeat, 2);
  assert.equal(h.toAct, 0, 'UTG (el botón con 3) habla primero');
  assert.equal(t.seats[1].stack, 990);
  assert.equal(t.seats[2].stack, 980);
});

test('heads-up: el botón pone la ciega chica y habla primero pre-flop, último post-flop', () => {
  const t = table(2);
  const h = startHand(t);
  assert.equal(h.sbSeat, t.button);
  assert.equal(h.toAct, t.button);
  act(t, t.button, { type: 'call' });
  assert.equal(h.toAct, h.bbSeat, 'la ciega grande tiene opción');
  act(t, h.bbSeat, { type: 'check' });
  assert.equal(h.stage, 'flop');
  assert.equal(h.board.length, 3);
  assert.equal(h.toAct, h.bbSeat, 'post-flop habla primero la ciega grande');
});

test('opción de la ciega grande y cierre de la ronda', () => {
  const t = table(4);
  const h = startHand(t);
  act(t, 3, { type: 'call' });
  act(t, 0, { type: 'call' });
  act(t, 1, { type: 'call' });
  assert.equal(h.stage, 'preflop');
  assert.equal(h.toAct, 2);
  const l = legalActions(t, 2);
  assert.ok(l.canCheck && l.canRaise);
  act(t, 2, { type: 'raise', amount: 60 });
  assert.equal(h.toAct, 3, 'la subida reabre la acción');
  act(t, 3, { type: 'call' });
  act(t, 0, { type: 'fold' });
  act(t, 1, { type: 'call' });
  assert.equal(h.stage, 'flop');
  assert.equal(h.toAct, 1, 'post-flop habla el primero vivo a la izquierda del botón');
});

test('todos se retiran: gana sin mostrar y se conservan las fichas', () => {
  const t = table(3);
  const before = total(t);
  const h = startHand(t);
  act(t, 0, { type: 'raise', amount: 100 });
  act(t, 1, { type: 'fold' });
  act(t, 2, { type: 'fold' });
  assert.ok(h.ended);
  assert.equal(h.results[0].seat, 0);
  assert.equal(h.results[0].amount, 130);
  assert.equal(t.seats[0].stack, 1030);
  assert.equal(total(t), before);
});

test('subida mínima', () => {
  const t = table(3);
  startHand(t);
  assert.throws(() => act(t, 0, { type: 'raise', amount: 30 }), /mínima es a 40/);
  act(t, 0, { type: 'raise', amount: 100 }); // sube 80
  assert.throws(() => act(t, 1, { type: 'raise', amount: 150 }), /mínima es a 180/);
  act(t, 1, { type: 'raise', amount: 180 });
  assert.equal(t.hand.currentBet, 180);
});

test('all-in corto no reabre la acción a quien ya actuó', () => {
  const t = table(3, [1000, 1000, 150]);
  const h = startHand(t); // botón 0, sb 1, bb 2 (150)
  act(t, 0, { type: 'raise', amount: 100 });
  act(t, 1, { type: 'call' });
  act(t, 2, { type: 'allin' }); // 150: sube solo 50 (< 80)
  assert.equal(h.currentBet, 150);
  assert.equal(h.toAct, 0);
  const l = legalActions(t, 0);
  assert.equal(l.canRaise, false, 'el que ya actuó solo puede igualar o retirarse');
  assert.equal(l.callAmount, 50);
  assert.throws(() => act(t, 0, { type: 'raise', amount: 400 }));
  act(t, 0, { type: 'call' });
  act(t, 1, { type: 'call' });
  assert.equal(h.stage, 'flop');
});

test('side pots: el corto solo gana el pozo principal', () => {
  const t = table(3, [100, 300, 1000]);
  // botón → 0. Asiento 0 tiene la mejor mano, 1 la segunda, 2 la peor.
  const shuffle = rig(t, { 0: ['As', 'Ad'], 1: ['Ks', 'Kd'], 2: ['7c', '2d'] }, ['Ac', 'Kc', '9h', '4s', '3d']);
  const before = total(t);
  const h = startHand(t, { shuffle });
  act(t, 0, { type: 'allin' }); // 100
  act(t, 1, { type: 'allin' }); // 300
  act(t, 2, { type: 'call' }); // 300
  assert.ok(h.runout);
  while (!h.ended) stepRunout(t);
  assert.equal(h.pots.length, 2);
  assert.deepEqual(h.pots.map((p) => p.amount), [300, 400]);
  assert.equal(t.seats[0].stack, 300, 'el trío de ases se lleva el principal');
  assert.equal(t.seats[1].stack, 400, 'el trío de reyes se lleva el side pot');
  assert.equal(t.seats[2].stack, 700);
  assert.equal(total(t), before);
});

test('pozo dividido con ficha impar', () => {
  const t = table(3, [1000, 1000, 1000], { sb: 5, bb: 10 });
  const shuffle = rig(t, { 0: ['Ah', '2c'], 1: ['Ad', '3c'], 2: ['7c', '7d'] }, ['Ks', 'Qs', 'Js', 'Ts', '8h']);
  const h = startHand(t, { shuffle });
  act(t, 0, { type: 'raise', amount: 25 });
  act(t, 1, { type: 'call' }); // sb completa a 25
  act(t, 2, { type: 'fold' }); // bb pierde 10
  // pozo = 25 + 25 + 10 = 60 → par, mejor: los dos con A-K-Q-J-T
  while (!h.ended) {
    const s = h.toAct;
    if (s === null) stepRunout(t);
    else act(t, s, { type: 'check' });
  }
  assert.equal(h.results.filter((r) => r.amount > 0).length, 2);
  assert.equal(t.seats[0].stack + t.seats[1].stack, 2010);
  // pozo 60 → 30 y 30 (par). Probamos impar a mano:
  const pots = buildPots({ order: [0, 1, 2], players: { 0: { total: 5, folded: false }, 1: { total: 5, folded: false }, 2: { total: 1, folded: true } } });
  assert.deepEqual(pots, [{ amount: 11, eligible: [0, 1] }]);
});

test('all-in pre-flop: se reparte todo el tablero y hay showdown', () => {
  const t = table(2, [500, 500]);
  const h = startHand(t);
  act(t, h.toAct, { type: 'allin' });
  act(t, h.toAct, { type: 'call' });
  assert.ok(h.runout);
  assert.equal(h.board.length, 3);
  stepRunout(t);
  assert.equal(h.board.length, 4);
  stepRunout(t);
  assert.equal(h.board.length, 5);
  stepRunout(t);
  assert.ok(h.ended);
  assert.equal(t.seats[0].stack + t.seats[1].stack, 1000);
});

test('jugador que se va a media mano se retira y libera el asiento después', () => {
  const t = table(3);
  const h = startHand(t);
  removePlayer(t, 1);
  assert.ok(h.players[1].folded);
  act(t, 0, { type: 'fold' });
  assert.ok(h.ended, 'queda uno vivo y gana');
  startHand(t);
  assert.equal(t.seats[1], null);
});

test('cancelar mano devuelve las fichas', () => {
  const t = table(3);
  startHand(t);
  act(t, 0, { type: 'raise', amount: 200 });
  cancelHand(t);
  assert.deepEqual(t.seats.slice(0, 3).map((s) => s.stack), [1000, 1000, 1000]);
  assert.equal(handInProgress(t), false);
});

test('no se puede actuar fuera de turno ni pasar con apuesta pendiente', () => {
  const t = table(3);
  startHand(t);
  assert.throws(() => act(t, 1, { type: 'call' }), /No es tu turno/);
  assert.throws(() => act(t, 0, { type: 'check' }), /igualar/);
});

test('fuzz: 3000 manos al azar nunca crean ni pierden fichas', () => {
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let game = 0; game < 30; game++) {
    const n = 2 + rnd(7);
    const t = table(n, Array.from({ length: n }, () => 50 + rnd(2000)));
    const chips = total(t);
    for (let hand = 0; hand < 100; hand++) {
      if (t.seats.filter((s) => s && s.stack > 0).length < 2) break;
      const h = startHand(t);
      let guard = 0;
      while (!h.ended && guard++ < 200) {
        if (h.runout) {
          stepRunout(t);
          continue;
        }
        const s = h.toAct;
        const l = legalActions(t, s);
        const r = rnd(10);
        if (r < 2) act(t, s, { type: 'fold' });
        else if (r < 6) act(t, s, { type: l.canCheck ? 'check' : 'call' });
        else if (l.canRaise) act(t, s, { type: 'raise', amount: l.minRaiseTo + rnd(Math.max(1, l.maxRaiseTo - l.minRaiseTo + 1)) });
        else act(t, s, { type: l.canCheck ? 'check' : 'call' });
        assert.equal(total(t), chips, 'fichas conservadas durante la mano');
      }
      assert.ok(h.ended, 'la mano termina');
      assert.equal(total(t), chips, `fichas conservadas (juego ${game}, mano ${hand})`);
      assert.ok(t.seats.every((s) => !s || s.stack >= 0), 'nadie queda negativo');
    }
  }
});
