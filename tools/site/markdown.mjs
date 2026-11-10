// A small, safe Markdown to HTML converter for the trikey.app blog. No dependencies.
//
// Supported: ATX headings (## …), paragraphs, hard line breaks (two trailing spaces or a backslash), bullet and
// numbered lists (nested by indentation), blockquotes, fenced code blocks (``` or ~~~, with a language), horizontal
// rules, GitHub-style pipe tables, links (inline, <autolinks> and [reference][ref] links), images, **bold**, *italic*,
// ~~strikethrough~~, `inline code`, backslash escapes and footnotes ([^1] with a "[^1]: …" line).
//
// Not supported, on purpose: raw HTML (it is escaped and shows as text), setext headings, indented code blocks.
//
// Safety: every piece of text and every attribute is HTML-escaped. Links may only be http(s), mailto, or paths on this
// site; anything else (javascript:, data:, //host) is an error. Links to other sites get rel="noopener". Images must be
// files on this site, so a page never loads anything from elsewhere (the CSP would block it anyway).

const SITE_HOSTS = new Set(['trikey.app', 'www.trikey.app']);

/** Escapes text for HTML element content and double-quoted attribute values. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Lower-case, ASCII, hyphen-separated: "Delay & Notify, explained" -> "delay-notify-explained". */
export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * Classifies a link or image target. Returns { href, external } or throws for a scheme we don't allow.
 * Site-absolute paths ("/blog/x") and fragments ("#notes") are internal; http(s) URLs to trikey.app are internal too.
 */
