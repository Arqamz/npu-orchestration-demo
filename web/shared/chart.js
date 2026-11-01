/* Time-series panels for the recorded autoscaling run.
 *
 * TWO PANELS, ONE X AXIS -- not one chart with two y scales.
 *
 * The first version plotted replica count and in-flight request count on
 * the same axes with separate scales, which is the dual-axis chart: the
 * crossing point between the two lines is an artifact of how each was
 * scaled, so a reader draws a causal conclusion ("replicas crossed demand
 * here") from a coincidence of arithmetic. Stacking two panels on a shared
 * time axis says the true thing -- load rises, replicas follow -- without
 * inviting that reading.
 *
 * Colours are slots 1 and 3 of the validated categorical palette, which
 * clear the CVD floor in both modes. The pair that was here before
 * (amber against green) failed at ΔE 5.1 for protanopia: a colourblind
 * viewer could not tell "replicas serving" from "requests in flight".
 */

const PALETTE = {
  dark: { s1: '#3987e5', s2: '#199e70', load: '#d95926', threshold: '#e66767' },
  light: { s1: '#2a78d6', s2: '#1baf7a', load: '#eb6834', threshold: '#e34948' },
};

function mode() {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'light') return 'light';
  if (explicit === 'dark') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function ink() {
  const css = getComputedStyle(document.body);
  return {
    line: css.getPropertyValue('--line').trim() || '#262c38',
    faint: css.getPropertyValue('--ink-faint').trim() || '#6b7489',
    dim: css.getPropertyValue('--ink-dim').trim() || '#9aa4b5',
    primary: css.getPropertyValue('--ink').trim() || '#e6e9ef',
    surface: css.getPropertyValue('--panel').trim() || '#161a22',
  };
}

/** AutoscaleChart renders the run and supports a playhead.
 *
 *  series: [{offset, replicas, readyReplicas, quotaCeiling, observedMetric}]
 */
