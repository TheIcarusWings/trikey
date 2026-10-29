// Renders design/screens/*.dc.html mockups to PNGs with light or dark tokens.
// Usage: node screens.js <outDir> <theme> <Screen> [<Screen>...]
// App screens: crops the iOS phone. Guardian-* screens: the top 1280×760 of the page.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SCREENS = path.resolve(__dirname, '../../../design/screens');

function substitute(html, theme) {
  const m = html.match(new RegExp('const ' + theme + ' = (\\{[^;]*\\});'));
  if (!m) throw new Error('no ' + theme + ' tokens');
  const t = JSON.parse(m[1].replace(/(\w+):/g, '"$1":'));
  return html
    .replace(/\{\{t\.(\w+)\}\}/g, (_, k) => t[k])
    .replace(/<script[^>]*support\.js[^>]*><\/script>/, '')
    .replace(/<script type="text\/x-dc"[\s\S]*?<\/script>/, '')
    .replace(/<\/?(x-dc|helmet)>/g, '');
}

(async () => {
  const [outDir, theme, ...names] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  for (const name of names) {
    const html = substitute(fs.readFileSync(path.join(SCREENS, name + '.dc.html'), 'utf8'), theme);
    const guardian = name.startsWith('Guardian-');
    const page = await browser.newPage({ viewport: { width: guardian ? 1280 : 980, height: guardian ? 760 : 1064 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(outDir, `${name}-${theme}.png`);
    if (guardian) {
      await page.screenshot({ path: out });
    } else {
      // The iOS phone is the first rounded 390-wide frame.
      const box = await page.evaluate(() => {
        const el = [...document.querySelectorAll('div')].find(d => d.style.width === '390px');
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      await page.screenshot({ path: out, clip: box, omitBackground: true });
    }
    console.log(out);
    await page.close();
  }
  await browser.close();
})();