export function checkUrl(raw) {
  const url = String(raw).trim();
  if (url === '') throw new Error('empty link target');
  if (/[\u0000-\u001f\u007f\s]/.test(url)) throw new Error(`link target has spaces or control characters: ${url}`);
  if (url.startsWith('//')) throw new Error(`protocol-relative link target, write https:// instead: ${url}`);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === 'mailto') return { href: url, external: true };
    if (s !== 'http' && s !== 'https') throw new Error(`link scheme "${s}:" is not allowed: ${url}`);
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error(`not a valid URL: ${url}`);
    }
    return { href: url, external: !SITE_HOSTS.has(host) };
  }
  return { href: url, external: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Inline content

function findCodeSpanEnd(src, i, n) {
  // src[i..i+n) is a run of n backticks; find a closing run of exactly n.
  let j = i + n;
  while (j < src.length) {
    const k = src.indexOf('`', j);
    if (k < 0) return -1;
    let m = k;
    while (src[m] === '`') m++;
    if (m - k === n) return k;
    j = m;
  }
  return -1;
}

// Finds the "]" that closes the "[" at i, skipping escapes, code spans and nested brackets.
function findCloseBracket(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (src[j + n] === '`') n++;
      const end = findCodeSpanEnd(src, j, n);
      if (end >= 0) {
        j = end + n - 1;
        continue;
      }
      j += n - 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// Parses "(dest "title")" starting at src[i] === "(". Returns { dest, title, end } (end = index after ")") or null.
function parseInlineTarget(src, i) {
  if (src[i] !== '(') return null;
  let j = i + 1;
  while (src[j] === ' ') j++;
  let dest = '';
  if (src[j] === '<') {
    const k = src.indexOf('>', j);
    if (k < 0) return null;
    dest = src.slice(j + 1, k);
    j = k + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\' && j + 1 < src.length) {
        j += 2;
        continue;
      }
      if (c === ' ') break;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    dest = src.slice(start, j).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  while (src[j] === ' ') j++;
  let title = null;
  if (src[j] === '"' || src[j] === "'") {
    const q = src[j];
    const k = src.indexOf(q, j + 1);
    if (k < 0) return null;
    title = src.slice(j + 1, k);
    j = k + 1;
    while (src[j] === ' ') j++;
  }
  if (src[j] !== ')') return null;
  return { dest, title, end: j + 1 };
}

function isSpace(c) {
  return c === undefined || /\s/.test(c);
}

function isWordChar(c) {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

/**
 * Renders inline Markdown to HTML. ctx carries the reference definitions, the footnotes seen so far, and the hooks the
 * page builder uses to check links and images.
 */
export function renderInline(src, ctx, inLink = false) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    // Hard line break: backslash or two spaces before a newline.
    if (c === '\\' && src[i + 1] === '\n') {
      out += '<br>\n';
      i += 2;
      continue;
    }
    if (c === ' ' && /^ {2,}\n/.test(src.slice(i))) {
      const m = /^ {2,}\n/.exec(src.slice(i));
      out += '<br>\n';
      i += m[0].length;
      continue;
    }
    if (c === '\\' && i + 1 < src.length && PUNCT.test(src[i + 1])) {
      out += escapeHtml(src[i + 1]);
      i += 2;
      continue;
    }

    if (c === '`') {
      let n = 0;
      while (src[i + n] === '`') n++;
      const end = findCodeSpanEnd(src, i, n);
      if (end < 0) {
        out += '`'.repeat(n);
        i += n;
        continue;
      }
      let code = src.slice(i + n, end).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
      out += `<code>${escapeHtml(code)}</code>`;
      i = end + n;
      continue;
    }

    // Footnote reference [^id]
    if (c === '[' && src[i + 1] === '^') {
      const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(i));
      if (m && ctx.footnoteDefs.has(m[1])) {
        out += footnoteRef(m[1], ctx);
        i += m[0].length;
        continue;
      }
    }

    // Images and links
    if ((c === '!' && src[i + 1] === '[') || (c === '[' && !inLink)) {
      const isImage = c === '!';
      const open = isImage ? i + 1 : i;
      const close = findCloseBracket(src, open);
      if (close > 0) {
        const text = src.slice(open + 1, close);
        let target = parseInlineTarget(src, close + 1);
        let end = target ? target.end : -1;
        if (!target) {
          // [text][ref], [text][] or [ref]
          const ref = /^\[([^\]]*)\]/.exec(src.slice(close + 1));
          const label = (ref && ref[1] !== '' ? ref[1] : text).trim().toLowerCase().replace(/\s+/g, ' ');
          const def = ctx.refs.get(label);
          if (def) {
            target = def;
            end = ref ? close + 1 + ref[0].length : close + 1;
          }
        }
        if (target) {
          if (isImage) out += ctx.image(target.dest, plainText(text), target.title);
          else out += ctx.link(target.dest, renderInline(text, ctx, true), target.title);
          i = end;
          continue;
        }
      }
    }

    // Autolinks <https://…> and <mailto:…>
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
      if (m && !inLink) {
        out += ctx.link(m[1], escapeHtml(m[1].replace(/^mailto:/i, '')), null);
        i += m[0].length;
        continue;
      }
    }

    // ~~strikethrough~~
    if (c === '~' && src[i + 1] === '~' && !isSpace(src[i + 2])) {
      const k = src.indexOf('~~', i + 2);
      if (k > i + 2 && !isSpace(src[k - 1])) {
        out += `<del>${renderInline(src.slice(i + 2, k), ctx, inLink)}</del>`;
        i = k + 2;
        continue;
      }
    }

    // *emphasis*, **strong**, ***both*** (and the same with _, only at word boundaries)
    if (c === '*' || c === '_') {
      let n = 0;
      while (src[i + n] === c) n++;
      const before = src[i - 1];
      const after = src[i + n];
      const canOpen = !isSpace(after) && (c === '*' || !isWordChar(before));
      if (canOpen && n <= 3) {
        const close = findEmphasisClose(src, i + n, c, n);
        if (close > 0) {
          const inner = renderInline(src.slice(i + n, close), ctx, inLink);
          out += n === 1 ? `<em>${inner}</em>` : n === 2 ? `<strong>${inner}</strong>` : `<strong><em>${inner}</em></strong>`;
          i = close + n;
          continue;
        }
      }
      out += escapeHtml(c.repeat(n));
      i += n;
      continue;
    }

    out += escapeHtml(c);
    i++;
  }
  return out;
}

