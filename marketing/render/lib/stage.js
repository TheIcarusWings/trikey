// Shared timeline helpers. A video page defines SPEC and update(t); the renderer
// calls window.seek(t) for every frame, so all motion is a pure function of t.
const P = new URLSearchParams(location.search);
const R = P.get('r') || '916';
document.documentElement.dataset.r = R;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = x => 1 - Math.pow(1 - x, 3);
const easeIO = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const prog = (t, a, b, f = ease) => f(clamp((t - a) / (b - a)));
const lerp = (a, b, p) => a + (b - a) * p;

// Visibility envelope: 0 outside [a, b], eased in over fi seconds and out over fo.
function env(t, a, b, fi = 0.45, fo = 0.35) {
  if (t < a || t > b) return 0;
  return Math.min(fi <= 0 ? 1 : ease(clamp((t - a) / fi)), fo <= 0 ? 1 : ease(clamp((b - t) / fo)));
}

// Show el inside [a, b] with a fade and a small rise.
function show(el, t, a, b, { dy = 28, fi, fo, scale = 0 } = {}) {
  const e = env(t, a, b, fi, fo);
  el.style.opacity = e;
  el.style.visibility = e > 0 ? 'visible' : 'hidden';
  el.style.transform = `translateY(${(1 - e) * dy}px) scale(${1 - scale * (1 - e)})`;
  return e;
}

const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs = {}, html = '') {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.innerHTML = html;
  return el;
}

const LOGO = (ink = 'var(--ink)', brand = 'var(--brand)') =>
  `<svg viewBox="0 0 88 80" aria-hidden="true"><path d="M44 14 L16 62 L72 62 Z" fill="none" stroke="${ink}" stroke-width="6" stroke-linejoin="round"/><circle cx="44" cy="14" r="12" fill="${brand}"/><circle cx="16" cy="62" r="12" fill="${ink}"/><circle cx="72" cy="62" r="12" fill="${ink}"/></svg>`;

// Builds the common scaffolding: stage, captions, visual area, corner mark, end card.
function scaffold() {
  const stage = h('div', { id: 'stage' });
  stage.append(
    h('div', { class: 'caps' }),
    h('div', { class: 'vis' }),
    h('div', { class: 'mark' }, LOGO() + '<span>Trikey</span>'),
    h('div', { class: 'end' },
      `<div class="logo">${LOGO()}</div>
       <div class="name">Trikey</div>
       <div class="tag">Three keys. No company.</div>
       <div class="status"><b></b>Pre-alpha · not audited · testnet only</div>
       <div class="site">trikey.app</div>
       <div class="url mono">github.com/TheIcarusWings/trikey</div>`)
  );
  document.body.append(stage);
  return stage;
}

// Captions: [{a, b, main, sub}] → elements; showCaps(t) fades the active one.
function captions(list) {
  const box = $('.caps');
  return list.map(c => {
    const el = h('div', { class: c.side ? 'cap side' : 'cap' }, `<div class="main">${c.main}</div>` + (c.sub ? `<div class="sub">${c.sub}</div>` : ''));
    box.append(el);
    return { ...c, el };
  });
}
function showCaps(caps, t) {
  for (const c of caps) show(c.el, t, c.a, c.b, { fi: c.a === 0 ? 0 : 0.4, fo: 0.3, dy: 22 });
}

function layer(html, cls = '') {
  const el = h('div', { class: ('layer ' + cls).trim() }, html);
  $('.vis').append(el);
  return el;
}
function phone(src, overlays = '') {
  return `<div class="phone"><img src="${src}">${overlays}</div>`;
}

// B-roll from extracted JPEG frames: build/broll/<name>/0001.jpg … at 30 fps.
function broll(name) {
  const el = h('div', { class: 'broll' }, `<img><div class="shade"></div>`);
  $('#stage').append(el);
  el.name = name;
  return el;
}
const pending = [];
function setBroll(el, t, a, b, frames) {
  const e = show(el, t, a, b, { dy: 0, fi: a === 0 ? 0 : 0.3, fo: 0.4 });
  if (e > 0) {
    const i = Math.min(frames, Math.max(1, Math.floor((t - a) * 30) + 1));
    const src = `../../build/broll/${el.name}/${String(i).padStart(4, '0')}.jpg`;
    const img = el.querySelector('img');
    if (!img.src.endsWith(src.slice(5))) { img.src = src; pending.push(img.decode().catch(() => {})); }
  }
}

// Full-bleed footage from extracted frames: build/clips/<name>-<916|169>/0001.jpg … at 30 fps.
// 9:16 uses the vertical take; 1:1 and 16:9 crop the horizontal one.
function clip(name, parent = $('#stage')) {
  const el = h('div', { class: 'clip' }, '<img>');
  el.dir_ = `../../build/clips/${name}-${R === '916' ? '916' : '169'}`;
  parent.append(el);
  return el;
}
function setClip(el, t, a, b, { from = 0, speed = 1, fi = 0.25, fo = 0.25, frames = 90 } = {}) {
  const e = show(el, t, a, b, { dy: 0, fi, fo });
  if (e > 0) {
    const i = Math.min(frames, Math.max(1, Math.floor((from + (t - a) * speed) * 30) + 1));
    const src = `${el.dir_}/${String(i).padStart(4, '0')}.jpg`;
    const img = el.querySelector('img');
    if (img.dataset.src !== src) { img.dataset.src = src; img.src = src; pending.push(img.decode().catch(() => {})); }
  }
  return e;
}

function endCard(t, a) {
  show($('.end'), t, a, 1e9, { dy: 0, fi: 0.5 });
  const e = $('.end');
  e.querySelectorAll(':scope > *').forEach((c, i) => show(c, t, a + 0.15 + i * 0.12, 1e9, { dy: 20, fi: 0.5 }));
}

// SPEC.retime: [[authoredTime, outputTime], …] stretches each beat to fit its voiceover line.
function remap(t) {
  const R = window.SPEC.retime;
  if (!R) return t;
  for (let i = 1; i < R.length; i++) {
    const [o0, n0] = R[i - 1], [o1, n1] = R[i];
    if (t <= n1) return o0 + ((t - n0) * (o1 - o0)) / (n1 - n0);
  }
  const [o, n] = R[R.length - 1];
  return o + (t - n);
}

window.seek = async t => {
  window.update(remap(t));
  await Promise.all(pending.splice(0));
};
window.ready = async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
};
