(function () {
  var pref = 'system';
  try {
    var saved = localStorage.getItem('trikey-guardian-theme');
    if (saved === 'light' || saved === 'dark') pref = saved;
  } catch (e) {
    /* storage can be blocked; fall back to the system preference */
  }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