function findEmphasisClose(src, from, ch, n) {
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '`') {
      let m = 0;
      while (src[j + m] === '`') m++;
      const end = findCodeSpanEnd(src, j, m);
      j = end >= 0 ? end + m - 1 : j + m - 1;
      continue;
    }
    if (c !== ch) continue;
    let m = 0;
    while (src[j + m] === ch) m++;
    const canClose = !isSpace(src[j - 1]) && (ch === '*' || !isWordChar(src[j + m]));
    if (m === n && canClose && j > from) return j;
    j += m - 1;
  }
  return -1;
}

/** The text of inline Markdown without its markup (for alt text, headings ids and word counts). */
export function plainText(src) {
  return String(src)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*{1,3}|_{1,3}|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function footnoteRef(id, ctx) {
  let n = ctx.footnoteOrder.indexOf(id) + 1;
  if (n === 0) {
    ctx.footnoteOrder.push(id);
    n = ctx.footnoteOrder.length;
  }
  const key = slugify(id) || String(n);
  return `<sup class="fnref"><a id="fnref-${escapeHtml(key)}" href="#fn-${escapeHtml(key)}" aria-label="Note ${n}">${n}</a></sup>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks

const RE = {
  fence: /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/,
  heading: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}>/,
  item: /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/,
  tableDelim: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
  refDef: /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/,
  footDef: /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/,
};

function indentOf(line) {
  const m = /^[ \t]*/.exec(line)[0];
  return m.replace(/\t/g, '    ').length;
}

function isBlank(line) {
  return line.trim() === '';
}

function startsBlock(line) {
  return (
    RE.fence.test(line) ||
    (RE.heading.test(line) && /^ {0,3}#{1,6}([ \t]|$)/.test(line)) ||
    RE.hr.test(line) ||
    RE.quote.test(line) ||
    // A numbered list can only interrupt a paragraph when it starts at 1, so "2026. A year…" stays text.
    (RE.item.test(line) && !/^ {0,3}(?!1[.)])\d/.test(line))
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** Parses lines into an array of blocks: { type, html, inline? } */
function parseBlocks(lines, ctx) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    let m = RE.fence.exec(line);
    if (m) {
      const indent = m[1].length;
      const fence = m[2];
      const lang = m[3];
      const body = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
        if (close.test(l)) {
          i++;
          break;
        }
        body.push(l.replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      const cls = lang ? ` class="language-${escapeHtml(lang.replace(/[^\w+-]/g, ''))}"` : '';
      blocks.push({ type: 'code', html: `<pre><code${cls}>${escapeHtml(body.join('\n'))}${body.length ? '\n' : ''}</code></pre>` });
      continue;
    }

    if (/^ {0,3}#{1,6}([ \t]|$)/.test(line)) {
      m = RE.heading.exec(line);
      const level = m[1].length;
      const text = (m[2] || '').trim();
      blocks.push({ type: 'heading', html: ctx.heading(level, text) });
      i++;
      continue;
    }

    if (RE.hr.test(line)) {
      blocks.push({ type: 'hr', html: '<hr>' });
      i++;
      continue;
    }

    if (RE.quote.test(line)) {
      const inner = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const l = lines[i];
        if (RE.quote.test(l)) inner.push(l.replace(/^ {0,3}> ?/, ''));
        else if (inner.length && !startsBlock(l)) inner.push(l); // lazy continuation
        else break;
        i++;
      }
      const html = parseBlocks(inner, ctx)
        .map((b) => b.html)
        .join('\n');
      blocks.push({ type: 'quote', html: `<blockquote>\n${html}\n</blockquote>` });
      continue;
    }

    if (RE.item.test(line)) {
      const res = parseList(lines, i, ctx);
      blocks.push(res.block);
      i = res.next;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((d) =>
        d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : '',
      );
      if (aligns.length === head.length) {
        i += 2;
        const rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const cell = (tag, text, k) => {
          const cls = aligns[k] ? ` class="align-${aligns[k]}"` : '';
          const scope = tag === 'th' ? ' scope="col"' : '';
          return `<${tag}${scope}${cls}>${renderInline(text ?? '', ctx)}</${tag}>`;
        };
        const thead = `<thead>\n<tr>${head.map((h, k) => cell('th', h, k)).join('')}</tr>\n</thead>`;
        const tbody = rows.length
          ? `\n<tbody>\n${rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k], k)).join('')}</tr>`).join('\n')}\n</tbody>`
          : '';
        blocks.push({
          type: 'table',
          html: `<div class="table-scroll" role="region" aria-label="Table" tabindex="0">\n<table>\n${thead}${tbody}\n</table>\n</div>`,
        });
        continue;
      }
    }

    // Paragraph: runs until a blank line or the start of another block.
    const para = [line.replace(/^[ \t]+/, '')];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
      para.push(lines[i].replace(/^[ \t]+/, ''));
      i++;
    }
    const src = para.join('\n').replace(/[ \t]+$/, '');
    // A paragraph that is only an image becomes a figure; its title, if any, is the caption.
    const only = /^!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?\s*\)$/.exec(src);
    if (only) {
      const img = ctx.image(only[2], plainText(only[1]), null);
      const cap = only[3] ? `\n<figcaption>${renderInline(only[3], ctx)}</figcaption>` : '';
      blocks.push({ type: 'figure', html: `<figure>\n${img}${cap}\n</figure>` });
      continue;
    }
    const inline = renderInline(src, ctx);
    blocks.push({ type: 'paragraph', html: `<p>${inline}</p>`, inline });
  }
  return blocks;
}

