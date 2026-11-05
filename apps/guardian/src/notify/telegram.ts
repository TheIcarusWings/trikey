/**
 * Telegram through the Bot API (docs/design/notifications.md, "Telegram"): a bot the owner makes with @BotFather, one
 * per guardian, and a chat id per destination (the owner, an alert contact, someone without a nostr app).
 *
 * - Outbound only, over the same HTTPS client and address checks as ntfy and webhooks (net.ts): no webhook, no open
 *   port, no long poll. The guardian reads the bot's messages only when the owner presses "Find" in the web UI
 *   (`getUpdates`, one short poll), to list who sent `/start` (a bot cannot write first); never afterwards.
 * - The token sits in the URL path (`/bot<token>/<method>`), so no error here carries a URL: net.ts names only the
 *   host, and Telegram's own refusals are put in plain words.
 * - Messages are plain text: no `parse_mode` (nothing in them is interpreted as Markdown or HTML), link previews off,
 *   and the same link-free words as every other channel (render.ts). Low-priority ones (payments, tests) arrive silently.
 * - Telegram's limits: a 429 carries `retry_after`; `TelegramError.retryAfterMs` passes it on, and the notifier waits
 *   that long before it sends anything with the bot again.
 */
import { postForAnswer, type NetPolicy } from './net.js';
import type { Message } from './render.js';

export const TELEGRAM_API = 'https://api.telegram.org';
/** A bot token as @BotFather shows it: the bot's id, a colon, and 35 characters (some room either way). */
export const TELEGRAM_TOKEN_RE = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
/** A chat id as the Bot API gives it (private chats are positive; at most 52 significant bits). */
export const TELEGRAM_CHAT_RE = /^-?\d{1,16}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;
/** Telegram's limit for one message's text. */
export const TELEGRAM_MAX_TEXT = 4096;
/** The longest wait a 429 may impose here (Telegram asks for seconds, now and then minutes). */
const MAX_RETRY_AFTER_MS = 3_600_000;
/** `getUpdates` with 100 updates can run to some 100 KiB. */
const MAX_UPDATES_BYTES = 512 * 1024;
/** At most this many chats come back from "Find". */
export const MAX_FOUND_CHATS = 20;

export interface TelegramBot {
  id: number;
  /** Without the `@`. */
  username: string;
  /** Its display name, as the owner gave it in @BotFather. */
  name: string;
}

/** A private chat that sent `/start` to the bot lately ("Find"). */
export interface TelegramChat {
  chatId: string;
  /** First and last name, as the person set them in Telegram (anyone can choose any). */
  name: string;
  username?: string;
  /** When the last `/start` came (ms). */
  at: number;
}

export type TelegramErrorCode = 'token' | 'webhook' | 'conflict' | 'blocked' | 'chat' | 'rate' | 'unreachable' | 'failed';

export class TelegramError extends Error {
  constructor(
    readonly code: TelegramErrorCode,
    message: string,
    /** `code: rate`: how long Telegram asked to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export interface TelegramOptions extends NetPolicy {
  /** The Bot API's address (tests: a fake on 127.0.0.1). Default `TELEGRAM_API`. */
  api?: string;
}

/** Text someone else chose (a name, Telegram's error description): one line, no control or direction characters, short. */
export function cleanText(raw: unknown, max = 64): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** One Bot API call. Resolves with `result`; throws `TelegramError` in plain words (never with the token or a URL). */
async function call(token: string, method: string, params: Record<string, unknown>, opts: TelegramOptions, maxBytes = 16 * 1024): Promise<unknown> {
  const api = (opts.api ?? TELEGRAM_API).replace(/\/$/, '');
  let answer;
  try {
    answer = await postForAnswer(`${api}/bot${token}/${method}`, JSON.stringify(params), { 'Content-Type': 'application/json', 'User-Agent': 'TrikeyGuardian' }, { ...opts, maxBytes });
  } catch (e) {
    throw new TelegramError('unreachable', `Could not reach Telegram: ${(e as Error).message}`);
  }
  let j: { ok?: unknown; result?: unknown; error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } } | undefined;
  try {
    j = JSON.parse(answer.body) as typeof j;
  } catch {
    j = undefined;
  }
  if (answer.status >= 200 && answer.status < 300 && j?.ok === true) return j.result;
  const code = typeof j?.error_code === 'number' ? j.error_code : answer.status;
  const said = cleanText(j?.description, 160) || `HTTP ${answer.status}`;
  if (code === 429) {
    const s = typeof j?.parameters?.retry_after === 'number' && j.parameters.retry_after > 0 ? j.parameters.retry_after : 30;
    const ms = Math.min(Math.ceil(s) * 1000, MAX_RETRY_AFTER_MS);
    throw new TelegramError('rate', `Telegram asks to wait ${Math.ceil(ms / 1000)} seconds (too many messages)`, ms);
  }
  if (code === 401 || code === 404) throw new TelegramError('token', 'Telegram refused the bot token: copy it again from @BotFather (it may have been revoked).');
  if (code === 409 && /webhook/i.test(said))
    throw new TelegramError('webhook', "This bot has a webhook set: another service already uses it, so the guardian can't read who wrote to it. Make a new bot with @BotFather just for the guardian.");
  if (code === 409) throw new TelegramError('conflict', "Another program is reading this bot's messages right now. Make a new bot with @BotFather just for the guardian.");
  if (code === 403) throw new TelegramError('blocked', `Telegram refused: they blocked the bot or never sent it /start (${said})`);
  if (code === 400 && /chat not found/i.test(said)) throw new TelegramError('chat', 'Telegram does not know this chat: they need to send /start to the bot first.');
  throw new TelegramError('failed', `Telegram: ${said}`);
}

