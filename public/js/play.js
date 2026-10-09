import { connect } from './net.js';
import { unlockAudio, pk } from './sound.js';
import { cardHtml, esc, fmt } from './cards.js';

const $ = (s) => document.querySelector(s);
let state = null;
let net = null;
let peeking = false;
let alwaysShow = false;
try {
  alwaysShow = localStorage.getItem('yopoker-always-show') === '1';
} catch {}

document.addEventListener('pointerdown', () => unlockAudio(), { passive: true });

// ---------- Utilidades ----------
let toastTimer = null;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
function confirmSheet(title, yes = 'Sí') {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-yes').textContent = yes;
    $('#confirm').classList.remove('hidden');
    const done = (v) => {
      $('#confirm').classList.add('hidden');
      resolve(v);
    };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
  });
}
let lastSend = 0;
function send(action, payload) {
  const now = Date.now();
  if (now - lastSend < 400) return; // doble toque
  lastSend = now;
  if (!net.send(action, payload)) toast('Sin conexión con la mesa', true);
  navigator.vibrate?.(12);
}

// ---------- Unirse ----------
function showJoin(msg) {
  $('#game').classList.add('hidden');
  $('#join').classList.remove('hidden');
  if (msg) $('#join-msg').textContent = msg;
  let saved = '';
  try {
    saved = localStorage.getItem('yopoker-name') || '';
  } catch {}
  if (!$('#join-name').value) $('#join-name').value = saved;
}
function doJoin() {
  const name = $('#join-name').value.trim();
  if (!name) return toast('Poné tu nombre', true);
  try {
    localStorage.setItem('yopoker-name', name);
  } catch {}
  unlockAudio();
  if (!net.join(name)) toast('Sin conexión con la mesa', true);
}
$('#join-btn').addEventListener('click', doJoin);
$('#join-name').addEventListener('keydown', (e) => e.key === 'Enter' && doJoin());

// ---------- Ver cartas (mantener presionado) ----------
const hole = $('#hole');
const startPeek = (e) => {
  e.preventDefault();
  peeking = true;
  renderHole();
};
const endPeek = () => {
  if (!peeking) return;
  peeking = false;
  renderHole();
};
hole.addEventListener('pointerdown', startPeek);
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => hole.addEventListener(ev, endPeek));
hole.addEventListener('contextmenu', (e) => e.preventDefault());
// iPhone: evitar la lupa/zoom al mantener presionado las cartas.
hole.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
hole.addEventListener('touchend', endPeek);
hole.addEventListener('touchcancel', endPeek);

// ---------- Menú ----------
$('#menu-btn').addEventListener('click', () => {
  renderMenu();
  $('#menu').classList.remove('hidden');
});
$('#menu-close').addEventListener('click', () => $('#menu').classList.add('hidden'));
$('#opt-show').addEventListener('click', () => {
  alwaysShow = !alwaysShow;
  try {
    localStorage.setItem('yopoker-always-show', alwaysShow ? '1' : '0');
  } catch {}
  renderMenu();
  renderHole();
});
$('#opt-sitout').addEventListener('click', () => {
  const me = mySeat();
  send('sitOut', { value: !me?.sitOut });
  $('#menu').classList.add('hidden');
});
$('#opt-leave').addEventListener('click', async () => {
  $('#menu').classList.add('hidden');
  if (!(await confirmSheet('¿Levantarte de la mesa? Perdés tu asiento y tus fichas.', 'Levantarme'))) return;
  send('leave');
  net.forget();
  setTimeout(() => location.reload(), 300);
});
function renderMenu() {
  $('#opt-show').textContent = alwaysShow ? '🙈 Esconder cartas (mantener para ver)' : '👁 Dejar mis cartas siempre visibles';
  $('#opt-sitout').textContent = mySeat()?.sitOut ? '✋ Volver a jugar' : '☕ Sentarme afuera (no me repartan)';
}


