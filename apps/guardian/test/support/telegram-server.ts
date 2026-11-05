/**
 * A fake Telegram Bot API on 127.0.0.1 for the notification tests (`POST /bot<token>/<method>` with a JSON body, as
 * notify/telegram.ts calls it): `getMe`, `getUpdates` (with `/start` messages the test adds), `sendMessage`, and the
 * refusals the guardian must put in plain words: an unknown token (401), a webhook set elsewhere (409), a 429 with
 * `retry_after`, a chat that blocked the bot (403). Throwaway tokens only; nothing leaves the machine.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeBot {
  id: number;
  username: string;
  first_name: string;
}

export interface SentMessage {
  /** The token it came in with. */
  token: string;
  chatId: string;
  /** The whole JSON body (to check there is no `parse_mode`). */
  body: Record<string, unknown>;
  text: string;
}

export interface FakeTelegram {
  url: string;
  port: number;
  /** Valid tokens and the bot each belongs to (delete one to stand for /revoke). */
  bots: Map<string, FakeBot>;
  /** Every call, in order (method and token), to check the guardian never polls on its own. */
  calls: { method: string; token: string; body: Record<string, unknown> }[];
  sent: SentMessage[];
  updates: Record<string, unknown>[];
  /** A webhook is set for the bot: getUpdates answers 409. */
  webhookSet: boolean;
  /** The next this many sendMessage calls answer 429 with `retry_after: retryAfter`. */
  rateLimited: number;
  retryAfter: number;
  /** Chats that blocked the bot (sendMessage answers 403). */
  blocked: Set<string>;
  /** Adds a `/start` from a private chat to what getUpdates returns. */
  start(chatId: number, firstName: string, opts?: { lastName?: string; username?: string; at?: number; text?: string; type?: string }): void;
  /** Text of the messages to one chat. */
  to(chatId: string | number): string[];
  stop(): Promise<void>;
}

export const BOT_TOKEN = '7000000001:AAtest-token-for-the-fake-telegram-api0';
export const BOT_TOKEN_NEW = '7000000001:AAanother-token-of-the-same-bot-xyz12';
export const OTHER_BOT_TOKEN = '7000000002:AAtoken-of-a-different-bot-for-tests';

export async function startTelegram(): Promise<FakeTelegram> {
  let updateId = 1000;
  const state: FakeTelegram = {
    url: '',
    port: 0,
    bots: new Map([
      [BOT_TOKEN, { id: 7000000001, username: 'home_vault_alerts_bot', first_name: 'Home vault alerts' }],
      [OTHER_BOT_TOKEN, { id: 7000000002, username: 'other_alerts_bot', first_name: 'Other alerts' }],
    ]),
    calls: [],
    sent: [],
    updates: [],
    webhookSet: false,
    rateLimited: 0,
    retryAfter: 3,
    blocked: new Set(),
    start(chatId, firstName, opts = {}) {
      state.updates.push({
        update_id: updateId++,
        message: {
          message_id: updateId,
          date: Math.floor((opts.at ?? Date.now()) / 1000),
          text: opts.text ?? '/start',
          from: { id: chatId, is_bot: false, first_name: firstName },
          chat: { id: chatId, type: opts.type ?? 'private', first_name: firstName, ...(opts.lastName ? { last_name: opts.lastName } : {}), ...(opts.username ? { username: opts.username } : {}) },
        },
      });
    },
    to: (chatId) => state.sent.filter((m) => m.chatId === String(chatId)).map((m) => m.text),
    stop: async () => {},
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const answer = (status: number, json: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      if (!m || req.method !== 'POST') return answer(404, { ok: false, error_code: 404, description: 'Not Found' });
      const [, token, method] = m as unknown as [string, string, string];
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        return answer(400, { ok: false, error_code: 400, description: 'Bad Request: invalid JSON' });
      }
      state.calls.push({ method, token, body });
      const bot = state.bots.get(token);
      if (!bot) return answer(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      if (method === 'getMe') return answer(200, { ok: true, result: { id: bot.id, is_bot: true, first_name: bot.first_name, username: bot.username, can_join_groups: true } });
      if (method === 'getUpdates') {
        if (state.webhookSet) return answer(409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" });
        const offset = typeof body.offset === 'number' ? body.offset : 0;
        const list = offset < 0 ? state.updates.slice(offset) : state.updates;
        return answer(200, { ok: true, result: list });
      }
      if (method === 'sendMessage') {
        if (state.rateLimited > 0) {
          state.rateLimited -= 1;
          return answer(429, { ok: false, error_code: 429, description: `Too Many Requests: retry after ${state.retryAfter}`, parameters: { retry_after: state.retryAfter } });
        }
        const chatId = String(body.chat_id);
        if (state.blocked.has(chatId)) return answer(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
        if (!/^-?\d+$/.test(chatId)) return answer(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
        state.sent.push({ token, chatId, body, text: String(body.text ?? '') });
        return answer(200, { ok: true, result: { message_id: state.sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: 'private' }, text: body.text } });
      }
      return answer(404, { ok: false, error_code: 404, description: 'Not Found: method not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (server.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${state.port}`;
  state.stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return state;
}