/** `getMe`: checks the token and says which bot it belongs to. */
export async function telegramGetMe(token: string, opts: TelegramOptions = {}): Promise<TelegramBot> {
  const r = (await call(token, 'getMe', {}, opts)) as { id?: unknown; is_bot?: unknown; username?: unknown; first_name?: unknown } | undefined;
  if (!r || r.is_bot !== true || typeof r.id !== 'number' || typeof r.username !== 'string' || !USERNAME_RE.test(r.username))
    throw new TelegramError('failed', 'Telegram answered, but not with a bot. Check the token.');
  return { id: r.id, username: r.username, name: cleanText(r.first_name) || r.username };
}

interface Update {
  message?: { date?: unknown; text?: unknown; chat?: { id?: unknown; type?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown } };
}

/**
 * "Find": one short poll (`getUpdates`, no wait) for the private chats that sent `/start` to the bot, newest first.
 * Takes the last 100 updates Telegram holds (it keeps them for a day); the older ones are let go. Fails in plain words
 * when the bot has a webhook (another service uses it) or another program polls it.
 */
export async function telegramFindStarts(token: string, opts: TelegramOptions = {}): Promise<TelegramChat[]> {
  const r = await call(token, 'getUpdates', { offset: -100, limit: 100, timeout: 0 }, opts, MAX_UPDATES_BYTES);
  if (!Array.isArray(r)) throw new TelegramError('failed', 'Telegram answered something unexpected.');
  const chats = new Map<string, TelegramChat>();
  for (const u of r as Update[]) {
    const m = u?.message;
    const chat = m?.chat;
    if (!m || !chat || chat.type !== 'private' || typeof m.text !== 'string' || !/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(m.text)) continue;
    if (typeof chat.id !== 'number' || !Number.isSafeInteger(chat.id)) continue;
    const chatId = String(chat.id);
    const at = typeof m.date === 'number' ? m.date * 1000 : 0;
    const prev = chats.get(chatId);
    if (prev && prev.at >= at) continue;
    const name = cleanText(`${typeof chat.first_name === 'string' ? chat.first_name : ''} ${typeof chat.last_name === 'string' ? chat.last_name : ''}`) || 'No name';
    const username = typeof chat.username === 'string' && USERNAME_RE.test(chat.username) ? chat.username : undefined;
    chats.set(chatId, { chatId, name, ...(username ? { username } : {}), at });
  }
  return [...chats.values()].sort((a, b) => b.at - a.at).slice(0, MAX_FOUND_CHATS);
}

/** The text of one alert: its title, a blank line, its body; cut to Telegram's limit. */
export function telegramText(msg: Message): string {
  const text = `${msg.title}\n\n${msg.body}`;
  return text.length <= TELEGRAM_MAX_TEXT ? text : `${text.slice(0, TELEGRAM_MAX_TEXT - 1)}…`;
}

/** `sendMessage`: plain text (no `parse_mode`), no link preview; low priority arrives without a sound. */
export async function sendTelegram(token: string, chatId: string, msg: Message, opts: TelegramOptions = {}): Promise<void> {
  await call(
    token,
    'sendMessage',
    {
      chat_id: chatId,
      text: telegramText(msg),
      disable_web_page_preview: true,
      link_preview_options: { is_disabled: true },
      ...(msg.priority === 'low' ? { disable_notification: true } : {}),
    },
    opts,
  );
}
