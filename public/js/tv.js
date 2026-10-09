import { connect } from './net.js';
import { unlockAudio, pk, sfx } from './sound.js';
import { cardHtml, esc, fmt, ACTION_LABEL } from './cards.js';

const $ = (s) => document.querySelector(s);

// Posición de cada asiento en el lienzo (% izquierda, % arriba), en sentido horario.
const SEAT_POS = [
  [50, 86],
  [24, 81],
  [8.5, 51],
  [24, 20],
  [50, 14],
  [76, 20],
  [91.5, 51],
  [76, 81],
];
const CENTER = [50, 51];
const lerp = ([x1, y1], [x2, y2], k) => [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k];

let state = null;
let net = null;

// ---------- Inicio: audio + pantalla completa ----------
let audioOn = false;
function goFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
}
function startShow() {
  audioOn = unlockAudio();
  goFullscreen();
  $('#start').classList.add('gone');
  $('#sound-pill').classList.add('hidden');
}
$('#start-btn').addEventListener('click', startShow);
$('#sound-pill').addEventListener('click', startShow);
document.addEventListener('keydown', (e) => (e.key === 'f' || e.key === 'F') && goFullscreen());
document.addEventListener('click', () => (audioOn = unlockAudio()));
function hideStartIfPlaying() {
  if ($('#start').classList.contains('gone')) return;
  $('#start').classList.add('gone');
  if (!audioOn) $('#sound-pill').classList.remove('hidden');
}

// ---------- Render ----------
let lastHandNo = null;
let lastBoardLen = 0;
const lastTag = new Map();

function render(s) {
  state = s;
  const h = s.hand;
  if (s.handNo > 0) hideStartIfPlaying();

  $('#hand-no').textContent = s.handNo ? `Mano ${s.handNo}` : 'Esperando jugadores';
  $('#blinds').textContent = `Ciegas ${fmt(s.settings.sb)}/${fmt(s.settings.bb)}`;

  const seated = s.seats.filter(Boolean).length;
  const free = s.seats.some((x) => !x);
  const showLobby = (!h || h.ended) && (s.handNo === 0 || seated < 2);
  $('#lobby').classList.toggle('hidden', !showLobby);
  $('#join-mini').classList.toggle('hidden', showLobby || !free);
  if (s.joinUrl) $('#join-url').textContent = s.joinUrl;

  renderBoard(h);
  renderSeats(s);
  renderWinner(s);
}

function renderBoard(h) {
  const board = $('#board');
  const newHand = h?.no !== lastHandNo;
  if (!h) {
    board.innerHTML = '';
    $('#pot').innerHTML = '';
    $('#center-msg').textContent = state.seats.filter(Boolean).length >= 2 ? 'Esperando al dealer para repartir…' : '';
    lastBoardLen = 0;
    return;
  }
  const prev = newHand ? 0 : lastBoardLen;
  const winCards = new Set(h.ended && h.results ? h.results.filter((r) => r.amount > 0 && r.best).flatMap((r) => r.best) : []);
  let html = '';
  for (let i = 0; i < 5; i++) {
    const c = h.board[i];
    if (!c) html += '<div class="slot"></div>';
    else {
      const cls = [i >= prev ? 'flip-in' : '', winCards.size ? (winCards.has(c) ? 'win' : 'dim') : ''].join(' ');
      html += cardHtml(c, { cls });
    }
  }
  board.innerHTML = html;
  lastBoardLen = h.board.length;

  const pot = h.ended ? 0 : h.totalPot;
  $('#pot').innerHTML = h.ended || !pot ? '' : `Pozo ${fmt(pot)}`;
  let msg = '';
  if (h.runout && !h.ended) msg = '🔥 ¡Todos all-in! Se reparte todo…';
  else if (h.ended) msg = '';
  $('#center-msg').textContent = msg;
}

