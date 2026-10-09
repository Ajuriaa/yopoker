// Yopoker: servidor local. Es la única fuente de verdad de la mesa.
// La TV ve la mesa, cada jugador recibe SOLO sus cartas, y el dealer controla el juego.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import {
  createTable,
  addPlayer,
  removePlayer,
  startHand,
  act,
  legalActions,
  stepRunout,
  foldOutOfTurn,
  cancelHand,
  collectedPot,
  handInProgress,
  cleanName,
  PokerError,
  MAX_SEATS,
} from './engine.js';
import { currentHandName } from './cards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3100;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FONTS_DIR = path.join(__dirname, 'node_modules', '@fontsource');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const KEY_FILE = path.join(DATA_DIR, '.dealer-key');
const RUNOUT_STEP_MS = 1600;
const AUTO_NEXT_MS = 8000;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Estado ----------

function freshState() {
  return { table: createTable(), tokens: {}, autoNext: true };
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.table || !Array.isArray(s.table.seats)) throw new Error('estado inválido');
    // Tras reiniciar, el que tenía el turno recibe su tiempo completo otra vez.
    if (s.table.hand && !s.table.hand.ended) s.table.hand.actionStartedAt = Date.now();
    return { ...freshState(), ...s };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('⚠️  No se pudo leer el estado guardado:', err.message);
    return freshState();
  }
}

let state = loadState();
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('⚠️  No se pudo guardar:', err.message);
    }
  }, 50);
}

let DEALER_KEY = '';
try {
  DEALER_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
} catch {}
if (!DEALER_KEY) {
  DEALER_KEY = crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(KEY_FILE, DEALER_KEY);
}

// ---------- Vistas (cada quien ve solo lo que le toca) ----------

const t = () => state.table;

function publicView() {
  const table = t();
  const h = table.hand;
  const contested = h?.ended && h.results && !h.results[0]?.uncontested;
  return {
    settings: table.settings,
    autoNext: state.autoNext,
    joinUrl: joinUrl(),
    handNo: table.handNo,
    button: table.button,
    seats: table.seats.map((s, i) =>
      s ? { name: s.name, stack: s.stack, sitOut: s.sitOut, leaving: s.leaving, connected: isConnected(s.id), seat: i } : null
    ),
    hand: h
      ? {
          no: h.no,
          stage: h.stage,
          board: h.board,
          toAct: h.toAct,
          deadline: h.toAct !== null && table.settings.actionTimeout > 0 ? h.actionStartedAt + table.settings.actionTimeout * 1000 : null,
          pot: collectedPot(h),
          totalPot: h.order.reduce((sum, i) => sum + h.players[i].total, 0),
          currentBet: h.currentBet,
          sbSeat: h.sbSeat,
          bbSeat: h.bbSeat,
          runout: h.runout,
          ended: h.ended,
          pots: h.ended ? h.pots : null,
          results: h.ended ? h.results : null,
          players: Object.fromEntries(
            h.order.map((i) => {
              const p = h.players[i];
              const shown = contested && !p.folded ? p.cards : null;
              return [i, { bet: p.bet, total: p.total, folded: p.folded, allIn: p.allIn, lastAction: p.lastAction, shown }];
            })
          ),
        }
      : null,
  };
}

function playerView(id) {
  const view = publicView();
  const table = t();
  const seat = table.seats.findIndex((s) => s && s.id === id);
  if (seat === -1) return { ...view, me: null };
  const h = table.hand;
  const p = h?.players[seat];
  view.me = {
    seat,
    cards: p ? p.cards : null,
    handName: p && !p.folded ? currentHandName(p.cards, h.board) : null,
    legal: p ? legalActions(table, seat) : null,
  };
  return view;
}

function dealerView() {
  return { ...publicView(), joinUrl: joinUrl(), dealer: true };
}

// ---------- Conexiones ----------

const clients = new Set();
function isConnected(id) {
  for (const c of clients) if (c.role === 'player' && c.playerId === id) return true;
  return false;
}
function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast() {
  const pub = publicView();
  const dealer = dealerView();
  const now = Date.now();
  for (const c of clients) {
    if (c.role === 'tv') send(c.ws, { type: 'state', state: pub, serverNow: now });
    else if (c.role === 'dealer') send(c.ws, { type: 'state', state: dealer, serverNow: now });
    else if (c.role === 'player') send(c.ws, { type: 'state', state: playerView(c.playerId), serverNow: now });
  }
}
function emit(name, data = {}) {
  for (const c of clients) if (c.role) send(c.ws, { type: 'event', name, data });
}
function emitTo(playerId, name, data = {}) {
  for (const c of clients) if (c.role === 'player' && c.playerId === playerId) send(c.ws, { type: 'event', name, data });
}

