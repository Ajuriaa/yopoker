import { connect } from './net.js';
import { cardHtml, esc, fmt, ACTION_LABEL } from './cards.js';

const $ = (s) => document.querySelector(s);
let state = null;
let net = null;

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

function sheet({ title, body = '', ok = 'OK', read = () => true, hideOk = false }) {
  return new Promise((resolve) => {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = body;
    $('#sheet-ok').textContent = ok;
    $('#sheet-ok').classList.toggle('hidden', hideOk);
    $('#sheet').classList.remove('hidden');
    const input = $('#sheet-body input');
    if (input) setTimeout(() => input.focus(), 50);
    const close = (v) => {
      $('#sheet').classList.add('hidden');
      resolve(v);
    };
    $('#sheet-ok').onclick = () => close(read());
    $('#sheet-cancel').onclick = () => close(null);
    $('#sheet-body').onclick = (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) close(b.dataset.pick);
    };
    if (input) input.onkeydown = (e) => e.key === 'Enter' && close(read());
  });
}
const askNumber = (title, value = '') =>
  sheet({
    title,
    body: `<input type="number" inputmode="numeric" value="${esc(value)}">`,
    read: () => {
      const v = Number($('#sheet-body input').value);
      return $('#sheet-body input').value !== '' && Number.isFinite(v) ? v : null;
    },
  });
const askText = (title, value = '') => sheet({ title, body: `<input type="text" maxlength="14" value="${esc(value)}">`, read: () => $('#sheet-body input').value.trim() || null });
const askConfirm = (title, ok = 'Sí') => sheet({ title, ok });

let lastTap = 0;
function send(action, payload = {}) {
  const now = Date.now();
  if (now - lastTap < 400) return;
  lastTap = now;
  if (!net.send(action, payload)) toast('Sin conexión con la compu', true);
  navigator.vibrate?.(12);
}

// ---------- Render ----------
function render() {
  const s = state;
  const h = s.hand;
  $('#sub').textContent = `${s.handNo ? `Mano ${s.handNo} · ` : ''}Ciegas ${fmt(s.settings.sb)}/${fmt(s.settings.bb)}`;
  const seated = s.seats.filter(Boolean);
  const inProgress = h && !h.ended;

  // 1. Mano
  let handCard = '';
  if (inProgress) {
    const turn = h.toAct !== null ? s.seats[h.toAct] : null;
    handCard = `<div class="card-box"><h2>Mano en juego</h2>
      <div class="state-line">${h.runout ? '🔥 Todos all-in, repartiendo…' : turn ? `Turno de ${esc(turn.name)}` : '…'}
        <small>${stageName(h.stage)} · Pozo ${fmt(h.totalPot)}</small></div>
      <div class="mini-board">${h.board.map((c) => cardHtml(c)).join('')}</div>
      ${
        turn && !h.runout
          ? `<div class="row" style="margin-top:12px">
              <button class="btn" data-act="forceCheck">Pasar/retirar por él</button>
              <button class="btn danger" data-confirm="¿Retirar a ${esc(turn.name)} de esta mano?" data-act="forceFold">Retirarlo</button></div>
             <p class="hint">Usalo si alguien se fue al baño o se le murió el cel.</p>`
          : ''
      }
      <div class="row" style="margin-top:8px"><button class="btn danger" data-confirm="¿Cancelar la mano? Se devuelven las fichas que cada uno puso." data-act="cancelHand">Cancelar mano</button></div>
    </div>`;
  } else {
    const canDeal = seated.filter((p) => !p.sitOut && p.stack > 0).length >= 2;
    const last = h?.ended && h.results ? h.results.filter((r) => r.amount > 0).map((r) => `${esc(s.seats[r.seat]?.name ?? '?')} ganó ${fmt(r.amount)}${r.handName ? ` (${esc(r.handName)})` : ''}`).join('<br>') : '';
    handCard = `<div class="card-box"><h2>Siguiente mano</h2>
      ${last ? `<p class="hint" style="margin:0 0 10px;color:var(--text)">🏆 ${last}</p>` : ''}
      <button class="btn go big" data-act="startHand" style="width:100%" ${canDeal ? '' : 'disabled'}>🃏 Repartir</button>
      ${canDeal ? '' : '<p class="hint">Se necesitan al menos 2 jugadores con fichas. Que escaneen el QR de la TV.</p>'}
    </div>`;
  }

  const autoCard = `<div class="card-box"><div class="toggle"><div><b>Repartir solo</b><p class="hint" style="margin:2px 0 0">La siguiente mano arranca 8 s después de que termina una.</p></div>
    <button class="btn sm ${s.autoNext ? 'on' : ''}" data-act="setAutoNext" data-p='{"value":${!s.autoNext}}'>${s.autoNext ? 'Sí' : 'No'}</button></div></div>`;

  // 2. Jugadores
  const rows = s.seats
    .map((p, i) => {
      if (!p) return '';
      const hp = h?.players[i];
      const badges = [
        !p.connected ? '<span class="badge red">sin conexión</span>' : '',
        p.sitOut ? '<span class="badge">afuera</span>' : '',
        p.stack === 0 && !hp?.allIn ? '<span class="badge red">sin fichas</span>' : '',
        s.button === i && h ? '<span class="badge gold">D</span>' : '',
        hp?.folded && inProgress ? '<span class="badge">se retiró</span>' : '',
        hp?.allIn && inProgress ? '<span class="badge red">all-in</span>' : '',
      ].join('');
      const last = inProgress && hp?.lastAction ? `${ACTION_LABEL[hp.lastAction.type] || ''} ${hp.lastAction.amount ? fmt(hp.lastAction.amount) : ''}` : '';
      return `<div class="pl ${inProgress && h.toAct === i ? 'turn' : ''}">
        <div class="num">${i + 1}</div>
        <div><div class="nm">${esc(p.name)}${badges}</div><div class="meta">${last}</div><div class="st">${fmt(p.stack)}</div></div>
        <div class="btns"><button class="btn sm" data-act="drink" data-p='{"seat":${i}}'>🍺</button><button class="btn sm" data-ui="player" data-p='{"seat":${i}}'>⋯</button></div>
      </div>`;
    })
    .join('');
  const playersCard = `<div class="card-box"><h2>Jugadores (${seated.length}/8)</h2>
    <div class="players">${rows || '<p class="hint">Nadie todavía. Que escaneen el QR de la TV.</p>'}</div>
    <div class="row" style="margin-top:10px"><button class="btn primary" data-act="drink" data-p='{"seat":null,"reason":"¡Todos toman!"}'>🍻 Todos toman</button></div>
    <p class="hint">Para unirse: <span class="join-url">${esc(s.joinUrl)}</span> (o el QR de la TV)</p></div>`;

  // 3. Ajustes
  const blinds = [[5, 10], [10, 20], [25, 50], [50, 100], [100, 200], [200, 400]];
  const timers = [[0, 'Sin límite'], [30, '30 s'], [60, '60 s'], [90, '90 s']];
  const stacks = [500, 1000, 2000, 5000];
  const settingsCard = `<div class="card-box"><h2>Ciegas (desde la próxima mano)</h2>
      <div class="chips">${blinds.map(([a, b]) => `<button class="btn ${s.settings.sb === a && s.settings.bb === b ? 'on' : ''}" data-act="setBlinds" data-p='{"sb":${a},"bb":${b}}'>${a}/${b}</button>`).join('')}</div>
    </div>
    <div class="card-box"><h2>Tiempo por turno</h2>
      <div class="chips">${timers.map(([v, l]) => `<button class="btn ${s.settings.actionTimeout === v ? 'on' : ''}" data-act="setTimeout" data-p='{"seconds":${v}}'>${l}</button>`).join('')}</div>
      <p class="hint">Si se acaba el tiempo: pasa si puede, si no se retira.</p>
    </div>
    <div class="card-box"><h2>Fichas al sentarse / recompra</h2>
      <div class="chips">${stacks.map((v) => `<button class="btn ${s.settings.startingStack === v ? 'on' : ''}" data-act="setStartingStack" data-p='{"value":${v}}'>${fmt(v)}</button>`).join('')}</div>
    </div>
    <div class="card-box"><h2>Mesa</h2>
      <button class="btn danger" style="width:100%" data-act="resetTable" data-confirm="¿Reiniciar la mesa? Todos vuelven a ${fmt(s.settings.startingStack)} fichas.">🗑 Reiniciar fichas de todos</button>
    </div>`;

  $('#panel').innerHTML = handCard + autoCard + playersCard + settingsCard;
}