// ---------- Tabla de manos (para los que no saben jugar) ----------
const HAND_RANKS = [
  ['Escalera real', 'A, K, Q, J y 10 del mismo palo', 'As Ks Qs Js Ts', (n) => n.startsWith('Escalera real')],
  ['Escalera de color', '5 seguidas del mismo palo', '9h 8h 7h 6h 5h', (n) => n.startsWith('Escalera de color')],
  ['Póker', '4 cartas iguales', 'Kc Kd Kh Ks 3c', (n) => n.startsWith('Póker')],
  ['Full', 'Un trío y un par', 'Qh Qd Qs 7c 7h', (n) => n.startsWith('Full')],
  ['Color', '5 del mismo palo, en cualquier orden', 'Ad Jd 8d 6d 2d', (n) => n.startsWith('Color')],
  ['Escalera', '5 seguidas de cualquier palo', 'Tc 9d 8s 7h 6c', (n) => n.startsWith('Escalera al')],
  ['Trío', '3 cartas iguales', '8c 8d 8h Ks 4d', (n) => n.startsWith('Trío')],
  ['Doble par', 'Dos pares distintos', 'Jh Jc 5d 5s As', (n) => n.startsWith('Doble par')],
  ['Par', '2 cartas iguales', 'Th Td Ah 7s 2c', (n) => n.startsWith('Par de')],
  ['Carta alta', 'Nada de lo anterior: cuenta la carta más alta', 'Ad Qc 9h 6s 3d', (n) => n.startsWith('Carta alta') || / y /.test(n)],
];
function renderRanks() {
  // Solo se resalta si el jugador dejó sus cartas visibles (si no, el de al lado vería su mano).
  const name = alwaysShow ? state?.me?.handName || '' : '';
  // La primera coincidencia de la lista es la correcta ("Doble par: Jotas y Cincos" no es carta alta).
  const mineIdx = name ? HAND_RANKS.findIndex((r) => r[3](name)) : -1;
  $('#ranks-list').innerHTML = HAND_RANKS.map(([title, desc, ex], i) => {
    const mine = i === mineIdx;
    return `<li class="${mine ? 'mine' : ''}">
      <span class="rk">${i + 1}</span>
      <div class="rn">${title}${mine ? `<span class="tag-mine">Tu mano: ${esc(name)}</span>` : ''}</div>
      <div class="rd">${desc}</div>
      <div class="rc">${ex.split(' ').map((c) => cardHtml(c)).join('')}</div>
    </li>`;
  }).join('');
}
$('#ranks-btn').addEventListener('click', () => {
  renderRanks();
  $('#ranks').classList.remove('hidden');
});
$('#ranks-close').addEventListener('click', () => $('#ranks').classList.add('hidden'));
$('#ranks').addEventListener('click', (e) => e.target.id === 'ranks' && $('#ranks').classList.add('hidden'));

// ---------- Render ----------
const mySeat = () => (state?.me ? state.seats[state.me.seat] : null);

function render(s) {
  state = s;
  if (!s.me) return;
  $('#join').classList.add('hidden');
  $('#game').classList.remove('hidden');
  const seat = mySeat();
  const h = s.hand;
  const hp = h?.players[s.me.seat];

  $('#me-name').textContent = seat.name;
  $('#me-stack').textContent = fmt(seat.stack);

  // Mesa en miniatura
  let board = '';
  for (let i = 0; i < 5; i++) board += h?.board[i] ? cardHtml(h.board[i]) : '<div class="slot"></div>';
  $('#board').innerHTML = board;
  $('#pot').textContent = h && !h.ended ? `Pozo ${fmt(h.totalPot)}` : '';
  const legal = s.me.legal;
  $('#tocall').textContent = legal?.canCall ? `· Para igualar ${fmt(legal.callAmount)}` : '';

  renderStatus();
  renderHole();
  renderResult();
  renderActions();
}

