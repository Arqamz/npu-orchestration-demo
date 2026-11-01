/* The guided walkthrough.
 *
 * WHY THIS EXISTS AT ALL
 *
 * These are dense operations screens. However well one is laid out, it
 * cannot explain itself to somebody who does not yet know what the
 * product is -- and the people these pages are shown to are exactly
 * those people. A reader who opens a link and sees eleven panels of
 * numbers learns nothing about what the platform does.
 *
 * So the first visit to each surface is walked through it: a spotlight
 * on one thing at a time, with a sentence about what it is and why it
 * is there. After that the page is just the page, and the button to
 * replay the tour never goes away.
 *
 * WHAT IT IS NOT
 *
 * Not a product tour in the marketing sense, and deliberately not a list
 * of features. Every step points at something real on the page and says
 * what it means, which is the only kind of tour that survives the
 * underlying thing changing.
 *
 * THE SPOTLIGHT IS FOUR RECTANGLES, NOT ONE WITH A HOLE
 *
 * The common implementation is a single overlay with an enormous
 * box-shadow spread, which dims the "spotlit" element along with
 * everything else -- so the thing being pointed at is the hardest thing
 * on the page to read. Four panels around the target leave a true hole.
 */

const SEEN_PREFIX = 'ascend-tour-seen:';
const PAD = 8;

/* Browser storage is a convenience here and never a requirement: in a
 * private window, with site data blocked, or during a thumbnail capture,
 * these throw or come back empty. The tour simply offers itself again,
 * which is a far better failure than a page that will not render. */
function seen(id) {
  try { return localStorage.getItem(SEEN_PREFIX + id) === '1'; } catch { return false; }
}
function markSeen(id) {
  try { localStorage.setItem(SEEN_PREFIX + id, '1'); } catch { /* not important enough to fail over */ }
}

