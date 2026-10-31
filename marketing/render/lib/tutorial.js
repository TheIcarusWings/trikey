// Setup tutorials (needs stage.js and tutorial.css). A tutorial page calls tutorial({...}) and gets back update(t).
//   series:   'Setup · 1 of 6'            the header and title card kicker
//   title:    'Install the guardian on Umbrel'
//   address:  t => 'umbrel.local'          the window's address bar text at time t
//   scenes:   [{a, b, el, tag?}]           what fills the window: an element in page coordinates (1280×800);
//                                          tag: true marks it as an illustration in the address bar
//   cursor:   [{t, x, y, click?}]          cursor keyframes in page coordinates (null x hides it)
//   zoom:     [{t, s, x, y}]               window zoom keyframes: scale s around page point (x, y), eased between
//   steps:    [{a, b, n, title, html, notes: [{a, b, html, tip?, y}]}]
//   chapters: [{a, label}]                 the bottom bar; each chapter runs until the next one starts
//   intro:    [a, b], outro: { at, next }  title and end cards
// The end card's status line lives here, so all tutorials change together.
const STATUS = 'Pre-alpha · not audited';

function tutorial({ series, title, address, scenes, cursor = [], zoom = [], steps, chapters, intro, outro }) {
  const stage = h('div', { id: 'stage', class: 'tut' });
  document.body.append(stage);
  stage.append(h('div', { class: 't-head' }, `${LOGO('#09090B', '#EA580C')}<b>Trikey</b><span>${series} · ${title}</span>`));

  const win = h('div', { class: 't-win' }, `<div class="t-bar"><i></i><i></i><i></i><span class="addr"></span><span class="tag">Illustration</span></div>
    <div class="t-view"><div class="t-page"></div></div>`);
  stage.append(win);
  const page = $('.t-page', win), addr = $('.addr', win), tag = $('.tag', win);
  for (const s of scenes) { s.el.classList.add('t-layer'); page.append(s.el); }
  const cur = h('div', { class: 't-cursor' }, `<svg viewBox="0 0 24 30"><path d="M2 2 L2 24 L8 18.5 L12 28 L16 26.3 L12 17 L20 17 Z" fill="#09090B" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`);
  const rip = h('div', { class: 't-ripple' });
  page.append(rip, cur);

  const panel = h('div', { class: 't-panel' });
  stage.append(panel);
  const S = steps.map(s => {
    const el = h('div', { class: 't-step' }, `<span class="n">${s.n}</span><h2>${s.title}</h2>${s.html}`);
    const notes = (s.notes || []).map(n => {
      const ne = h('div', { class: 't-note' + (n.tip ? ' tip' : '') }, n.html);
      ne.style.top = n.y + 'px';
      el.append(ne);
      return { ...n, el: ne };
    });
    panel.append(el);
    return { ...s, el, notes };
  });

  const bar = h('div', { class: 't-chapters' });
  stage.append(bar);
  const C = chapters.map((c, i) => {
    const el = h('div', {}, `<span></span>${c.label}`);
    bar.append(el);
    return { ...c, b: (chapters[i + 1] || { a: outro.at }).a, el };
  });

  const card0 = h('div', { class: 't-card' }, `${LOGO('#09090B', '#EA580C')}<div class="kicker">${series}</div><h1>${title}</h1>`);
  const card1 = h('div', { class: 't-card' }, `${LOGO('#09090B', '#EA580C')}<div class="kicker">Next</div><h1>${outro.next}</h1>
    <div class="meta"><span class="pill"><b></b>${STATUS}</span><span class="site">trikey.app</span></div>`);
  stage.append(card0, card1);

  return t => {
    for (const s of scenes) show(s.el, t, s.a, s.b, { dy: 0, fi: 0.35, fo: 0.35 });
    const live = scenes.filter(s => t >= s.a && t <= s.b);
    addr.textContent = address(t);
    tag.style.opacity = live.some(s => s.tag) ? 1 : 0;

    // Cursor: eased moves between keyframes, a ripple on each click.
    let k = cursor.findIndex(c => c.t > t);
    if (k === -1) k = cursor.length;
    const p0 = cursor[k - 1], p1 = cursor[k];
    if (p0 && p0.x != null) {
      let x = p0.x, y = p0.y;
      if (p1 && p1.x != null) {
        const span = Math.min(0.7, p1.t - p0.t), e = easeIO(clamp((t - (p1.t - span)) / span));
        x = lerp(p0.x, p1.x, e); y = lerp(p0.y, p1.y, e);
      }
      cur.style.opacity = 1;
      cur.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    } else cur.style.opacity = 0;
    const click = [...cursor].reverse().find(c => c.click && c.t <= t && t - c.t < 0.6);
    if (click) {
      const e = (t - click.t) / 0.6;
      rip.style.left = click.x + 'px'; rip.style.top = click.y + 'px';
      rip.style.opacity = 1 - e; rip.style.transform = `scale(${0.5 + e})`;
    } else rip.style.opacity = 0;

    // Zoom: the view scales around a page point, eased from keyframe to keyframe.
    let z = zoom.findIndex(q => q.t > t);
    if (z === -1) z = zoom.length;
    const q0 = zoom[z - 1] || { s: 1, x: 640, y: 400 }, q1 = zoom[z];
    let zs = q0.s, zx = q0.x, zy = q0.y;
    if (q1) {
      const span = Math.min(0.9, q1.t - (q0.t || 0)), e = easeIO(clamp((t - (q1.t - span)) / span));
      zs = lerp(q0.s, q1.s, e); zx = lerp(q0.x, q1.x, e); zy = lerp(q0.y, q1.y, e);
    }
    const base = 0.95, s = base * zs;
    const tx = clamp(608 - zx * s, 1216 - 1280 * s, 0), ty = clamp(380 - zy * s, 760 - 800 * s, 0);
    page.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;

    for (const s of S) {
      show(s.el, t, s.a, s.b, { dy: 16, fi: 0.4, fo: 0.3 });
      for (const n of s.notes) show(n.el, t, n.a, n.b ?? s.b, { dy: 12, fi: 0.4, fo: 0.3 });
    }
    for (const c of C) {
      const on = t >= c.a && t < c.b;
      c.el.classList.toggle('on', on);
      $('span', c.el).style.width = `${100 * clamp((t - c.a) / (c.b - c.a))}%`;
    }
    show(card0, t, intro[0], intro[1], { dy: 0, fi: 0, fo: 0.5 });
    card0.querySelectorAll(':scope > *').forEach((c, i) => show(c, t, intro[0] + 0.2 + i * 0.2, intro[1], { dy: 16, fi: 0.5, fo: 0.4 }));
    show(card1, t, outro.at, 1e9, { dy: 0, fi: 0.6 });
    card1.querySelectorAll(':scope > *').forEach((c, i) => show(c, t, outro.at + 0.3 + i * 0.25, 1e9, { dy: 16, fi: 0.5 }));
  };
}

// Footage recorded by render/capture/guardian.js: shows the newest frame at or before t - a.
// TL is the shot's timeline ({frames: [{t, f}], cursor}); dir is where its PNGs are.
function recorded(dir, TL) {
  const el = h('div', {}, '<img>');
  const img = $('img', el);
  el.at = local => {
    let f = TL.frames[0];
    for (const fr of TL.frames) if (fr.t <= local) f = fr;
    const src = `${dir}/${f.f}`;
    if (img.dataset.src !== src) { img.dataset.src = src; img.src = src; pending.push(img.decode().catch(() => {})); }
  };
  return el;
}
// The shot's cursor keyframes, shifted to start at a (both the footage and the cursor live in page coordinates).
const shiftCursor = (TL, a) => TL.cursor.map(c => ({ ...c, t: c.t + a }));
