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

// Temporary test storage
const requests = new Map();
const usedTransactions = new Set();
const waitingForEmail = new Set();

app.get("/", (req, res) => {
  res.send("HAS MAT Payment Testing Bot is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Parse FamPay email
function parseFamPayEmail(emailText) {
  const amountMatch = emailText.match(
    /successfully received[\s\S]{0,100}?₹\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const transactionMatch = emailText.match(
    /Transaction ID\s*:\s*([A-Z0-9]+)/i
  );

  const utrMatch = emailText.match(
    /UTR\s*:\s*(\d+)/i
  );

  if (!amountMatch || !transactionMatch || !utrMatch) {
    return null;
  }

  return {
    amount: Number(amountMatch[1].replace(/,/g, "")),
    transactionId: transactionMatch[1],
    utr: utrMatch[1]
  };
}

// Start bot
bot.start(async (ctx) => {
  waitingForEmail.delete(ctx.from.id);

  await ctx.reply(
    "Welcome to HAS MAT Payment Testing Bot!\n\n" +
    "Ye sirf testing ke liye hai.\n" +
    "Amount enter karein (whole rupees only).\n\n" +
    "Example: 5"
  );
});

// Email test command
bot.command("testemail", async (ctx) => {
  waitingForEmail.add(ctx.from.id);

  await ctx.reply(
    "FamPay sample email ka complete text paste karein.\n\n" +
    "Personal details hide karke sirf test data use karein."
  );
});

// Text handler
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  // Email matching test
  if (waitingForEmail.has(userId)) {
    waitingForEmail.delete(userId);

    const payment = parseFamPayEmail(text);

    if (!payment) {
      return ctx.reply(
        "Email format samajh nahi aaya.\nStatus: INVALID_EMAIL"
      );
    }

    if (
      usedTransactions.has(payment.transactionId) ||
      usedTransactions.has(payment.utr)
    ) {
      return ctx.reply("Status: DUPLICATE");
    }

    const pending = [...requests.entries()]
      .reverse()
      .find(([id, item]) =>
        item.userId === userId &&
        item.status === "SCREENSHOT_RECEIVED"
      );

    if (!pending) {
      return ctx.reply("Status: NO_PENDING_REQUEST");
    }

    const [requestId, request] = pending;

    if (payment.amount !== request.amount) {
      return ctx.reply(
        "Amount Mismatch!\n\n" +
        `Requested: ₹${request.amount}\n` +
        `Email Amount: ₹${payment.amount}\n` +
        "Status: REJECTED"
      );
    }

    usedTransactions.add(payment.transactionId);
    usedTransactions.add(payment.utr);

    request.status = "EMAIL_DETAILS_MATCHED";

    return ctx.reply(
      "Email Details Matched!\n\n" +
      `Request ID: ${requestId}\n` +
      `Amount: ₹${payment.amount}\n` +
      `Transaction ID: ${payment.transactionId}\n` +
      `UTR: ${payment.utr}\n\n` +
      "Status: EMAIL_DETAILS_MATCHED\n" +
      "Independent bank verification: Not confirmed\n" +
      "Wallet credit: Disabled"
    );
  }

  // Amount entry
  const amount = Number(text);

  if (
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > 100000
  ) {
    return ctx.reply(
      "Valid whole amount enter karein.\nExample: 5"
    );
  }

  const requestId = crypto.randomUUID()
    .replace(/-/g, "")
    .slice(0, 8)
    .toUpperCase();

  requests.set(requestId, {
    userId,
    amount,
    status: "AWAITING_SCREENSHOT",
    createdAt: new Date().toISOString()
  });

  return ctx.reply(
    "Test Request Created\n\n" +
    `Request ID: ${requestId}\n` +
    `Amount: ₹${amount}\n\n` +
    "Ab test screenshot bhejein.\n" +
    "Real payment aur wallet credit enabled nahi hai."
  );
});

// Screenshot handler
bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;

  const pending = [...requests.entries()]
    .reverse()
    .find(([id, item]) =>
      item.userId === userId &&
      item.status === "AWAITING_SCREENSHOT"
    );

  if (!pending) {
    return ctx.reply(
      "Pehle /start karke amount request banayein."
    );
  }

  const [requestId, request] = pending;

  request.screenshotFileId =
    ctx.message.photo[ctx.message.photo.length - 1].file_id;

  request.status = "SCREENSHOT_RECEIVED";

  await ctx.reply(
    "Screenshot Received!\n\n" +
    `Request ID: ${requestId}\n` +
    `Amount: ₹${request.amount}\n` +
    "Status: Pending Verification\n\n" +
    "Email matching test ke liye /testemail bhejein."
  );
});

// Webhook
app.use(bot.webhookCallback("/telegram"));

async function start() {
  const port = process.env.PORT || 10000;

  await bot.telegram.setWebhook(`${APP_URL}/telegram`);

  app.listen(port, () => {
    console.log(`HAS MAT bot running on port ${port}`);
  });
}

start().catch((error) => {
  console.error("Startup error:", error);
  process.exit(1);
});
