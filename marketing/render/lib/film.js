// Builds an episode film from data (needs stage.js and film.css):
//   shots:   [start, end, clip slot, frames, from (s), speed]
//   inserts: [start, end, screen, tap?]  app screens show as a phone, Guardian-* in a browser window;
//            tap = [x %, y %, at (s)] draws a tap ripple on the phone
//   supers:  [start, end, text]
//   counter: [start, end] optional "Day 1 … Day 7" counter over the footage
//   end:     { at, line } light end card with the logo
// Returns update(t) for window.update.
function episode({ shots, inserts = [], supers, counter, end }) {
  const stage = h('div', { id: 'stage' });
  document.body.append(stage);

  const S = shots.map(([a, b, name, frames, from = 0, speed = 1]) => ({ a, b, frames, from, speed, el: clip(name, stage) }));
  stage.append(h('div', { class: 'grade' }));

  const I = inserts.map(([a, b, screen, tap]) => {
    const src = `../../build/screens/${screen}-dark.png`;
    const html = screen.startsWith('Guardian-')
      ? `<div class="browser"><div class="bar"><i></i><i></i><i></i><span>umbrel.local · Trikey Guardian</span></div><img src="${src}"></div>`
      : phone(src, tap ? `<div class="tap" style="left:${tap[0]}%; top:${tap[1]}%"></div>` : '');
    const el = h('div', { class: 'ins' }, html);
    stage.append(el);
    return { a, b, tap, el };
  });

  const box = h('div', { class: 'supers' });
  stage.append(box);
  const sups = supers.map(([a, b, text]) => { const el = h('div', { class: 'sup' }, text); box.append(el); return { a, b, el }; });

  const day = counter && h('div', { class: 'day mono' });
  if (day) stage.append(day);

  const fin = h('div', { class: 'fin' }, `${LOGO('#09090B', '#EA580C')}
    <div class="line">${end.line}</div>
    <div class="small">Trikey · Three keys. No company.</div>
    <div class="meta"><span class="pill"><b></b>Coming soon · pre-alpha, not audited</span>
    <span class="site">trikey.app</span><span class="mono">github.com/TheIcarusWings/trikey</span></div>`);
  stage.append(fin);

  return t => {
    S.forEach(s => {
      setClip(s.el, t, s.a, s.b, { from: s.from, speed: s.speed, frames: s.frames, fi: s.a === 0 ? 0 : 0.3, fo: 0.3 });
      s.el.style.transform = `scale(${1.02 + 0.05 * clamp((t - s.a) / (s.b - s.a))})`;
      s.el.style.filter = '';
    });
    // Dim and soften the footage under an insert.
    for (const ins of I) {
      const e = show(ins.el, t, ins.a, ins.b, { dy: 50, fi: 0.45, fo: 0.3 });
      const s = e > 0 && S.find(s => t >= s.a && t <= s.b);
      if (s) s.el.style.filter = `brightness(${1 - 0.65 * e}) blur(${8 * e}px)`;
      if (ins.tap) {
        const tap = $('.tap', ins.el);
        tap.style.opacity = env(t, ins.tap[2], ins.tap[2] + 0.8, 0.12, 0.35);
        tap.style.transform = `translate(-50%, -50%) scale(${0.6 + 0.6 * prog(t, ins.tap[2], ins.tap[2] + 0.8)})`;
      }
    }
    if (day) {
      show(day, t, counter[0], counter[1], { dy: 0, fi: 0.3, fo: 0.3 });
      const n = Math.min(7, 1 + Math.floor(clamp((t - counter[0]) / (counter[1] - counter[0] - 0.6)) * 7));
      day.innerHTML = `<b></b>Day ${n} of 7 · recovery waiting`;
    }
    for (const s of sups) show(s.el, t, s.a, s.b, { dy: 14, fi: s.a === 0 ? 0 : 0.45, fo: 0.35 });
    show(fin, t, end.at, 1e9, { dy: 0, fi: 0.7 });
    fin.querySelectorAll(':scope > *').forEach((c, i) => show(c, t, end.at + 0.3 + i * 0.3, 1e9, { dy: 18, fi: 0.5 }));
  };
}
