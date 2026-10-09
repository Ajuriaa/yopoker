// Sonidos sintetizados con Web Audio: no hay archivos que se puedan perder.
// (Base copiada de Yopardi, con sonidos de poker al final.)

let ctx = null;
let master = null;

export function unlockAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx.state !== 'closed';
}

function tone({ freq, type = 'sine', start = 0, dur = 0.3, vol = 0.4, attack = 0.005, slideTo = null, filter = null }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let node = osc;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filter;
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noise({ start = 0, dur = 0.4, vol = 0.3, from = 400, to = 4000 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + start;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(from, t0);
  f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t0);
}

const notes = (list, opts) => list.forEach(([freq, start, dur]) => tone({ freq, start, dur, ...opts }));

export const sfx = {
  // Ding de respuesta revelada (estilo Feud)
  reveal() {
    tone({ freq: 1046, type: 'triangle', dur: 0.5, vol: 0.35 });
    tone({ freq: 1568, type: 'sine', start: 0.08, dur: 0.7, vol: 0.3 });
  },
  // La #1: ding más grande
  top() {
    notes([[784, 0, 0.3], [1046, 0.1, 0.3], [1318, 0.2, 0.3], [1568, 0.3, 0.8]], { type: 'triangle', vol: 0.3 });
  },
  // Buzzer de strike
  strike() {
    tone({ freq: 98, type: 'sawtooth', dur: 1.0, vol: 0.5, attack: 0.01, filter: 1400 });
    tone({ freq: 104, type: 'square', dur: 1.0, vol: 0.3, attack: 0.01, filter: 1200 });
  },
  // Abrir pregunta de Jeopardy
  open() {
    noise({ dur: 0.45, vol: 0.25, from: 300, to: 5000 });
  },
  dailyDouble() {
    noise({ dur: 0.6, vol: 0.2, from: 200, to: 6000 });
    notes([[523, 0.1, 0.2], [659, 0.2, 0.2], [784, 0.3, 0.2], [1046, 0.4, 0.2], [1318, 0.5, 0.25], [1568, 0.62, 0.9]], { type: 'square', vol: 0.12 });
  },
  correct() {
    notes([[659, 0, 0.15], [880, 0.1, 0.15], [1318, 0.2, 0.5]], { type: 'triangle', vol: 0.35 });
  },
  wrong() {
    tone({ freq: 330, type: 'sawtooth', dur: 0.35, vol: 0.25, slideTo: 220, filter: 1500 });
    tone({ freq: 220, type: 'sawtooth', start: 0.3, dur: 0.6, vol: 0.25, slideTo: 140, filter: 1200 });
  },
  // Caja registradora cuando se dan los puntos
  award() {
    tone({ freq: 2093, type: 'square', dur: 0.08, vol: 0.12 });
    tone({ freq: 2637, type: 'square', start: 0.07, dur: 0.5, vol: 0.12 });
    noise({ start: 0.05, dur: 0.25, vol: 0.12, from: 3000, to: 8000 });
  },
  // Gluglú para TOMA
  drink() {
    for (let i = 0; i < 4; i++) tone({ freq: 260 + i * 40, type: 'sine', start: i * 0.13, dur: 0.12, vol: 0.4, slideTo: 520 + i * 60 });
    tone({ freq: 110, type: 'triangle', start: 0.6, dur: 0.3, vol: 0.4 });
  },
  steal() {
    notes([[440, 0, 0.12], [440, 0.15, 0.12], [587, 0.3, 0.5]], { type: 'square', vol: 0.15 });
  },
  tick() {
    tone({ freq: 1800, type: 'square', dur: 0.04, vol: 0.12 });
  },
  timeUp() {
    tone({ freq: 196, type: 'sawtooth', dur: 1.1, vol: 0.4, filter: 1800 });
  },
  win() {
    const seq = [[523, 0, 0.18], [523, 0.18, 0.18], [523, 0.36, 0.18], [659, 0.54, 0.5], [587, 1.0, 0.18], [659, 1.18, 0.18], [784, 1.36, 1.2]];
    notes(seq, { type: 'square', vol: 0.15 });
    notes(seq.map(([f, s, d]) => [f / 2, s, d]), { type: 'triangle', vol: 0.25 });
  },
};

// ---------- Poker ----------
export const pk = {
  // Fichas cayendo
  chips(n = 3) {
    for (let i = 0; i < n; i++) {
      tone({ freq: 2600 + Math.random() * 900, type: 'triangle', start: i * 0.05, dur: 0.06, vol: 0.18 });
      noise({ start: i * 0.05, dur: 0.05, vol: 0.08, from: 4000, to: 7000 });
    }
  },
  // Carta deslizándose
  card() {
    noise({ dur: 0.12, vol: 0.18, from: 1500, to: 6000 });
  },
  deal(n = 4) {
    for (let i = 0; i < n; i++) noise({ start: i * 0.09, dur: 0.1, vol: 0.15, from: 1500, to: 6000 });
  },
  // Toc-toc en la mesa
  check() {
    tone({ freq: 160, type: 'sine', dur: 0.08, vol: 0.5 });
    tone({ freq: 160, type: 'sine', start: 0.12, dur: 0.08, vol: 0.5 });
  },
  fold() {
    noise({ dur: 0.25, vol: 0.12, from: 3000, to: 600 });
  },
  allin() {
    tone({ freq: 110, type: 'sawtooth', dur: 0.9, vol: 0.25, filter: 900 });
    [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, type: 'square', start: 0.1 + i * 0.08, dur: 0.25, vol: 0.1 }));
    setTimeout(() => pk.chips(8), 150);
  },
  win() {
    [[523, 0], [659, 0.12], [784, 0.24], [1046, 0.36], [1318, 0.5]].forEach(([f, st]) => tone({ freq: f, type: 'triangle', start: st, dur: 0.4, vol: 0.25 }));
    setTimeout(() => pk.chips(10), 300);
  },
  yourTurn() {
    tone({ freq: 880, type: 'sine', dur: 0.15, vol: 0.35 });
    tone({ freq: 1318, type: 'sine', start: 0.12, dur: 0.3, vol: 0.3 });
  },
  tick() {
    tone({ freq: 1800, type: 'square', dur: 0.04, vol: 0.1 });
  },
};