const stageName = (st) => ({ preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' })[st] || st;

// ---------- Clicks ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) {
    if (b.dataset.confirm && !(await askConfirm(b.dataset.confirm))) return;
    send(b.dataset.act, JSON.parse(b.dataset.p || '{}'));
    return;
  }
  const u = e.target.closest('[data-ui]');
  if (u) await playerMenu(JSON.parse(u.dataset.p).seat);
});

async function playerMenu(seat) {
  const p = state.seats[seat];
  if (!p) return;
  const pick = await sheet({
    title: `${p.name} · ${fmt(p.stack)} fichas`,
    hideOk: true,
    body: `<div class="menu-list">
      <button class="btn" data-pick="rebuy">💰 Recompra (+${fmt(state.settings.startingStack)})</button>
      <button class="btn" data-pick="add">➕ Sumar fichas…</button>
      <button class="btn" data-pick="sub">➖ Quitar fichas…</button>
      <button class="btn" data-pick="sitout">${p.sitOut ? '✋ Volver a jugar' : '☕ Sentarlo afuera'}</button>
      <button class="btn" data-pick="rename">✏️ Cambiar nombre</button>
      <button class="btn danger" data-pick="kick">🚪 Sacarlo de la mesa</button>
    </div>`,
  });
  if (pick === 'rebuy') send('rebuy', { seat });
  else if (pick === 'add' || pick === 'sub') {
    const v = await askNumber(pick === 'add' ? `Sumar fichas a ${p.name}` : `Quitar fichas a ${p.name}`);
    if (v) send('adjustStack', { seat, delta: pick === 'add' ? v : -v });
  } else if (pick === 'sitout') send('setSitOut', { seat, value: !p.sitOut });
  else if (pick === 'rename') {
    const n = await askText(`Nuevo nombre para ${p.name}`, p.name);
    if (n) send('rename', { seat, name: n });
  } else if (pick === 'kick') {
    if (await askConfirm(`¿Sacar a ${p.name} de la mesa? Si está en una mano, se retira.`, 'Sacarlo')) send('kick', { seat });
  }
}

net = connect('dealer', {
  onState: (s) => {
    state = s;
    $('#badkey').classList.add('hidden');
    render();
  },
  onEvent: (name, d) => {
    if (name === 'toast') toast(d.msg);
    if (name === 'joined') toast(`${d.name} se sentó en el asiento ${d.seat + 1}`);
  },
  onToast: toast,
  onStatus: (ok) => $('#dot').classList.toggle('ok', ok),
  onError: (m) => m.code === 'bad-key' && $('#badkey').classList.remove('hidden'),
});
