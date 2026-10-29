// Renders a video page frame by frame and pipes JPEG frames into ffmpeg.
// Usage:
//   node render.js <video.html> <ratio 916|11|169> <out.mp4>          full silent MP4, 30 fps
//   node render.js <video.html> <ratio> <outDir> --stills 0,5.2,12    PNG stills at those times
// It also writes <out>.spec.json (the page's SPEC) for the audio mixer.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SIZE = { 916: [1080, 1920], 11: [1080, 1080], 169: [1920, 1080] };
const FPS = 30;

(async () => {
  const [page_, ratio, out, flag, times] = process.argv.slice(2);
  const [w, h] = SIZE[ratio];
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { console.error('page error:', e.message); process.exit(1); });
  await page.goto('file://' + path.resolve(page_) + '?r=' + ratio);
  await page.evaluate(() => window.ready());
  const spec = await page.evaluate(() => window.SPEC);

  if (flag === '--stills') {
    fs.mkdirSync(out, { recursive: true });
    for (const t of times.split(',').map(Number)) {
      await page.evaluate(t => window.seek(t), t);
      const f = path.join(out, `${spec.id}-${ratio}-${String(t).replace('.', '_')}s.png`);
      await page.screenshot({ path: f });
      console.log(f);
    }
    await browser.close();
    return;
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out.replace(/\.mp4$/, '.spec.json'), JSON.stringify(spec, null, 2));
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = Math.round(spec.duration * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate(t => window.seek(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log(`${spec.id} ${ratio}: ${i}/${frames}`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  await browser.close();
  console.log(out);
})();
