#!/usr/bin/env node
// Publishes the next queued blog post: one a day (docs/blog-plan.md).
//   node tools/site/publish-next.mjs                       publish the lowest "queue" draft, dated today (UTC), and rebuild
//   node tools/site/publish-next.mjs --today 2026-11-12    the same, with that date
//   node tools/site/publish-next.mjs --list                show the queue and change nothing
// Exit 0: published one. Exit 3: nothing queued (no change). Exit 1: the build failed (no change).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildError, SITE_DIR, buildSite, publishedSource, queuedPosts, writeSite } from './build-blog.mjs';

/** Publishes the next queued post in siteDir. Returns its slug, or null when the queue is empty. */
export function publishNext(siteDir, today) {
  const [next] = queuedPosts(siteDir);
  if (!next) return null;
  const before = readFileSync(next.path, 'utf8');
  writeFileSync(next.path, publishedSource(before, today));
  try {
    writeSite(siteDir, buildSite(siteDir).files);
  } catch (e) {
    writeFileSync(next.path, before); // leave the queue as it was
    throw e;
  }
  return next.slug;
}

function main(argv) {
  const at = argv.indexOf('--today');
  const today = at >= 0 ? argv[at + 1] : new Date().toISOString().slice(0, 10);
  for (const a of argv.filter((x) => x.startsWith('--'))) if (!['--today', '--list'].includes(a)) throw new Error(`unknown option ${a}`);
  const queue = queuedPosts(SITE_DIR);
  if (argv.includes('--list')) {
    if (!queue.length) process.stdout.write('The queue is empty.\n');
    for (const q of queue) process.stdout.write(`${String(q.queue).padStart(4)}  ${q.slug}  (${q.title})\n`);
    return 0;
  }
  let slug;
  try {
    slug = publishNext(SITE_DIR, today);
  } catch (e) {
    if (e instanceof BuildError) {
      process.stderr.write(`${e.message}\nNothing was published.\n`);
      return 1;
    }
    throw e;
  }
  if (!slug) {
    process.stdout.write('The queue is empty: nothing to publish.\n');
    return 3;
  }
  process.stdout.write(`Published ${slug}, dated ${today}. ${queue.length - 1} post(s) left in the queue.\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  }
}