function parseList(lines, start, ctx) {
  const first = RE.item.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const delim = ordered ? first[2].slice(-1) : first[2];
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const m = RE.item.exec(lines[i]);
    if (!m) break;
    const isOrdered = /\d/.test(m[2]);
    if (isOrdered !== ordered || (ordered ? m[2].slice(-1) : m[2]) !== delim) break;
    const content = m[1].length + m[2].length + Math.min(Math.max(m[3].replace(/\t/g, '    ').length, 1), 4);
    const itemLines = [m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        let k = i;
        while (k < lines.length && isBlank(lines[k])) k++;
        if (k < lines.length && indentOf(lines[k]) >= content) {
          for (; i < k; i++) itemLines.push('');
          continue;
        }
        break;
      }
      if (indentOf(l) >= content) {
        itemLines.push(l.replace(/\t/g, '    ').slice(content));
        i++;
        continue;
      }
      if (RE.item.test(l) || startsBlock(l)) break;
      if (!isBlank(itemLines[itemLines.length - 1])) {
        itemLines.push(l.trim()); // lazy continuation of the item's paragraph
        i++;
        continue;
      }
      break;
    }
    // A blank line between two blocks of this item (not inside a nested list) makes the list loose.
    if (itemLines.some((l, k) => isBlank(l) && k > 0 && !isBlank(itemLines[k + 1] ?? '') && indentOf(itemLines[k + 1] ?? '') === 0)) {
      loose = true;
    }
    items.push(itemLines);
    // Blank lines between items make the list loose.
    let k = i;
    while (k < lines.length && isBlank(lines[k])) k++;
    if (k > i && k < lines.length) {
      const next = RE.item.exec(lines[k]);
      if (next && /\d/.test(next[2]) === ordered && indentOf(lines[k]) < content) {
        loose = true;
        i = k;
        continue;
      }
      break;
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  const lis = items.map((itemLines) => {
    const blocks = parseBlocks(itemLines, ctx);
    const parts = blocks.map((b) => (!loose && b.type === 'paragraph' ? b.inline : b.html));
    return `<li>${parts.join('\n')}</li>`;
  });
  return { block: { type: 'list', html: `<${tag}${startAttr}>\n${lis.join('\n')}\n</${tag}>` }, next: i };
}

/**
 * Converts Markdown to HTML.
 *
 * options.link(href, check) and options.image(src) let the caller validate internal targets and look up image sizes;
 * by default links are checked for scheme only and images get no width/height.
 * Returns { html, headings: [{ level, text, id }], errors: string[] }.
 */
