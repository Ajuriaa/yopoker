// Conexión al servidor con reconexión automática.
// El servidor manda el estado completo en cada cambio, así que reconectar nunca pierde nada.

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {}
  },
};

export function connect(role, handlers) {
  const { onState, onEvent, onToast, onStatus, onError, onNeedJoin, onJoined, onKicked } = handlers;
  // Dealer: la llave viene en el link (?k=) y se recuerda solo si el servidor la acepta.
  const urlKey = role === 'dealer' ? new URLSearchParams(location.search).get('k') : null;
  const key = role === 'dealer' ? urlKey || store.get('yopoker-dealer-key') : null;

  let ws = null;
  let retry = 0;
  let retryTimer = null;
  let offset = 0;

  function scheduleReconnect() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, Math.min(4000, 250 * 2 ** retry++));
  }

  function open() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      sock.send(JSON.stringify({ type: 'hello', role, key, token: store.get('yopoker-token') }));
      onStatus?.(true);
    };
    sock.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.serverNow) offset = m.serverNow - Date.now();
      if (m.type === 'state') {
        if (role === 'dealer' && urlKey) store.set('yopoker-dealer-key', urlKey);
        onState?.(m.state);
      } else if (m.type === 'event') onEvent?.(m.name, m.data || {});
      else if (m.type === 'toast') onToast?.(m.msg, m.error);
      else if (m.type === 'error') onError?.(m);
      else if (m.type === 'needJoin') onNeedJoin?.(m);
      else if (m.type === 'joined') {
        store.set('yopoker-token', m.token);
        onJoined?.(m);
      } else if (m.type === 'kicked') {
        store.set('yopoker-token', null);
        onKicked?.();
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      onStatus?.(false);
      scheduleReconnect();
    };
    sock.onerror = () => sock.close();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState >= WebSocket.CLOSING) {
      retry = 0;
      open();
    }
  });

  open();

  const raw = (msg) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };
  return {
    send: (action, payload) => raw({ type: 'action', action, payload }),
    join: (name) => raw({ type: 'join', name }),
    forget: () => store.set('yopoker-token', null),
    now: () => Date.now() + offset,
  };
}