function renderSeats(s) {
  const h = s.hand;
  const newHand = h?.no !== lastHandNo;
  const winners = new Set(h?.ended && h.results ? h.results.filter((r) => r.amount > 0).map((r) => r.seat) : []);
  const resultBySeat = new Map((h?.results || []).map((r) => [r.seat, r]));
  let html = '';

  s.seats.forEach((p, i) => {
    const [x, y] = SEAT_POS[i];
    if (!p) {
      html += `<div class="seat empty" style="left:${x}%;top:${y}%"><div class="seat-cards"></div><div class="seat-empty-label">Asiento libre</div></div>`;
      return;
    }
    const hp = h?.players[i];
    const cls = ['seat'];
    if (h && !h.ended && h.toAct === i) cls.push('turn');
    if (hp?.folded) cls.push('folded');
    if (!hp && h) cls.push('out');
    if (p.sitOut) cls.push('out');
    if (winners.has(i)) cls.push('won');

    // Cartas: boca abajo durante la mano; boca arriba en el showdown.
    let cards = '';
    if (hp && !hp.folded) {
      const res = resultBySeat.get(i);
      const best = new Set(res?.best || []);
      if (hp.shown) cards = hp.shown.map((c) => cardHtml(c, { cls: `flip-in ${winners.has(i) && best.has(c) ? 'win' : ''}` })).join('');
      else cards = [0, 1].map((k) => cardHtml(null, { back: true, cls: newHand ? 'deal-in' : '' })).join('');
    }

    // Etiqueta: mano en el showdown, o última acción.
    let tag = '';
    const res = resultBySeat.get(i);
    if (h?.ended && res && !res.uncontested) tag = `<div class="tag handname">${esc(res.handName)}</div>`;
    else if (h?.ended && res?.uncontested) tag = `<div class="tag handname">Gana</div>`;
    else if (hp?.lastAction && !h?.ended) {
      const a = hp.lastAction;
      const label = ACTION_LABEL[a.type] || a.type;
      const amt = a.type === 'raise' || a.type === 'call' ? ` ${fmt(a.amount)}` : a.type === 'allin' ? '' : '';
      tag = `<div class="tag ${a.type}">${label}${amt}</div>`;
    }

    const stack = s.seats[i].stack;
    html += `<div class="${cls.join(' ')}" style="left:${x}%;top:${y}%" data-seat="${i}">
      <div class="seat-cards">${cards}</div>
      <div class="plate-wrap">${tag}
      <div class="plate">
        <div class="nm">${esc(p.name)}${p.connected ? '' : '<span class="offline-dot" title="Desconectado"></span>'}</div>
        <div class="st">${p.sitOut ? 'Fuera' : stack === 0 && (!hp || !hp.allIn || h?.ended) ? 'Sin fichas' : fmt(stack)}</div>
        <div class="timer" style="width:0"></div>
      </div></div>
    </div>`;

    // Apuesta frente al asiento
    if (hp && hp.bet > 0 && !h.ended) {
      const [bx, by] = lerp([x, y], CENTER, 0.4);
      html += `<div class="bet" style="left:${bx}%;top:${by}%"><span class="chip"></span>${fmt(hp.bet)}</div>`;
    }
  });

  // Botón del dealer
  if (s.button >= 0 && s.seats[s.button] && h) {
    const [dx, dy] = lerp(SEAT_POS[s.button], CENTER, 0.27);
    html += `<div class="dealer-btn" style="left:${dx + 4}%;top:${dy}%">D</div>`;
  }

  $('#seats').innerHTML = html;
  lastHandNo = h?.no ?? null;
}

function renderWinner(s) {
  const h = s.hand;
  const el = $('#winner');
  if (!h?.ended || !h.results) {
    el.classList.add('hidden');
    return;
  }
  const won = h.results.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
  const parts = won.map((r) => `<span class="w-item"><b>${esc(s.seats[r.seat]?.name ?? '?')}</b> +${fmt(r.amount)}${r.handName ? ` <small>${esc(r.handName)}</small>` : ''}</span>`);
  el.innerHTML = `<span class="w-trophy">🏆</span>${parts.join('')}`;
  el.classList.toggle('many', won.length > 2);
  el.classList.remove('hidden');
}

// Barra de tiempo del turno
setInterval(() => {
  const h = state?.hand;
  if (!h || h.ended || h.toAct === null || !h.deadline) return;
  const bar = document.querySelector(`.seat[data-seat="${h.toAct}"] .timer`);
  if (!bar) return;
  const total = state.settings.actionTimeout * 1000;
  const left = Math.max(0, h.deadline - net.now());
  bar.style.width = `${(left / total) * 100}%`;
  bar.classList.toggle('low', left < 10000);
}, 250);

// ---------- Efectos ----------
function restart(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
function onEvent(name, d) {
  switch (name) {
    case 'handStart':
      pk.deal(6);
      break;
    case 'action':
      if (d.type === 'fold') pk.fold();
      else if (d.type === 'check') pk.check();
      else if (d.type === 'allin') {
        pk.allin();
        const el = $('#fx-banner');
        el.textContent = `ALL-IN · ${state?.seats[d.seat]?.name ?? ''}`;
        restart(el, 'show');
      } else pk.chips(d.type === 'raise' ? 5 : 3);
      break;
    case 'street':
      pk.card();
      break;
    case 'handEnd':
      pk.win();
      break;
    case 'joined':
      pk.chips(4);
      break;
    case 'drink': {
      const el = $('#fx-drink');
      el.querySelector('.drink-who').textContent = d.name || 'Todos';
      el.querySelector('.drink-reason').textContent = d.reason || '';
      setTimeout(() => {
        restart(el, 'show');
        sfx.drink();
      }, name === 'drink' && d.reason?.includes('fichas') ? 1500 : 0);
      break;
    }
  }
}

net = connect('tv', {
  onState: render,
  onEvent,
  onStatus: (ok) => $('#offline').classList.toggle('hidden', ok),
});