export function markdownToHtml(markdown, options = {}) {
  const errors = [];
  const headings = [];
  const ids = new Map();
  const refs = new Map();
  const footnoteDefs = new Map();

  // Reference and footnote definitions are pulled out first, outside fenced code.
  const lines = [];
  let inFence = null;
  for (const raw of String(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\u0000/g, '�');
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) inFence = fence[1];
      else if (fence[1][0] === inFence[0] && fence[1].length >= inFence.length && line.trim() === fence[1]) inFence = null;
      lines.push(line);
      continue;
    }
    if (!inFence) {
      const fd = RE.footDef.exec(line);
      if (fd) {
        footnoteDefs.set(fd[1], fd[2]);
        continue;
      }
      const rd = RE.refDef.exec(line);
      if (rd) {
        const label = rd[1].trim().toLowerCase().replace(/\s+/g, ' ');
        if (!refs.has(label)) refs.set(label, { dest: rd[2], title: rd[3] ?? rd[4] ?? rd[5] ?? null });
        continue;
      }
    }
    lines.push(line);
  }

  const ctx = {
    refs,
    footnoteDefs,
    footnoteOrder: [],
    heading(level, text) {
      if (options.minHeading && level < options.minHeading) {
        errors.push(`"${'#'.repeat(level)} ${text}": the post title is the page's only h1, so start sections at ${'#'.repeat(options.minHeading)}`);
      }
      const base = slugify(plainText(text)) || 'section';
      const seen = ids.get(base) || 0;
      ids.set(base, seen + 1);
      const id = seen ? `${base}-${seen + 1}` : base;
      headings.push({ level, text: plainText(text), id });
      return `<h${level} id="${escapeHtml(id)}">${renderInline(text, ctx)}</h${level}>`;
    },
    link(dest, innerHtml, title) {
      let t;
      try {
        t = checkUrl(dest);
      } catch (e) {
        errors.push(e.message);
        return innerHtml;
      }
      if (!t.external && options.checkInternal) {
        const problem = options.checkInternal(t.href);
        if (problem) errors.push(problem);
      }
      const rel = t.external && !/^mailto:/i.test(t.href) ? ' rel="noopener"' : '';
      const ttl = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(t.href)}"${ttl}${rel}>${innerHtml}</a>`;
    },
    image(src, alt, title) {
      let t;
      try {
        t = checkUrl(src);
      } catch (e) {
        errors.push(e.message);
        return '';
      }
      if (t.external || /^mailto:/i.test(t.href)) {
        errors.push(`images must be files on this site (the page loads nothing from elsewhere): ${src}`);
        return '';
      }
      if (!alt) errors.push(`image without alt text: ${src}. Describe it, as in ![A phone showing …](${src})`);
      let size = '';
      if (options.image) {
        const r = options.image(t.href);
        if (typeof r === 'string') errors.push(r);
        else if (r) size = ` width="${r.width}" height="${r.height}"`;
      }
      const ttl = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(t.href)}" alt="${escapeHtml(alt)}"${size}${ttl} loading="lazy" decoding="async">`;
    },
  };

  let html = parseBlocks(lines, ctx)
    .map((b) => b.html)
    .join('\n');

  for (const id of footnoteDefs.keys()) {
    if (!ctx.footnoteOrder.includes(id)) errors.push(`footnote [^${id}] is defined but never used`);
  }
  if (ctx.footnoteOrder.length) {
    const items = ctx.footnoteOrder.map((id, k) => {
      const key = slugify(id) || String(k + 1);
      const body = renderInline(footnoteDefs.get(id), ctx);
      return `<li id="fn-${escapeHtml(key)}">${body} <a class="fnback" href="#fnref-${escapeHtml(key)}" aria-label="Back to the text">↩</a></li>`;
    });
    html += `\n<section class="footnotes" aria-label="Notes">\n<ol>\n${items.join('\n')}\n</ol>\n</section>`;
  }
  return { html, headings, errors };
}

/** Number of words in the Markdown's text (code blocks count, markup doesn't). */
export function wordCount(markdown) {
  const text = plainText(String(markdown).replace(/^ {0,3}(```|~~~).*$/gm, '').replace(/[#>|*_\-]+/g, ' '));
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}
