// Records the guardian's web pages for the tutorials, from apps/guardian-web's mock scenarios.
// Usage (with `npx vite` running in apps/guardian-web):
//   node render/capture/guardian.js http://localhost:5174 build/tut/guardian setup locked
// Each shot is a list of steps on a 1280×800 page. The script screenshots the page whenever it changes and writes
// <outDir>/<shot>/NNNN.png plus <outDir>/<shot>/timeline.json: { duration, frames: [{t, f}], cursor: [{t, x, y, click}] }.
// Times are seconds from the start of the shot; x and y are page pixels. The video page shows the newest frame
// at or before t and draws the cursor itself.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// A fake passphrase for the recording; the fields are masked, so it never shows.
const PASS = 'linen kettle orbit maple';

const SHOTS = {
  // First run: the setup page, its relays, the passphrase, then the pairing page it opens on.
  setup: { mock: 'firstrun', steps: [
    ['hold', 3.0],
    ['type', 'input[type=password] >> nth=0', PASS],
    ['type', 'input[type=password] >> nth=1', PASS],
    ['hold', 1.5],
    ['click', 'text=Advanced: relays'],
    ['hold', 4.0],
    ['click', 'role=button[name="Set up"]'],
    ['hold', 9.0],
  ] },
  // After a restart: unlock with the passphrase, which lands on Home.
  locked: { mock: 'locked', steps: [
    ['hold', 6.0],
    ['type', 'input[type=password] >> nth=0', PASS],
    ['click', 'role=button[name="Unlock"]'],
    ['hold', 5.0],
  ] },
};

const MOVE = 0.7;      // seconds the cursor takes to reach a target
const KEY = 0.055;     // seconds per typed character

(async () => {
  const [base, outDir, ...names] = process.argv.slice(2);
  const browser = await chromium.launch();
  for (const name of names) {
    const shot = SHOTS[name];
    const dir = path.join(outDir, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, colorScheme: 'light' });
    // A fixed clock, so the times on screen ("Today 18:24") are the same on every re-render.
    await page.clock.setFixedTime(new Date('2026-03-12T18:24:00'));
    await page.goto(`${base}/?mock=${shot.mock}`);
    await page.waitForLoadState('networkidle');
    await settle(page);

    let t = 0, n = 0, cursor = [{ t: 0, x: 900, y: 700 }];
    const frames = [];
    const snap = async () => {
      await settle(page);
      const f = `${String(++n).padStart(4, '0')}.png`;
      await page.screenshot({ path: path.join(dir, f) });
      frames.push({ t: +t.toFixed(3), f });
    };
    const moveTo = async sel => {
      // Scroll the target into view first (a cut, like a quick scroll), so the cursor lands where the page shows it.
      const y0 = await page.evaluate(() => scrollY);
      await page.locator(sel).first().scrollIntoViewIfNeeded();
      if (await page.evaluate(() => scrollY) !== y0) { t += 0.3; await snap(); }
      const box = await page.locator(sel).first().boundingBox();
      const x = Math.round(box.x + Math.min(box.width / 2, 60)), y = Math.round(box.y + box.height / 2);
      t += MOVE;
      cursor.push({ t: +t.toFixed(3), x, y });
    };

    await snap();
    for (const [kind, sel, text] of shot.steps) {
      if (kind === 'hold') {
        // Catch what loads during the pause (lists, the next page, a pairing code) with one more frame, shown 0.6 s in.
        await page.waitForTimeout(1500);
        t += Math.min(0.6, sel);
        await snap();
        t += sel - Math.min(0.6, sel);
        continue;
      }
      await moveTo(sel);
      cursor[cursor.length - 1].click = true;
      await page.locator(sel).first().click();
      t += 0.15;
      await snap();
      if (kind === 'type') {
        for (const ch of text) {
          await page.keyboard.type(ch);
          t += KEY;
          await snap();
        }
        t += 0.4;
      } else {
        t += 0.5;
        await snap();
      }
    }
    fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ duration: +t.toFixed(3), frames, cursor }, null, 1));
    console.log(`${name}: ${frames.length} frames, ${t.toFixed(1)} s`);
    await page.close();
  }
  await browser.close();
})();

// Lets the page finish rendering, and hides the mock's own "Demo data" notice, which the real guardian never shows.
async function settle(page) {
  await page.waitForTimeout(160);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length === 0 && /^Demo data\./.test(el.textContent.trim())) el.style.visibility = 'hidden';
    }
  });
}
