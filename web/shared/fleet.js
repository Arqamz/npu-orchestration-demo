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
  start: (speed = 20) => call(`/__demo/timeline/start?speed=${speed}`, { method: 'POST' }),
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

/* Tables scroll horizontally on their own rather than widening the page:
 * a column count that works on a laptop does not fit a phone, and the
 * failure of the old sheet was the whole page gaining a scrollbar. */
export function table(columns, rows, renderRow) {
  const t = el('table', {});
  t.append(el('thead', {}, el('tr', {}, ...columns.map((c) => {
    const label = typeof c === 'string' ? c : c.label;
    const cls = typeof c === 'string' ? '' : (c.align === 'right' ? 'num' : '');
    return el('th', { class: cls }, label);
  }))));
  const body = el('tbody');
  if (!rows || rows.length === 0) {
    // An empty table must say WHY it is empty where it can. "nothing
    // here" under a heading is indistinguishable from a page that failed
    // to load, which is the single most common way a dashboard lies.
    body.append(el('tr', {}, el('td', {
      class: 'empty', colspan: String(columns.length),
    }, 'Nothing to show — this tenancy has none right now.')));
  } else {
    for (const r of rows) body.append(renderRow(r));
  }
  t.append(body);
  return el('div', { class: 'tbl-wrap' }, t);
}

export function card(title, ...children) {
  return el('section', { class: 'card' },
    title ? el('h3', {}, title) : null,
    ...children.filter(Boolean));
}

/** tableCard is a card whose body is a table, with the padding removed so
 *  the rows run to the card's own edges. A table inset inside a padded
 *  card reads as a picture of a table. */
export function tableCard(title, why, columns, rows, renderRow) {
  return el('section', { class: 'card flush' },
    title ? el('h3', {}, title) : null,
    why ? el('p', { class: 'note' }, why) : null,
    table(columns, rows, renderRow));
}

/** A panel that shows a refusal honestly, including WHY. The reason string
 *  comes from the control plane and is written to be read by a human. */
export function refusal(res, what) {
  return el('div', { class: 'callout policy' },
    el('span', { class: 'ic' }, statusPill(res.status)),
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

/* The theme is a CHOICE, remembered, defaulting to the system. An
 * operations console that is light when the rest of somebody's desktop
 * is dark gets closed. */
const THEME_KEY = 'ascend-demo-theme';

export function applyTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch { /* private window */ }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const sysLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const now = cur || (sysLight ? 'light' : 'dark');
  const next = now === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* not worth failing over */ }
}

/* WHO IS SIGNED IN, AS AN ORGANISATION RATHER THAN A USERNAME.
 *
 * "acme-engineer" tells a reader nothing. The questions these pages kept
 * failing -- who am I, what is a tenant, whose data is this -- are all
 * answered by naming the ORGANISATION, saying what it is, and giving it
 * its own colour so the answer is visible before anything is read.
 *
 * Each entry maps a persona to the org it belongs to. The slug drives
 * --brand through data-org on <html>, so the whole console reskins. That
 * is not decoration: a white-label platform has to look like the
 * customer's product, and an operator console and a reseller console
 * must not look like the same company's. */
export const ORGS = {
  'demo-fleet-operator': {
    org: 'huawei', mark: 'HW', name: 'Huawei · fleet operator',
    kind: 'Operator',
    what: 'You run the hardware. You see every node and every tenant, and you '
      + 'are the only one who can.',
  },
  'demo-dc-shanghai-admin': {
    org: 'sky47', mark: 'S47', name: 'Sky47', kind: 'Data centre · reseller',
    what: 'You bought capacity from the operator and resell it. Your customers '
      + 'are tenants of you, and you are invoiced for everything they spend.',
  },
  'demo-maas-co-admin': {
    org: 'maas', mark: 'MA', name: 'MaaS Co', kind: 'AI factory · model-as-a-service',
    what: 'You serve models to your own users and bill them per token, while '
      + 'paying for the cards by the second.',
  },
  'demo-acme-admin': {
    org: 'acme', mark: 'AC', name: 'Acme', kind: 'Tenant administrator',
    what: 'You hold a quota from Sky47 and administer your own team — including '
      + 'the invoices, which your engineers cannot see.',
  },
  'demo-acme-engineer': {
    org: 'acme', mark: 'AC', name: 'Acme', kind: 'Engineer',
    what: 'You can spend Acme’s cards and read your own logs. You cannot read '
      + 'Acme’s invoices: running work and seeing what it costs are '
      + 'different grants.',
  },
  'demo-acme-research-admin': {
    org: 'research', mark: 'AR', name: 'Acme Research', kind: 'Sub-tenant of Acme',
    what: 'A tenant of a tenant of a tenant. Your spend rolls up to Acme, whose '
      + 'spend rolls up to Sky47.',
  },
  'demo-globex-admin': {
    org: 'globex', mark: 'GX', name: 'Globex', kind: 'Tenant administrator',
    what: 'Another of Sky47’s customers. You cannot see Acme and Acme cannot '
      + 'see you — that separation is the product.',
  },
  'demo-lab-co-admin': {
    org: 'lab', mark: 'LB', name: 'Lab Co', kind: 'Training customer',
    what: 'You run multi-card fine-tuning jobs rather than serving endpoints.',
  },
};

export function orgOf(persona) {
  return ORGS[persona?.token] || {
    org: 'acme', mark: '??', name: persona?.username || 'unknown',
    kind: persona?.role || '', what: '',
  };
}

