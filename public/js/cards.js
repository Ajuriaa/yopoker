// Dibujo de cartas en HTML (compartido por TV, jugadores y dealer).

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };

export const rankLabel = (c) => RANK[c[0]] || c[0];
export const suitLabel = (c) => SUIT[c[1]];

export function cardHtml(code, { cls = '', back = false } = {}) {
  if (back || !code) return `<div class="card back ${cls}"><div class="card-pattern"></div></div>`;
  const red = code[1] === 'h' || code[1] === 'd';
  return `<div class="card ${red ? 'red' : 'black'} ${cls}" data-card="${code}">
    <div class="card-corner"><span class="r">${rankLabel(code)}</span><span class="s">${suitLabel(code)}</span></div>
    <div class="card-center">${suitLabel(code)}</div>
  </div>`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmt = (n) => Number(n || 0).toLocaleString('es-HN');

export const ACTION_LABEL = {
  sb: 'Ciega chica',
  bb: 'Ciega grande',
  fold: 'Se retira',
  check: 'Pasa',
  call: 'Iguala',
  raise: 'Sube',
  allin: 'ALL-IN',
};