// ---------- Flujo del juego ----------

let autoNextTimer = null;
let runoutTimer = null;
let lastTurnKey = null;

// Después de cualquier cambio: avisar turnos, manejar all-in y siguiente mano.
function afterChange(prevEnded) {
  const table = t();
  const h = table.hand;
  persist();
  broadcast();
  if (!h) return;

  if (h.toAct !== null && !h.ended) {
    const key = `${h.no}-${h.stage}-${h.toAct}-${h.log.length}`;
    if (key !== lastTurnKey) {
      lastTurnKey = key;
      emitTo(table.seats[h.toAct].id, 'yourTurn');
    }
  }

  if (h.runout && !h.ended && !runoutTimer) {
    runoutTimer = setTimeout(() => {
      runoutTimer = null;
      const before = t().hand?.ended;
      if (stepRunout(t())) {
        emit('street', { stage: t().hand.stage });
        afterChange(before);
      }
    }, RUNOUT_STEP_MS);
  }

  if (h.ended && !prevEnded) onHandEnded();
}

function onHandEnded() {
  const table = t();
  const h = table.hand;
  emit('handEnd', { results: h.results });
  // Los que se quedaron sin fichas: ¡a tomar!
  for (const r of h.order) {
    const s = table.seats[r];
    if (s && s.stack === 0) emit('drink', { seat: r, name: s.name, reason: '¡Se quedó sin fichas! Shot 🥃' });
  }
  scheduleAutoNext();
}

function scheduleAutoNext() {
  clearTimeout(autoNextTimer);
  autoNextTimer = null;
  if (!state.autoNext) return;
  autoNextTimer = setTimeout(() => {
    autoNextTimer = null;
    if (!state.autoNext || handInProgress(t())) return;
    try {
      dealNewHand();
    } catch {
      // No hay suficientes jugadores: se queda esperando al dealer.
    }
  }, AUTO_NEXT_MS);
}

function dealNewHand() {
  clearTimeout(autoNextTimer);
  autoNextTimer = null;
  startHand(t());
  emit('handStart', { no: t().hand.no });
  afterChange(false);
}

// Tiempo por turno: si se acaba, pasa si puede o se retira.
setInterval(() => {
  const table = t();
  const h = table.hand;
  if (!h || h.ended || h.runout || h.toAct === null || !table.settings.actionTimeout) return;
  if (Date.now() - h.actionStartedAt < table.settings.actionTimeout * 1000) return;
  const seat = h.toAct;
  const legal = legalActions(table, seat);
  const prevEnded = h.ended;
  const type = legal?.canCheck ? 'check' : 'fold';
  try {
    act(table, seat, { type });
    emit('action', { seat, type, amount: 0, timeout: true });
  } catch (err) {
    console.error('💥 timeout', err);
  }
  afterChange(prevEnded);
}, 500);

// ---------- Acciones ----------

const int = (n, name = 'Número') => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) throw new PokerError(`${name} inválido`);
  return v;
};
const seatArg = (s) => {
  const i = int(s, 'Asiento');
  if (i < 0 || i >= MAX_SEATS || !t().seats[i]) throw new PokerError('Asiento vacío');
  return i;
};

const playerActions = {
  act(playerId, { type, amount }) {
    const table = t();
    const seat = table.seats.findIndex((s) => s && s.id === playerId);
    if (seat === -1) throw new PokerError('No estás sentado');
    const result = act(table, seat, { type, amount });
    emit('action', { seat, type: result.type, amount: result.amount });
  },
  sitOut(playerId, { value }) {
    const s = t().seats.find((x) => x && x.id === playerId);
    if (!s) throw new PokerError('No estás sentado');
    s.sitOut = !!value;
  },
  leave(playerId) {
    const table = t();
    const seat = table.seats.findIndex((s) => s && s.id === playerId);
    if (seat === -1) return;
    removePlayer(table, seat);
    for (const [tok, id] of Object.entries(state.tokens)) if (id === playerId) delete state.tokens[tok];
  },
};

