---
title: "Example post: what the blog's Markdown can do"
description: "A draft that is never published. It shows every piece of Markdown the trikey.app blog supports, so a change to the generator can be checked by eye."
date: 2026-11-10
slug: example-post
keywords: [example, markdown]
draft: true   # keep this a draft: it exists to test the pipeline, not to be read
---

This post is a **draft**, so the build skips it. Preview it with
`node tools/site/build-blog.mjs --drafts --out /tmp/trikey-preview`.

## Sections start at h2

The title above is the page's only `h1`. Write *emphasis*, **strong**, ~~struck~~ and `inline code`, link to
[a page on this site](/obtainium) or to [another site](https://github.com/bitcoin/bips/blob/master/bip-0048.mediawiki),
and add a note.[^why]

### Lists

- Key 1: any hardware wallet
- Key 2: your phone
  - everyday payments under a daily limit
- Key 3: the guardian on your home server

1. Lose one key.
2. Use the other two.

### A quote, some code and a table

> Any two keys move your money.

```text
wsh(sortedmulti(2,[fp/48h/0h/0h/2h]xpub1/<0;1>/*,…))
```

| Key | Lives | Signs |
|:----|:------|------:|
| 1 | A drawer | Big payments |
| 2 | Your pocket | Every payment |
| 3 | A shelf at home | Under the limit |

![The Trikey home screen: the balance, what the phone can still send today, and recent activity.](/img/phone-home.webp "An image with a caption")

<b>Raw HTML</b> is shown as text, never run.

[^why]: Footnotes are numbered in the order they're used and listed at the end.