function elm(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export class Tour {
  /** steps: [{ target: selector|null, title, body: [paragraphs] }] */
  constructor(id, steps) {
    this.id = id;
    this.steps = steps.filter(Boolean);
    this.i = 0;
    this.nodes = null;
    this.onKey = this.onKey.bind(this);
    this.reposition = this.reposition.bind(this);
  }

  /** Offer runs the tour only on a first visit.
   *
   * ?notour suppresses it. Needed for screenshots and thumbnail capture,
   * where the backdrop dims the whole page and the resulting image shows
   * the tour rather than the product -- which is exactly what happened
   * the first time these were captured.
   */
  offer() {
    if (new URLSearchParams(location.search).has('notour')) return;
    if (!seen(this.id) && this.steps.length) {
      // One frame, so the page has laid out and a target's rectangle is
      // real rather than zero.
      requestAnimationFrame(() => requestAnimationFrame(() => this.start()));
    }
  }

  start() {
    if (this.nodes) return;
    this.i = 0;
    const n = {
      t: elm('div', 'tour-backdrop'), b: elm('div', 'tour-backdrop'),
      l: elm('div', 'tour-backdrop'), r: elm('div', 'tour-backdrop'),
      ring: elm('div', 'tour-ring'), pop: elm('div', 'tour-pop'),
    };
    n.pop.setAttribute('role', 'dialog');
    n.pop.setAttribute('aria-modal', 'true');
    this.nodes = n;
    for (const k of ['t', 'b', 'l', 'r', 'ring', 'pop']) document.body.append(n[k]);
    for (const k of ['t', 'b', 'l', 'r']) n[k].addEventListener('click', () => this.end());
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.reposition);
    window.addEventListener('scroll', this.reposition, { passive: true });
    this.render();
  }

  onKey(e) {
    if (e.key === 'Escape') this.end();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') this.next();
    else if (e.key === 'ArrowLeft') this.back();
  }

  next() { if (this.i < this.steps.length - 1) { this.i += 1; this.render(); } else this.end(); }
  back() { if (this.i > 0) { this.i -= 1; this.render(); } }

  end() {
    if (!this.nodes) return;
    for (const k of ['t', 'b', 'l', 'r', 'ring', 'pop']) this.nodes[k].remove();
    this.nodes = null;
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.reposition);
    window.removeEventListener('scroll', this.reposition);
    markSeen(this.id);
  }

  render() {
    const step = this.steps[this.i];
    const { pop } = this.nodes;
    pop.replaceChildren();
    pop.append(elm('h3', null, step.title));
    for (const para of step.body) pop.append(elm('p', null, para));

    const foot = elm('div', 'tour-foot');
    const dots = elm('div', 'tour-dots');
    this.steps.forEach((_, j) => {
      const d = elm('i', j === this.i ? 'on' : '');
      dots.append(d);
    });
    foot.append(dots);

    if (this.i > 0) {
      const b = elm('button', 'link', 'Back');
      b.onclick = () => this.back();
      foot.append(b);
    }
    const skip = elm('button', 'link', this.i === this.steps.length - 1 ? '' : 'Skip');
    if (skip.textContent) { skip.onclick = () => this.end(); foot.append(skip); }
    const nx = elm('button', 'primary',
      this.i === this.steps.length - 1 ? 'Done' : 'Next');
    nx.onclick = () => this.next();
    foot.append(nx);
    pop.append(foot);

    const target = step.target ? document.querySelector(step.target) : null;
    if (target) {
      const r = target.getBoundingClientRect();
      // Scroll it into view only when it is actually off screen: nudging
      // the page on every step makes the tour feel like it is fighting
      // the reader.
      if (r.top < 70 || r.bottom > window.innerHeight - 40) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => this.reposition(), 320);
      }
    }
    this.reposition();
    nx.focus();
  }

  reposition() {
    if (!this.nodes) return;
    const step = this.steps[this.i];
    const n = this.nodes;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const target = step.target ? document.querySelector(step.target) : null;

    if (!target) {
      // A step with no target, or whose target is not on this page --
      // which happens whenever a surface renders conditionally, as every
      // one of these does for a persona without the grant. The tour
      // centres itself and carries on rather than breaking.
      n.ring.style.cssText = 'display:none';
      n.t.style.cssText = `inset:0;width:${vw}px;height:${vh}px`;
      for (const k of ['b', 'l', 'r']) n[k].style.cssText = 'display:none';
      n.pop.style.left = `${Math.max(16, vw / 2 - 195)}px`;
      n.pop.style.top = `${Math.max(16, vh / 2 - n.pop.offsetHeight / 2)}px`;
      return;
    }

    const r = target.getBoundingClientRect();
    const x = Math.max(0, r.left - PAD);
    const y = Math.max(0, r.top - PAD);
    const w = Math.min(vw - x, r.width + PAD * 2);
    const h = Math.min(vh - y, r.height + PAD * 2);

    n.ring.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    n.t.style.cssText = `left:0;top:0;width:${vw}px;height:${y}px`;
    n.b.style.cssText = `left:0;top:${y + h}px;width:${vw}px;height:${Math.max(0, vh - y - h)}px`;
    n.l.style.cssText = `left:0;top:${y}px;width:${x}px;height:${h}px`;
    n.r.style.cssText = `left:${x + w}px;top:${y}px;width:${Math.max(0, vw - x - w)}px;height:${h}px`;

    // Prefer below, fall back above, then clamp into the viewport. The
    // clamp is what stops the popover leaving the screen for a target
    // near an edge, which is most of them on a phone.
    const ph = n.pop.offsetHeight || 200;
    const pw = n.pop.offsetWidth || 390;
    let top = y + h + 14;
    if (top + ph > vh - 12) top = y - ph - 14;
    if (top < 12) top = Math.max(12, Math.min(vh - ph - 12, y));
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(16, Math.min(vw - pw - 16, left));
    n.pop.style.top = `${top}px`;
    n.pop.style.left = `${left}px`;
  }
}

/** launcher returns the always-available replay button. */
export function launcher(tour, label = 'Show me around') {
  const b = document.createElement('button');
  b.className = 'tour-launch';
  b.type = 'button';
  b.textContent = label;
  b.onclick = () => tour.start();
  return b;
}
