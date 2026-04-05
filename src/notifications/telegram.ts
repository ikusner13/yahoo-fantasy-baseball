import type { Env } from "../types";

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
    }
  }

  return new Response("ok");
}

// ---------------------------------------------------------------------------
// Outbound messages
// ---------------------------------------------------------------------------

/** Send a message to the configured chat via Telegram API. */
export async function sendMessage(env: Env, text: string): Promise<void> {
  const res = await fetch(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed (${res.status}): ${body}`);
  }
}

/** Send a trade approval message with inline approve/reject buttons. */
export async function sendTradeApproval(env: Env, tradeId: string, summary: string): Promise<void> {
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `approve_trade:${tradeId}` },
        { text: "Reject", callback_data: `reject_trade:${tradeId}` },
      ],
    ],
  };

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
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

async function sendReply(env: Env, chatId: number, text: string): Promise<void> {
  await fetch(`${TG_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
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
