import { eq, desc, sql } from "drizzle-orm";
import type { Env } from "../types";
import { decisions, feedback } from "../db/schema";
import { logTelegram, logError } from "../observability/log";

const TG_API = "https://api.telegram.org/bot";

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

/** Handle incoming Telegram webhook — commands and callback queries. */
export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Handle callback queries (trade approve/reject buttons)
  if (body.callback_query) {
    const cbq = body.callback_query as {
      id: string;
      data?: string;
      message?: { chat: { id: number }; message_id: number };
    };

    const data = cbq.data ?? "";
    const chatId = cbq.message?.chat.id;
    const msgId = cbq.message?.message_id;

    if (data.startsWith("approve_trade:")) {
      const tradeId = data.replace("approve_trade:", "");
      await answerCallbackQuery(env, cbq.id, `Trade ${tradeId} approved`);
      if (chatId && msgId) {
        await editMessageText(env, chatId, msgId, `Trade ${tradeId} approved`);
      }
      // TODO: execute trade via Yahoo API
    } else if (data.startsWith("reject_trade:")) {
      const tradeId = data.replace("reject_trade:", "");
      await answerCallbackQuery(env, cbq.id, `Trade ${tradeId} rejected`);
      if (chatId && msgId) {
        await editMessageText(env, chatId, msgId, `Trade ${tradeId} rejected`);
      }
    }

    return new Response("ok");
  }

  // Handle text commands
  const message = body.message as { text?: string; chat?: { id: number } } | undefined;
  const text = message?.text ?? "";
  const chatId = message?.chat?.id;

  if (chatId) {
    if (text === "/status") {
      await sendReply(env, chatId, "GM is online");
    } else if (text === "/roster") {
      await sendReply(env, chatId, "roster coming soon");
    } else if (text.startsWith("/feedback ")) {
      await handleFeedbackCommand(env, chatId, text);
    }
  }

  return new Response("ok");
}

// ---------------------------------------------------------------------------
// Feedback command
// ---------------------------------------------------------------------------

/** Handle /feedback <good|bad|note> <text> commands */
async function handleFeedbackCommand(env: Env, chatId: number, text: string): Promise<void> {
  // Parse: /feedback good|bad|note <message>
  const parts = text.replace("/feedback ", "").match(/^(good|bad|note)\s+(.+)/s);
  if (!parts) {
    await sendReply(env, chatId, "Usage: /feedback good|bad|note <your feedback>");
    return;
  }

  const type = parts[1];
  const message = parts[2].trim();

  // Get current matchup week (best effort)
  let week: number | null = null;
  try {
    const row = await env.db
      .select({ week: sql<number>`json_extract(${decisions.action}, '$.week')` })
      .from(decisions)
      .where(eq(decisions.type, "lineup"))
      .orderBy(desc(decisions.timestamp))
      .limit(1)
      .get();
    if (row?.week) week = row.week;
  } catch {
    // non-fatal
  }

  try {
    await env.db.insert(feedback).values({ type, message, week });
    await sendReply(env, chatId, `Logged ${type} feedback${week ? ` (week ${week})` : ""}`);
  } catch (e) {
    await sendReply(
      env,
      chatId,
      `Failed to save feedback: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Outbound messages
// ---------------------------------------------------------------------------

/** Split text into chunks at newline boundaries, each under maxLen chars. */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Find last newline within limit
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen; // no newline found — hard split
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

/** Send a message to the configured chat via Telegram API. */
export async function sendMessage(env: Env, text: string): Promise<void> {
  // Preview mode: capture messages instead of sending
  if (env._messageBuffer) {
    env._messageBuffer.push(text);
    return;
  }

  const chunks = splitMessage(text, 4000);
  const start = Date.now();

  try {
    for (const chunk of chunks) {
      const res = await fetch(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: chunk,
          parse_mode: "HTML",
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Telegram sendMessage failed (${res.status}): ${body}`);
      }
    }
    logTelegram(text.slice(0, 100), chunks.length, true, Date.now() - start);
  } catch (e) {
    logTelegram(text.slice(0, 100), chunks.length, false, Date.now() - start);
    throw e;
  }
}

/** Send a trade approval message with inline approve/reject buttons. */
export async function sendTradeApproval(env: Env, tradeId: string, summary: string): Promise<void> {
  const start = Date.now();
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `approve_trade:${tradeId}` },
        { text: "Reject", callback_data: `reject_trade:${tradeId}` },
      ],
    ],
  };

  try {
    const res = await fetch(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: summary,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram sendTradeApproval failed (${res.status}): ${body}`);
    }
    logTelegram(`trade_approval:${tradeId}`, 1, true, Date.now() - start);
  } catch (e) {
    logTelegram(`trade_approval:${tradeId}`, 1, false, Date.now() - start);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

async function sendReply(env: Env, chatId: number, text: string): Promise<void> {
  const res = await fetch(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    logError("telegram_sendReply", `sendReply failed (${res.status}): ${body}`);
  }
}

async function answerCallbackQuery(env: Env, callbackQueryId: string, text: string): Promise<void> {
  await fetch(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function editMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  await fetch(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
}