/** whoami is the banner that answers the question on every page. */
export function whoami(persona) {
  const o = orgOf(persona);
  return el('div', { class: 'whoami' },
    el('div', { class: 'mark' }, o.mark),
    el('div', {},
      el('div', { class: 'who-name' }, o.name,
        el('span', { class: 'who-sub' }, `  ·  ${o.kind}`)),
      o.what ? el('div', { class: 'who-sub' }, o.what) : null),
    el('div', { class: 'who-right' },
      persona?.operator ? pill('operator grant', 'brand') : null,
      persona?.tenantAdmin ? pill('tenant admin', 'policy') : null,
      el('span', { class: 'mono faint' }, persona?.username || '')));
}

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

  // The mark and the name come from whoever is signed in, and the accent
  // follows via data-org. Switching persona reskins the whole console.
  const mine = (res.body || []).find((p) => p.token === me) || null;
  const org = orgOf(mine);
  document.documentElement.setAttribute('data-org', org.org);

  header.append(
    el('a', { class: 'brand', href: '/' },
      el('span', { class: 'dot' }, org.mark), org.name),
    nav,
    el('div', { class: 'spacer' }),
    el('span', {
      class: 'demo-tag',
      title: 'Every response on these pages was recorded from a real control plane on '
        + 'real Ascend hardware. Nothing here is synthesised.',
    }, 'recorded'),
    el('button', {
      class: 'ghost', type: 'button', title: 'Switch between light and dark',
      onclick: toggleTheme,
    }, '◐'),
    picker,
  );
  document.body.prepend(header);
  return mine;
}

/* --------------------------------------------------------- page scaffold */

/* WHY THESE EXIST RATHER THAN EACH PAGE LAYING ITSELF OUT.
 *
 * The previous surfaces were a flat stack of identical cards, so nothing
 * on any page said what to look at first. These are the three levels of
 * the hierarchy -- the lede, the answer, the detail -- as functions, so a
 * page cannot accidentally render its most important number in the same
 * weight as a table caption. */

/** lede is the top of every surface: who it is for and what it answers. */
export function lede({ eyebrow, title, sub, aside = null }) {
  const head = el('div', { class: 'page-head' });
  const brow = el('div', { class: 'eyebrow' });
  if (eyebrow) brow.append(el('span', { class: 'label' }, eyebrow));
  if (aside) brow.append(aside);
  head.append(brow, el('h1', {}, title));
  if (sub) head.append(el('p', { class: 'sub' }, sub));
  return head;
}

/** kpis is the answer strip: the few numbers the page is actually about.
 *
 * Each takes a note, and the note must say what the number MEANS rather
 * than restate the label. "4 of 8 cards" under a value of 4 is noise;
 * "the other four are held by a reservation until March" is the answer. */
export function kpis(...items) {
  const strip = el('div', { class: 'kpis', 'data-tour': 'kpis' });
  for (const it of items) {
    if (!it) continue;
    strip.append(el('div', { class: `kpi ${it.kind || ''}` },
      el('div', { class: 'label' }, it.label),
      el('div', { class: 'v' }, String(it.value),
        it.unit ? el('span', { class: 'unit' }, it.unit) : null),
      it.note ? el('div', { class: 'n' }, it.note) : null));
  }
  return strip;
}

/** section groups related detail under a heading and one line of why. */
export function section(title, why, ...children) {
  const s = el('section', { class: 'section' });
  const head = el('header', {}, el('h2', {}, title));
  if (why) head.append(el('p', { class: 'why' }, why));
  s.append(head, ...children.filter(Boolean));
  return s;
}

/** callout is for a judgement rather than a reading: a limitation, a
 *  refusal, a design decision somebody should disagree with knowingly. */
export function callout(kind, title, ...body) {
  const icons = { warn: '!', bad: '✕', ok: '✓', policy: '§', brand: 'i', '': 'i' };
  return el('div', { class: `callout ${kind}` },
    el('span', { class: 'ic', 'aria-hidden': 'true' }, icons[kind] ?? 'i'),
    el('div', {},
      title ? el('strong', {}, title) : null,
      ...body.map((b) => (typeof b === 'string' ? el('span', {}, b) : b))));
}

/** hint wraps a term with a hover explanation. The product is full of
 *  words a reader has no reason to know -- vNPU, PodGroup, device-second
 *  -- and a glossary nobody opens is not an answer. */
export function hint(text, explanation) {
  return el('span', { class: 'hint', tabindex: '0' },
    text, el('span', { class: 'hint-body' }, explanation));
}

/** flow draws a sequence with the current position marked. */
export function flow(steps) {
  const f = el('div', { class: 'flow' });
  steps.forEach((s, i) => {
    f.append(el('div', { class: `step ${s.state || ''}` },
      el('div', { class: 'n' }, String(i + 1).padStart(2, '0')),
      el('div', { class: 't' }, s.title),
      el('div', { class: 'd' }, s.detail)));
  });
  return f;
}

/** readiness states how real a capability is, next to the claim.
 *
 *  Carried on the page rather than in a document, because a roadmap in a
 *  README can say anything and a row beside the feature cannot. */
export function readiness(rows) {
  const list = el('div', { class: 'ready-list' });
  for (const r of rows) {
    list.append(el('div', { class: 'ready' },
      el('div', {}, pill(r.state, r.kind)),
      el('div', {}, el('div', { class: 't' }, r.title), el('div', { class: 'd' }, r.detail))));
  }
  return list;
}

export function pageTitle(title, subtitle) {
  return el('div', { class: 'page-head' },
    el('h1', {}, title),
    subtitle ? el('p', { class: 'sub' }, subtitle) : null);
}
