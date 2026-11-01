/* The client every surface uses.
 *
 * One file, no build step, no framework. These pages are going to be handed
 * to a design team who will rebuild them properly; what they need from this
 * version is to see exactly which fields exist and what the API does when
 * it says no, not to inherit a toolchain.
 *
 * Every call goes to the same control plane the Go manager serves. In the
 * demo that is server/server.mjs replaying recordings; in production it is
 * the manager itself. Nothing here knows the difference, which is the
 * point -- pointing a surface at a real cluster is a change of base URL.
 */

export const API = (() => {
  // Same origin in both the local server and the deployed Pages project.
  // Overridable so a designer can run the pages off the filesystem.
  const override = new URLSearchParams(location.search).get('api');
  return override || '';
})();

const TOKEN_KEY = 'ascend-demo-persona';

export function currentPersona() {
  const fromURL = new URLSearchParams(location.search).get('as');
  if (fromURL) {
    try { localStorage.setItem(TOKEN_KEY, `demo-${fromURL}`); } catch { /* private window */ }
    return `demo-${fromURL}`;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) || 'demo-fleet-operator';
  } catch {
    return 'demo-fleet-operator';
  }
}

export function setPersona(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
}

/** call returns {status, body, ok} and NEVER throws on a 4xx.
 *
 *  A refusal is data here, not an exception. Half the point of these
 *  surfaces is to show what a customer sees when the policy says no, and a
 *  client that threw would make every page handle that as breakage. */
export async function call(path, { method = 'GET', body = null, persona = null } = {}) {
  const token = persona || currentPersona();
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, opts);
  } catch (err) {
    return { status: 0, ok: false, body: { error: 'Unreachable', reason: String(err) } };
  }
  if (res.status === 204) return { status: 204, ok: true, body: null };
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, ok: res.ok, body: parsed };
}

export const demo = {
  personas: () => call('/__demo/personas'),
  series: () => call('/__demo/timeline/series'),
  now: () => call('/__demo/timeline/now'),
  start: () => call('/__demo/timeline/start', { method: 'POST' }),
  stop: () => call('/__demo/timeline/stop', { method: 'POST' }),
  reset: () => call('/__demo/reset', { method: 'POST' }),
  tree: () => call('/__demo/tree'),
  audit: (tenant) => call(`/__demo/audit${tenant ? `?tenant=${tenant}` : ''}`),
  cluster: (kind) => call(`/__demo/cluster/${kind}`),
  hardware: (name) => call(`/__demo/hardware/${name}`),
};

/* ------------------------------------------------------------ rendering */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Render a value, distinguishing the three things that are NOT the same:
 *  a real zero, a field that exists and is empty, and a field that was
 *  never captured. A UI that shows all three as "—" is how a wrong page
 *  comes to look like a quiet fleet. */
export function val(v, { zero = '0', missing = '—', empty = '' } = {}) {
  if (v === 0) return zero;
  if (v === null || v === undefined) return missing;
  if (v === '') return empty || missing;
  return String(v);
}

export function pill(text, kind = '') {
  return el('span', { class: `pill ${kind}` }, text);
}

export function phasePill(phase) {
  const kind = {
    Ready: 'ok', Running: 'ok', Succeeded: 'ok', Active: 'ok',
    Pending: 'warn', Scaling: 'warn', Provisioning: 'warn',
    Failed: 'bad', Error: 'bad', Unschedulable: 'bad',
  }[phase] || '';
  return pill(phase || 'unknown', kind);
}

/** statusPill renders an HTTP status the way these pages treat them: a 403
 *  is a correct answer, not a fault, and must not be coloured as one. */
export function statusPill(status) {
  if (status === 0) return pill('unreachable', 'bad');
  if (status < 300) return pill(String(status), 'ok');
  if (status === 401) return pill('401 unauthenticated', 'warn');
  if (status === 403) return pill('403 refused by policy', 'policy');
  if (status === 404) return pill('404 not yours', 'policy');
  if (status === 501) return pill('501 not recorded', 'warn');
  return pill(String(status), 'bad');
}

export function table(columns, rows, renderRow) {
  const t = el('table', { class: 'grid' });
  t.append(el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', {}, c)))));
  const body = el('tbody');
  if (!rows || rows.length === 0) {
    body.append(el('tr', {}, el('td', { class: 'muted', colspan: String(columns.length) },
      'nothing here')));
  } else {
    for (const r of rows) body.append(renderRow(r));
  }
  t.append(body);
  return t;
}

export function card(title, ...children) {
  return el('section', { class: 'card' },
    title ? el('h2', {}, title) : null,
    ...children);
}

/** A panel that shows a refusal honestly, including WHY. The reason string
 *  comes from the control plane and is written to be read by a human. */
export function refusal(res, what) {
  return el('div', { class: 'refusal' },
    statusPill(res.status),
    el('div', {},
      el('strong', {}, what),
      el('p', {}, res.body?.reason || res.body?.errorDescription || 'no reason given')));
}

export function money(v, currency = 'USD') {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (Number.isNaN(n)) return String(v);
  return `${n.toFixed(2)} ${currency}`;
}

export function ago(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* ------------------------------------------------------------- the chrome */

const SURFACES = [
  ['/', 'Overview'],
  ['/console/', 'Fleet console'],
  ['/serving/', 'Serving'],
  ['/workspace/', 'Workspace'],
  ['/tenant/', 'Tenancy'],
  ['/finance/', 'Finance'],
  ['/support/', 'Audit & support'],
];

export async function chrome(active) {
  const header = el('header', { class: 'top' });
  const nav = el('nav', {});
  for (const [href, label] of SURFACES) {
    nav.append(el('a', {
      href, class: href === active ? 'on' : '',
    }, label));
  }

  const picker = el('select', {
    class: 'persona',
    onchange: (e) => { setPersona(e.target.value); location.reload(); },
  });
  const res = await demo.personas();
  const me = currentPersona();
  for (const p of res.body || []) {
    picker.append(el('option', {
      value: p.token, selected: p.token === me ? 'selected' : null,
    }, `${p.username} — ${p.role}`));
  }

  header.append(
    el('a', { class: 'brand', href: '/' },
      el('span', { class: 'dot' }), 'Ascend Fleet'),
    nav,
    el('div', { class: 'spacer' }),
    el('span', { class: 'demo-tag', title: 'Every body on these pages was recorded from a real control plane on real Ascend hardware. Nothing is synthesised.' }, 'recorded'),
    picker,
  );
  document.body.prepend(header);
  return (res.body || []).find((p) => p.token === me) || null;
}

export function pageTitle(title, subtitle) {
  return el('div', { class: 'page-head' },
    el('h1', {}, title),
    subtitle ? el('p', { class: 'sub' }, subtitle) : null);
}
