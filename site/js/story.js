// Trikey site: scroll-driven film scenes.
//
// Each [data-pin] section becomes a tall scroll track with a sticky stage.
// As the track scrolls past, the section gets --p (0..1), every element with
// data-from/data-to inside it gets the class "on" while --p is in its range,
// and --q (0..1, progress within that range). A video with data-scrub follows
// the progress of its shot instead of playing.
//
// Without this script, or with reduced motion, nothing here runs and the
// scenes stay a plain stack of cards. No network requests, no storage.
(function () {
  'use strict';

  if (!window.matchMedia || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;

  document.documentElement.classList.add('story');

  function clamp(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  function init() {
    var pins = Array.prototype.map.call(document.querySelectorAll('[data-pin]'), function (el) {
      el.style.setProperty('--len', el.getAttribute('data-pin'));
      var parts = Array.prototype.map.call(el.querySelectorAll('[data-from]'), function (part) {
        return {
          el: part,
          from: parseFloat(part.getAttribute('data-from')),
          to: parseFloat(part.getAttribute('data-to') || '1'),
          on: null,
          video: part.querySelector('video[data-scrub]'),
        };
      });
      parts.forEach(function (part) {
        if (!part.video) return;
        part.video.preload = 'auto';
        part.video.load();
      });
      return { el: el, parts: parts, visible: false };
    });
    if (!pins.length) return;

    var queued = false;

    function update() {
      queued = false;
      var vh = window.innerHeight;
      pins.forEach(function (pin) {
        if (!pin.visible) return;
        var box = pin.el.getBoundingClientRect();
        var track = box.height - vh;
        var p = track > 0 ? clamp(-box.top / track) : 0;
        pin.el.style.setProperty('--p', p.toFixed(4));
        pin.parts.forEach(function (part) {
          var on = p >= part.from && (p < part.to || part.to >= 1);
          if (on !== part.on) {
            part.on = on;
            part.el.classList.toggle('on', on);
          }
          var q = clamp((p - part.from) / (part.to - part.from));
          part.el.style.setProperty('--q', q.toFixed(4));
          var v = part.video;
          if (v && v.duration && !v.seeking) {
            var t = q * (v.duration - 0.05);
            if (Math.abs(v.currentTime - t) > 0.03) v.currentTime = t;
          }
        });
      });
    }

    function queue() {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        pins.forEach(function (pin) {
          if (pin.el === entry.target) pin.visible = entry.isIntersecting;
        });
      });
      queue();
    }, { rootMargin: '200px 0px' });
    pins.forEach(function (pin) {
      io.observe(pin.el);
    });

    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    queue();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
