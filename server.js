
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

// TEST DATA: memory only; Render restart par clear ho jayega.
const requests = new Map();
const usedTransactions = new Set();

app.get("/", (req, res) => {
  res.send("HAS MAT Payment Testing Bot is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// FamPay email details extract karna
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

// Email details aur pending request compare karna
function matchPayment(emailText, request) {
  const payment = parseFamPayEmail(emailText);

  if (!payment) {
    return { status: "INVALID_EMAIL" };
  }

  if (
    usedTransactions.has(payment.transactionId) ||
    usedTransactions.has(payment.utr)
  ) {
    return { status: "DUPLICATE" };
  }

  if (payment.amount !== request.amount) {
    return {
      status: "AMOUNT_MISMATCH",
      received: payment.amount,
      requested: request.amount
    };
  }

  return {
    status: "DETAILS_MATCHED",
    amount: payment.amount,
    transactionId: payment.transactionId,
    utr: payment.utr
  };
}

// Start
bot.start(async (ctx) => {
  await ctx.reply(
    "Welcome to HAS MAT Payment Testing Bot!\n\n" +
    "Ye sirf testing ke liye hai.\n" +
    "Payment request banane ke liye amount enter karein."
  );
});

// Amount request
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  const amount = Number(text);

  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) {
    return ctx.reply(
      "Valid whole amount enter karein.\nExample: 5"
    );
  }

  const requestId = crypto.randomUUID()
    .replace(/-/g, "")
    .slice(0, 8)
    .toUpperCase();

  requests.set(requestId, {
    userId: ctx.from.id,
    amount,
    status: "AWAITING_SCREENSHOT",
    createdAt: new Date().toISOString()
  });

  await ctx.reply(
    "Test Request Created\n\n" +
    `Request ID: ${requestId}\n` +
    `Amount: ₹${amount}\n\n` +
    "Ab testing screenshot bhejein.\n\n" +
    "Note: Real payment ya wallet credit enabled nahi hai."
  );
});

// Screenshot receive
bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;

  const request = [...requests.entries()]
    .reverse()
    .find(([id, item]) =>
      item.userId === userId &&
      item.status === "AWAITING_SCREENSHOT"
    );

  if (!request) {
    return ctx.reply("Pehle amount enter karke request banayein.");
  }

  const [requestId, data] = request;

  data.screenshotFileId =
    ctx.message.photo[ctx.message.photo.length - 1].file_id;

  data.status = "SCREENSHOT_RECEIVED";

  await ctx.reply(
    "Screenshot received!\n\n" +
    `Request ID: ${requestId}\n` +
    `Amount: ₹${data.amount}\n` +
    "Status: Pending Verification\n\n" +
    "Screenshot alone se payment verified nahi hota."
  );
});

// Test email parser with pasted email text
bot.command("testemail", async (ctx) => {
  await ctx.reply(
    "Test email ka complete text paste karein.\n\n" +
    "Sirf sample/test email use karein. Personal account details share na karein."
  );
});

// Next text after /testemail is treated as test email
const waitingForEmail = new Set();

bot.command("testemail", async (ctx) => {
  waitingForEmail.add(ctx.from.id);
  await ctx.reply("Ab sample FamPay email text bhejein.");
});

bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;

  if (!waitingForEmail.has(userId)) return next();

  waitingForEmail.delete(userId);

  const emailText = ctx.message.text;
  const payment = parseFamPayEmail(emailText);

  if (!payment) {
    return ctx.reply(
      "Email format samajh nahi aaya.\nStatus: INVALID_EMAIL"
    );
  }

  const pending = [...requests.entries()]
    .reverse()
    .find(([id, item]) =>
      item.userId === userId &&
      item.status === "SCREENSHOT_RECEIVED" &&
      item.amount === payment.amount
    );

  if (
    usedTransactions.has(payment.transactionId) ||
    usedTransactions.has(payment.utr)
  ) {
    return ctx.reply("Status: DUPLICATE EMAIL");
  }

  if (!pending) {
    return ctx.reply(
      `Email Amount: ₹${payment.amount}\n` +
      "Status: NO_MATCHING_REQUEST\n" +
      "Koi matching pending request nahi mili."
    );
  }

  const [requestId, request] = pending;
  const result = matchPayment(emailText, request);

  if (result.status === "DETAILS_MATCHED") {
    usedTransactions.add(payment.transactionId);
    usedTransactions.add(payment.utr);

    request.status = "EMAIL_DETAILS_MATCHED";

    return ctx.reply(
      "Email Details Matched\n\n" +
      `Request ID: ${requestId}\n` +
      `Amount: ₹${payment.amount}\n` +
      `Transaction ID: ${payment.transactionId}\n` +
      `UTR: ${payment.utr}\n\n` +
      "Status: EMAIL_DETAILS_MATCHED\n" +
      "Independent bank verification aur wallet credit enabled nahi hai."
    );
  }

  return ctx.reply(`Status: ${result.status}`);
});

app.use(bot.webhookCallback("/telegram"));

async function start() {
  const port = process.env.PORT || 10000;

  await bot.telegram.setWebhook(`${APP_URL}/telegram`);

  app.listen(port, () => {
    console.log(`HAS MAT test bot running on ${port}`);
  });
}

start().catch((error) => {
  console.error("Startup error:", error);
  process.exit(1);
});