function renderStatus() {
  const s = state;
  const h = s.hand;
  const el = $('#status');
  const seat = mySeat();
  const hp = h?.players[s.me.seat];
  el.classList.remove('turn');
  let txt = '';
  if (h && !h.ended && h.toAct === s.me.seat) {
    el.classList.add('turn');
    txt = '¡Tu turno!<span class="timeleft"></span>';
  } else if (seat.sitOut) txt = '☕ Estás sentado afuera';
  else if (seat.stack === 0 && (!hp || h?.ended)) txt = 'Sin fichas: pedile recompra al dealer';
  else if (!h || h.ended) txt = h?.ended ? 'Mano terminada' : 'Esperando que repartan…';
  else if (!hp) txt = 'Entrás en la próxima mano';
  else if (hp.folded) txt = 'Te retiraste de esta mano';
  else if (h.runout) txt = '🔥 Todos all-in, se reparte todo…';
  else if (h.toAct !== null) txt = `Turno de ${esc(s.seats[h.toAct]?.name ?? '')}`;
  el.innerHTML = txt;
}

function renderHole() {
  if (!state?.me) return;
  const cards = state.me.cards;
  const h = state.hand;
  const hp = h?.players[state.me.seat];
  const el = $('#hole-cards');
  const show = peeking || alwaysShow || h?.ended;
  if (!cards) {
    el.innerHTML = '';
    $('#peek-hint').textContent = '';
    $('#hand-name').textContent = '';
    return;
  }
  el.innerHTML = cards.map((c) => cardHtml(c, { back: !show })).join('');
  el.classList.toggle('peeking', peeking);
  el.classList.toggle('folded', !!hp?.folded);
  $('#peek-hint').textContent = alwaysShow || h?.ended ? '' : 'Mantené presionado para ver tus cartas';
  $('#hand-name').textContent = show && state.me.handName ? state.me.handName : '';
}

function renderResult() {
  const h = state.hand;
  const el = $('#result');
  if (!h?.ended || !h.results) {
    el.classList.add('hidden');
    return;
  }
  const mine = h.results.find((r) => r.seat === state.me.seat);
  const winners = h.results.filter((r) => r.amount > 0);
  el.classList.remove('hidden');
  if (mine && mine.amount > 0) {
    el.className = 'result won';
    el.innerHTML = `🎉 ¡Ganaste ${fmt(mine.amount)}!${mine.handName ? `<br><small>${esc(mine.handName)}</small>` : ''}`;
  } else {
    el.className = 'result';
    el.innerHTML = winners.map((r) => `${esc(state.seats[r.seat]?.name ?? '?')} ganó ${fmt(r.amount)}${r.handName ? ` con ${esc(r.handName)}` : ''}`).join('<br>');
  }
}

function renderActions() {
  const el = $('#actions');
  const legal = state.me.legal;
  if (!legal) {
    el.innerHTML = `<div class="wait">${state.hand && !state.hand.ended ? 'Esperá tu turno' : 'Esperando la siguiente mano'}</div>`;
    return;
  }
  const callBtn = legal.canCheck
    ? `<button class="btn call" data-a="check">Pasar</button>`
    : `<button class="btn call" data-a="call">Igualar ${fmt(legal.callAmount)}</button>`;
  const raiseBtn = legal.canRaise
    ? legal.maxRaiseTo === legal.minRaiseTo
      ? `<button class="btn allin" data-a="allin">All-in ${fmt(legal.maxRaiseTo)}</button>`
      : `<button class="btn raise" data-a="raise">${legal.isBet ? 'Apostar…' : 'Subir…'}</button>`
    : `<button class="btn" disabled>${legal.isBet ? 'Apostar' : 'Subir'}</button>`;
  el.innerHTML = `<button class="btn fold" data-a="fold">Retirarse</button>${callBtn}<div class="full" style="display:grid">${raiseBtn}</div>`;
}

$('#actions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a;
  const legal = state.me.legal;
  if (!legal) return;
  if (a === 'fold' && legal.canCheck && !(await confirmSheet('¿Retirarte? Podés pasar gratis.', 'Retirarme igual'))) return;
  if (a === 'raise') return openRaise();
  send('act', { type: a });
});