const dealerActions = {
  startHand() {
    dealNewHand();
    return { handled: true };
  },
  setAutoNext({ value }) {
    state.autoNext = !!value;
    if (state.autoNext && t().hand?.ended) scheduleAutoNext();
    if (!state.autoNext) clearTimeout(autoNextTimer);
  },
  setBlinds({ sb, bb }) {
    const s = int(sb, 'Ciega chica');
    const b = int(bb, 'Ciega grande');
    if (s <= 0 || b < s) throw new PokerError('Ciegas inválidas');
    t().settings.sb = s;
    t().settings.bb = b;
    emit('toast', { msg: `Ciegas: ${s}/${b} (desde la próxima mano)` });
  },
  setStartingStack({ value }) {
    const v = int(value, 'Fichas');
    if (v <= 0) throw new PokerError('Fichas inválidas');
    t().settings.startingStack = v;
  },
  setTimeout({ seconds }) {
    const v = int(seconds, 'Tiempo');
    if (v !== 0 && (v < 10 || v > 300)) throw new PokerError('Tiempo inválido');
    t().settings.actionTimeout = v;
    if (t().hand && !t().hand.ended) t().hand.actionStartedAt = Date.now();
  },
  adjustStack({ seat, delta }) {
    const s = t().seats[seatArg(seat)];
    s.stack = Math.max(0, s.stack + int(delta));
  },
  rebuy({ seat }) {
    const i = seatArg(seat);
    const s = t().seats[i];
    s.stack += t().settings.startingStack;
    s.sitOut = false;
    emit('toast', { msg: `${s.name} recompró ${t().settings.startingStack}` });
  },
  setSitOut({ seat, value }) {
    t().seats[seatArg(seat)].sitOut = !!value;
  },
  rename({ seat, name }) {
    t().seats[seatArg(seat)].name = cleanName(name);
  },
  kick({ seat }) {
    const i = seatArg(seat);
    const id = t().seats[i].id;
    removePlayer(t(), i);
    for (const [tok, pid] of Object.entries(state.tokens)) if (pid === id) delete state.tokens[tok];
    for (const c of clients) if (c.role === 'player' && c.playerId === id) send(c.ws, { type: 'kicked' });
  },
  forceFold() {
    const h = t().hand;
    if (!h || h.ended || h.toAct === null) throw new PokerError('No hay nadie en turno');
    const seat = h.toAct;
    foldOutOfTurn(t(), seat);
    emit('action', { seat, type: 'fold', amount: 0 });
  },
  forceCheck() {
    const h = t().hand;
    if (!h || h.ended || h.toAct === null) throw new PokerError('No hay nadie en turno');
    const seat = h.toAct;
    const legal = legalActions(t(), seat);
    const type = legal.canCheck ? 'check' : 'fold';
    act(t(), seat, { type });
    emit('action', { seat, type, amount: 0 });
  },
  cancelHand() {
    cancelHand(t());
    emit('toast', { msg: 'Mano cancelada: se devolvieron las fichas' });
  },
  drink({ seat, reason }) {
    const i = seat === null || seat === undefined ? null : seatArg(seat);
    emit('drink', { seat: i, name: i === null ? null : t().seats[i].name, reason: String(reason || '¡A tomar!').slice(0, 60) });
    return { noChange: true };
  },
  resetTable() {
    const settings = t().settings;
    const keep = t().seats.map((s) => (s ? { ...s, stack: settings.startingStack, sitOut: false, leaving: false } : null));
    state.table = createTable(settings);
    state.table.seats = keep;
    clearTimeout(autoNextTimer);
    emit('toast', { msg: 'Mesa reiniciada: todos con fichas nuevas' });
  },
};

