
const express = require("express");
const { Telegraf } = require("telegraf");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.APP_URL;

if (!TOKEN || !APP_URL) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or APP_URL");
}

const bot = new Telegraf(TOKEN);
const pendingAmounts = new Map();
const pendingRequests = new Map();

app.get("/", (req, res) => {
  res.send("HAS MAT Payment Testing Bot is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

bot.start(async (ctx) => {
  pendingAmounts.delete(ctx.from.id);

  await ctx.reply(
    "Welcome to HAS MAT Payment Testing Bot!\n\n" +
    "Ye sirf testing ke liye hai.\n" +
    "Payment verification ke liye amount enter karein."
  );
  await ctx.reply("Amount enter karein (₹):");
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  if (!pendingAmounts.has(userId)) {
    const amount = Number(text);

    if (!Number.isInteger(amount) || amount < 1 || amount > 100000) {
      return ctx.reply("Please valid whole amount enter karein.");
    }

    pendingAmounts.set(userId, amount);

    const requestId = crypto.randomUUID().slice(0, 8).toUpperCase();

    pendingRequests.set(requestId, {
      userId,
      amount,
      status: "awaiting_screenshot",
      createdAt: new Date().toISOString()
    });

    pendingAmounts.delete(userId);

    ctx.session = ctx.session || {};
    pendingAmounts.set(userId, {
      requestId,
      amount
    });

    return ctx.reply(
      `Test Request Created\n\n` +
      `Request ID: ${requestId}\n` +
      `Amount: ₹${amount}\n\n` +
      `Ab testing screenshot bhejein.\n` +
      `Note: Is bot mein abhi real payment ya wallet credit enabled nahi hai.`
    );
  }

  return ctx.reply("Apna payment screenshot bhejein.");
});

bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;
  const pending = pendingAmounts.get(userId);

  if (!pending || typeof pending !== "object") {
    return ctx.reply("Pehle /start karke amount enter karein.");
  }

  const request = pendingRequests.get(pending.requestId);

  if (!request) {
    pendingAmounts.delete(userId);
    return ctx.reply("Request nahi mili. Dobara /start karein.");
  }

  request.status = "screenshot_received";
  request.screenshotFileId =
    ctx.message.photo[ctx.message.photo.length - 1].file_id;
  request.receivedAt = new Date().toISOString();

  pendingAmounts.delete(userId);

  await ctx.reply(
    `Screenshot received!\n\n` +
    `Request ID: ${pending.requestId}\n` +
    `Amount: ₹${pending.amount}\n` +
    `Status: Pending Verification\n\n` +
    `Abhi payment automatically approve nahi hua hai.`
  );
});

app.use(bot.webhookCallback("/telegram"));

async function start() {
  const port = process.env.PORT || 10000;

  await bot.telegram.setWebhook(`${APP_URL}/telegram`);

  app.listen(port, () => {
    console.log(`Bot server running on port ${port}`);
  });
}

start().catch(console.error);