// ---------- Subir ----------
let raiseTo = 0;
function raiseBounds() {
  const l = state.me.legal;
  return { min: l.minRaiseTo, max: l.maxRaiseTo, step: state.settings.bb };
}
function setRaise(v) {
  const { min, max } = raiseBounds();
  raiseTo = Math.max(min, Math.min(max, Math.round(v)));
  $('#raise-amount').textContent = fmt(raiseTo);
  $('#raise-slider').value = raiseTo;
  const allIn = raiseTo === max;
  $('#raise-ok').textContent = allIn ? `All-in ${fmt(raiseTo)}` : `${state.me.legal.isBet ? 'Apostar' : 'Subir a'} ${fmt(raiseTo)}`;
}
function openRaise() {
  const { min, max } = raiseBounds();
  const h = state.hand;
  const l = state.me.legal;
  const toCall = l.canCall ? l.callAmount : 0;
  const potAfterCall = h.totalPot + toCall;
  const presets = [
    ['Mín', min],
    ['½ pozo', h.currentBet + Math.round(potAfterCall / 2)],
    ['Pozo', h.currentBet + potAfterCall],
    ['All-in', max],
  ];
  $('#raise-title').textContent = l.isBet ? 'Apostar' : 'Subir a';
  $('#raise-slider').min = min;
  $('#raise-slider').max = max;
  $('#raise-slider').step = 1;
  $('#raise-range').textContent = `de ${fmt(min)} a ${fmt(max)}`;
  $('#presets').innerHTML = presets.map(([l2, v]) => `<button class="btn" data-v="${Math.max(min, Math.min(max, v))}">${l2}</button>`).join('');
  setRaise(min);
  $('#raise').classList.remove('hidden');
}
$('#raise-slider').addEventListener('input', (e) => {
  // Redondear a múltiplos de la ciega grande, salvo el máximo
  const { min, max, step } = raiseBounds();
  let v = Number(e.target.value);
  if (v < max) v = Math.max(min, Math.round(v / step) * step);
  setRaise(v);
});
document.querySelectorAll('[data-step]').forEach((b) =>
  b.addEventListener('click', () => {
    const { step } = raiseBounds();
    setRaise(raiseTo + Number(b.dataset.step) * step);
  })
);
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (b) setRaise(Number(b.dataset.v));
});
$('#raise-cancel').addEventListener('click', () => $('#raise').classList.add('hidden'));
$('#raise-ok').addEventListener('click', () => {
  $('#raise').classList.add('hidden');
  send('act', { type: 'raise', amount: raiseTo });
});

// Tiempo restante en la barra de estado
setInterval(() => {
  const h = state?.hand;
  const el = document.querySelector('.timeleft');
  if (!el || !h?.deadline) return;
  const left = Math.max(0, Math.ceil((h.deadline - net.now()) / 1000));
  el.textContent = ` · ${left}s`;
  if (left <= 10 && left > 0) navigator.vibrate?.(5);
}, 500);

net = connect('player', {
  onState: (s) => {
    if (!s.me) return;
    render(s);
    // Si la hoja de subir está abierta y ya no es mi turno, cerrarla.
    if (!s.me.legal) $('#raise').classList.add('hidden');
  },
  onNeedJoin: (m) => showJoin(m.full ? 'La mesa está llena (8). Pedile al dealer un lugar.' : null),
  onJoined: () => toast('¡Sentado! Esperá que repartan'),
  onKicked: () => {
    showJoin('El dealer te levantó de la mesa. Podés volver a sentarte.');
  },
  onEvent: (name) => {
    if (name === 'yourTurn') {
      pk.yourTurn();
      navigator.vibrate?.([120, 60, 120]);
    }
  },
  onToast: toast,
  onStatus: (ok) => $('#dot').classList.toggle('ok', ok),
});