function handleAction(client, msg) {
  const table = t();
  const prevEnded = table.hand?.ended ?? true;
  if (client.role === 'player') {
    const fn = playerActions[msg.action];
    if (!fn) throw new PokerError('Acción inválida');
    fn(client.playerId, msg.payload || {});
  } else if (client.role === 'dealer') {
    const fn = dealerActions[msg.action];
    if (!fn) throw new PokerError('Acción inválida');
    const r = fn(msg.payload || {});
    // startHand ya hizo su propio afterChange; drink no cambia nada.
    if (r?.handled || r?.noChange) return;
  } else return;
  afterChange(prevEnded);
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
const safeJoin = (root, rel) => {
  const full = path.normalize(path.join(root, rel));
  return full.startsWith(root + path.sep) ? full : null;
};

function lanAddress() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) found.push({ name, address: a.address });
  }
  found.sort((a, b) => (a.name === 'en0' ? -1 : b.name === 'en0' ? 1 : 0));
  return found[0]?.address || 'localhost';
}
const joinUrl = () => `http://${lanAddress()}:${PORT}/play`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  if (p === '/') {
    res.writeHead(302, { Location: '/tv' });
    return res.end();
  }
  if (p === '/tv') return sendFile(res, path.join(PUBLIC_DIR, 'tv.html'));
  if (p === '/play') return sendFile(res, path.join(PUBLIC_DIR, 'play.html'));
  if (p === '/dealer') return sendFile(res, path.join(PUBLIC_DIR, 'dealer.html'));
  if (p === '/qr/play.svg') {
    const svg = await QRCode.toString(joinUrl(), { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    return res.end(svg);
  }
  if (p.startsWith('/fonts/')) {
    const f = safeJoin(FONTS_DIR, p.slice(7));
    return sendFile(res, f || '');
  }
  const f = safeJoin(PUBLIC_DIR, p.slice(1));
  return sendFile(res, f || '');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const client = { ws, role: null, playerId: null };
  clients.add(client);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (msg.type === 'hello') {
        if (msg.role === 'dealer') {
          if (msg.key !== DEALER_KEY) return send(ws, { type: 'error', code: 'bad-key' });
          client.role = 'dealer';
          send(ws, { type: 'state', state: dealerView(), serverNow: Date.now() });
        } else if (msg.role === 'player') {
          const id = state.tokens[msg.token];
          if (!id || !t().seats.some((s) => s && s.id === id)) {
            client.role = 'player';
            client.playerId = null;
            send(ws, { type: 'needJoin', full: !t().seats.includes(null) });
            return;
          }
          client.role = 'player';
          client.playerId = id;
          broadcast(); // para que todos vean que se conectó
        } else {
          client.role = 'tv';
          send(ws, { type: 'state', state: publicView(), serverNow: Date.now() });
        }
        return;
      }
      if (msg.type === 'join') {
        if (client.role !== 'player') return;
        const id = crypto.randomUUID();
        const token = crypto.randomBytes(16).toString('hex');
        const seat = addPlayer(t(), { id, name: msg.name });
        state.tokens[token] = id;
        client.playerId = id;
        send(ws, { type: 'joined', token, seat });
        emit('joined', { seat, name: t().seats[seat].name });
        afterChange(t().hand?.ended ?? true);
        return;
      }
      if (msg.type === 'action') {
        if (client.role === 'player' && !client.playerId) return;
        handleAction(client, msg);
      }
    } catch (err) {
      if (!(err instanceof PokerError)) console.error('💥', err);
      send(ws, { type: 'toast', msg: err instanceof PokerError ? err.message : 'Error inesperado (revisá la terminal)', error: true });
    }
  });

  const drop = () => {
    clients.delete(client);
    if (client.role === 'player') broadcast();
  };
  ws.on('close', drop);
  ws.on('error', drop);
});

setInterval(() => {
  for (const c of clients) {
    if (!c.ws.isAlive) {
      c.ws.terminate();
      clients.delete(c);
      continue;
    }
    c.ws.isAlive = false;
    c.ws.ping();
  }
}, 10000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ El puerto ${PORT} ya está en uso. Probá: PORT=3101 npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', async () => {
  const ip = lanAddress();
  const tvUrl = `http://localhost:${PORT}/tv`;
  const dealerUrl = `http://${ip}:${PORT}/dealer?k=${DEALER_KEY}`;
  console.log('\n🃏  YOPOKER listo\n');
  console.log(`📺  TV (esta compu):   ${tvUrl}`);
  console.log(`🎩  Dealer (tu cel):   ${dealerUrl}`);
  console.log(`📱  Jugadores:         ${joinUrl()}  (o el QR de la TV)\n`);
  try {
    console.log(await QRCode.toString(dealerUrl, { type: 'terminal', small: true }));
    console.log('   ↑ QR del DEALER (solo para vos)\n');
  } catch {}
  if (!process.env.NO_OPEN && process.platform === 'darwin') spawn('open', [tvUrl], { stdio: 'ignore', detached: true }).unref();
  // Si se reinició a media mano con todos all-in, retomar.
  afterChange(true);
});

function shutdown() {
  clearTimeout(saveTimer);
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