export class AutoscaleChart {
  constructor(host, series, { target = 16 } = {}) {
    this.host = host;
    this.series = series;
    this.target = target;
    this.upto = Infinity;
    this.hover = null;

    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.display = 'block';
    this.canvas.setAttribute('role', 'img');
    host.append(this.canvas);

    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    host.style.position = 'relative';
    host.append(this.tip);

    // An HTML chart IS interactive; a crosshair and a tooltip are the
    // default, not an enhancement.
    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.tip.hidden = true;
      this.draw();
    });
    window.addEventListener('resize', () => this.draw());
  }

  setPlayhead(upto) {
    this.upto = upto;
    this.draw();
  }

  /** The accessible fallback: identity is never colour alone. */
  tableRows() {
    return this.series.map((f) => [
      `t+${f.offset}s`, f.replicas, f.readyReplicas, f.quotaCeiling,
      f.observedMetric.toFixed(0),
    ]);
  }

  draw() {
    const s = this.series;
    if (!s.length) return;

    const C = PALETTE[mode()];
    const I = ink();
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 760;
    const hTop = 170;
    const hBot = 110;
    const gap = 26;
    const h = hTop + gap + hBot;

    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.height = `${h}px`;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 42;
    const padR = 118; // room for direct labels
    const maxOff = s[s.length - 1].offset || 1;
    const maxRep = Math.max(4, ...s.map((f) => Math.max(f.replicas, f.quotaCeiling))) + 0.6;
    const maxLoad = Math.max(1, ...s.map((f) => f.observedMetric)) * 1.15;

    const X = (o) => padL + (o / maxOff) * (w - padL - padR);
    const Y1 = (v) => hTop - 14 - (v / maxRep) * (hTop - 28);
    const Y2 = (v) => hTop + gap + hBot - 20 - (v / maxLoad) * (hBot - 32);

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    // ---- recessive grid -------------------------------------------------
    ctx.strokeStyle = I.line;
    ctx.lineWidth = 1;
    ctx.fillStyle = I.faint;
    ctx.textAlign = 'right';
    for (let r = 0; r <= Math.floor(maxRep); r += 1) {
      const y = Math.round(Y1(r)) + 0.5;
      ctx.globalAlpha = 0.3;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(String(r), padL - 7, Y1(r));
    }
    for (const v of [0, Math.round(maxLoad / 1.15)]) {
      const y = Math.round(Y2(v)) + 0.5;
      ctx.globalAlpha = 0.3;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(String(v), padL - 7, Y2(v));
    }

    ctx.textAlign = 'center';
    for (let o = 0; o <= maxOff; o += 60) {
      ctx.fillText(`${o}s`, X(o), h - 7);
    }

    // panel captions, in text ink rather than series colour
    ctx.textAlign = 'left';
    ctx.fillStyle = I.dim;
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.fillText('NPUs HELD', padL, 10);
    ctx.fillText('REQUESTS IN FLIGHT', padL, hTop + gap - 4);
    ctx.font = '10px ui-monospace, monospace';

    const visible = s.filter((f) => f.offset <= this.upto);
    if (!visible.length) return;

    const step = (pts, color, width, dashed) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      pts.forEach(([px, py], i) => {
        if (i === 0) ctx.moveTo(px, py);
        else { ctx.lineTo(px, pts[i - 1][1]); ctx.lineTo(px, py); }
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // ---- panel 1: capacity ---------------------------------------------
    // The ceiling is a threshold, not a series: status colour, dashed,
    // labelled. It is the number the autoscaler is not allowed to cross.
    step(visible.map((f) => [X(f.offset), Y1(f.quotaCeiling)]), C.threshold, 1.5, true);
    step(visible.map((f) => [X(f.offset), Y1(f.replicas)]), C.s1, 2, false);
    step(visible.map((f) => [X(f.offset), Y1(f.readyReplicas)]), C.s2, 2, false);

    // ---- panel 2: load --------------------------------------------------
    ctx.strokeStyle = C.load;
    ctx.lineWidth = 2;
    ctx.beginPath();
    visible.forEach((f, i) => {
      const px = X(f.offset); const py = Y2(f.observedMetric);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // ---- direct labels --------------------------------------------------
    // Relief for the light-mode contrast warning, and the reason no legend
    // box is needed on the lower panel.
    const last = visible[visible.length - 1];
    const label = (text, y, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(w - padR + 6, y - 1, 10, 2);
      ctx.fillStyle = I.primary;
      ctx.textAlign = 'left';
      ctx.fillText(text, w - padR + 20, y);
    };
    label(`held ${last.replicas}`, Y1(last.replicas), C.s1);
    if (Math.abs(Y1(last.readyReplicas) - Y1(last.replicas)) < 11) {
      label(`serving ${last.readyReplicas}`, Y1(last.readyReplicas) + 12, C.s2);
    } else {
      label(`serving ${last.readyReplicas}`, Y1(last.readyReplicas), C.s2);
    }
    label(`ceiling ${last.quotaCeiling}`, Y1(last.quotaCeiling) - 12, C.threshold);
    label(`${last.observedMetric.toFixed(0)} in flight`, Y2(last.observedMetric), C.load);

    // ---- playhead and hover --------------------------------------------
    if (this.upto !== Infinity && this.upto <= maxOff) {
      ctx.strokeStyle = I.dim;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(X(this.upto)) + 0.5, 4);
      ctx.lineTo(Math.round(X(this.upto)) + 0.5, h - 18);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (this.hover && this.hover.x >= padL && this.hover.x <= w - padR) {
      const offset = ((this.hover.x - padL) / (w - padL - padR)) * maxOff;
      let near = visible[0];
      for (const f of visible) {
        if (Math.abs(f.offset - offset) < Math.abs(near.offset - offset)) near = f;
      }
      const hx = Math.round(X(near.offset)) + 0.5;
      ctx.strokeStyle = I.faint;
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(hx, 4); ctx.lineTo(hx, h - 18); ctx.stroke();
      ctx.globalAlpha = 1;

      // 2px surface ring so the marker reads above the line it sits on
      for (const [y, color] of [
        [Y1(near.replicas), C.s1], [Y1(near.readyReplicas), C.s2],
        [Y2(near.observedMetric), C.load],
      ]) {
        ctx.beginPath(); ctx.arc(hx, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = I.surface; ctx.fill();
        ctx.beginPath(); ctx.arc(hx, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
      }

      this.tip.hidden = false;
      this.tip.innerHTML = `<strong>t+${near.offset}s</strong>`
        + `<span><i style="background:${C.s1}"></i>NPUs held <b>${near.replicas}</b></span>`
        + `<span><i style="background:${C.s2}"></i>serving <b>${near.readyReplicas}</b></span>`
        + `<span><i style="background:${C.threshold}"></i>quota ceiling <b>${near.quotaCeiling}</b></span>`
        + `<span><i style="background:${C.load}"></i>in flight <b>${near.observedMetric.toFixed(0)}</b></span>`;
      const left = Math.min(Math.max(hx + 12, 8), w - 210);
      this.tip.style.left = `${left}px`;
      this.tip.style.top = `8px`;
    }

    this.canvas.setAttribute('aria-label',
      `Autoscaling run. NPUs held rises from ${s[0].replicas} to `
      + `${Math.max(...s.map((f) => f.replicas))} and returns to `
      + `${s[s.length - 1].replicas}, never exceeding the quota ceiling of `
      + `${s[0].quotaCeiling}. Requests in flight peak at `
      + `${Math.max(...s.map((f) => f.observedMetric)).toFixed(0)}.`);
  }
}
