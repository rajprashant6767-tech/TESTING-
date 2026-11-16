
const express = require("express");
const { Telegraf } = require("telegraf");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.APP_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GMAIL_ADMIN_TELEGRAM_ID = process.env.GMAIL_ADMIN_TELEGRAM_ID;

if (!TOKEN || !APP_URL) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or APP_URL");
}

const bot = new Telegraf(TOKEN);

// Temporary storage. Render restart clears this data.
const requests = new Map();
const usedTransactions = new Set();
const waitingForEmail = new Set();
const oauthStates = new Map();

let gmailTokens = null;

const FAMPAY_SENDER = "no-reply@famapp.in";

function gmailConfigured() {
  return Boolean(
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET &&
    GOOGLE_REDIRECT_URI
  );
}

function isGmailAdmin(userId) {
  return Boolean(
    GMAIL_ADMIN_TELEGRAM_ID &&
    String(userId) === String(GMAIL_ADMIN_TELEGRAM_ID)
  );
}

function createOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function parseFamPayEmail(emailText) {
  const amountMatch = emailText.match(
    /successfully received[\s\S]{0,180}?₹\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const transactionMatch = emailText.match(
    /Transaction\s*ID\s*:\s*([A-Z0-9]+)/i
  );

  const utrMatch = emailText.match(
    /\bUTR\s*:\s*(\d+)/i
  );

  if (!amountMatch) return null;

  return {
    amount: Number(amountMatch[1].replace(/,/g, "")),
    transactionId: transactionMatch
      ? transactionMatch[1]
      : null,
    utr: utrMatch ? utrMatch[1] : null
  };
}

function decodeBase64Url(value) {
  if (!value) return "";
  return Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

function extractEmailBody(payload) {
  let result = "";

  function walk(part) {
    if (!part) return;

    if (
      part.mimeType === "text/plain" &&
      part.body &&
      part.body.data
    ) {
      result += decodeBase64Url(part.body.data) + "\n";
    }

    if (part.parts) {
      for (const child of part.parts) {
        walk(child);
      }
    }
  }

  walk(payload);

  if (!result && payload.body && payload.body.data) {
    result = decodeBase64Url(payload.body.data);
  }

  return result;
}

// Health routes
app.get("/", (req, res) => {
  res.send("HAS MAT Payment Testing Bot is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Gmail OAuth callback
app.get("/gmail/oauth2callback", async (req, res) => {
  try {
    if (!gmailConfigured()) {
      return res.status(500).send(
        "Google OAuth environment variables missing."
      );
    }

    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(
        "Google authorization was not completed."
      );
    }

    if (
      !code ||
      !state ||
      !oauthStates.has(String(state))
    ) {
      return res.status(400).send(
        "Invalid or expired OAuth state. Run /connectgmail again."
      );
    }

    oauthStates.delete(String(state));

    const oauth2Client = createOAuthClient();

    const { tokens } = await oauth2Client.getToken(
      String(code)
    );

    if (!tokens.refresh_token) {
      return res.status(400).send(
        "Google did not return a refresh token. " +
        "Run /connectgmail again and approve access."
      );
    }

    gmailTokens = tokens;

    oauth2Client.setCredentials(tokens);

    res.send(
      "<h2>Gmail connection successful</h2>" +
      "<p>HAS MAT test bot is connected.</p>" +
      "<p>You can return to Telegram and use /checkemail.</p>" +
      "<p>Payment approval and wallet credit remain disabled.</p>"
    );
  } catch (error) {
    console.error("Gmail OAuth error:", error.message);

    res.status(500).send(
      "Gmail connection failed. Check Render logs."
    );
  }
});

// Telegram start
bot.start(async (ctx) => {
  waitingForEmail.delete(ctx.from.id);

  await ctx.reply(
    "Welcome to HAS MAT Payment Testing Bot!\n\n" +
    "Ye sirf testing ke liye hai.\n\n" +
    "Amount enter karein (whole rupees only).\n" +
    "Example: 5\n\n" +
    "/myid - Apna Telegram ID dekhein\n" +
    "/connectgmail - Gmail connect karein\n" +
    "/checkemail - FamApp email check karein\n" +
    "/testemail - Manual sample email test"
  );
});

// Telegram ID
bot.command("myid", async (ctx) => {
  await ctx.reply(
    `Your Telegram ID: ${ctx.from.id}\n\n` +
    "Is ID ko Render ke GMAIL_ADMIN_TELEGRAM_ID variable mein save karein."
  );
});

// Connect Gmail
bot.command("connectgmail", async (ctx) => {
  if (!isGmailAdmin(ctx.from.id)) {
    return ctx.reply(
      "Gmail admin access configured nahi hai."
    );
  }

  if (!gmailConfigured()) {
    return ctx.reply(
      "Google OAuth variables missing hain. Render Environment check karein."
    );
  }

  const state = crypto.randomBytes(24).toString("hex");

  oauthStates.set(state, ctx.from.id);

  const oauth2Client = createOAuthClient();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly"
    ],
    state
  });

  await ctx.reply(
    "Gmail connect karne ke liye ye link kholo:\n\n" +
    authUrl +
    "\n\nSirf apne authorized test Gmail account se login karein. " +
    "Permission screen dhyan se review karein."
  );
});

// Manual email test
bot.command("testemail", async (ctx) => {
  waitingForEmail.add(ctx.from.id);

  await ctx.reply(
    "Redacted FamApp sample email text paste karein.\n\n" +
    "Personal details hide karke sirf test data use karein."
  );
});

// Check Gmail
bot.command("checkemail", async (ctx) => {
  if (!isGmailAdmin(ctx.from.id)) {
    return ctx.reply("Gmail admin access nahi hai.");
  }

  if (!gmailTokens) {
    return ctx.reply(
      "Pehle /connectgmail se Gmail connect karein."
    );
  }

  try {
    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials(gmailTokens);

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    const list = await gmail.users.messages.list({
      userId: "me",
      q: `from:${FAMPAY_SENDER} newer_than:30d`,
      maxResults: 20
    });

    const messages = list.data.messages || [];

    if (messages.length === 0) {
      return ctx.reply(
        "Pichhle 30 din mein FamApp sender se koi email nahi mili."
      );
    }

    let matchedCount = 0;
    let duplicateCount = 0;

    for (const message of messages) {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "full"
      });

      const headers = full.data.payload?.headers || [];

      const fromHeader = headers.find(
        h => h.name.toLowerCase() === "from"
      );

      if (
        !fromHeader ||
        !fromHeader.value.toLowerCase().includes(FAMPAY_SENDER)
      ) {
        continue;
      }

      const emailText = extractEmailBody(
        full.data.payload
      );

      const payment = parseFamPayEmail(emailText);

      if (!payment) continue;

      const transactionKey =
        payment.transactionId || payment.utr;

      if (
        transactionKey &&
        usedTransactions.has(transactionKey)
      ) {
        duplicateCount++;
        continue;
      }

      const pending = [...requests.entries()]
        .reverse()
        .find(([id, item]) =>
          item.userId === ctx.from.id &&
          item.status === "SCREENSHOT_RECEIVED"
        );

      if (!pending) continue;

      const [requestId, request] = pending;

      if (payment.amount !== request.amount) {
        await ctx.reply(
          "FamApp email mili, lekin amount match nahi hua.\n\n" +
          `Request: ₹${request.amount}\n` +
          `Email: ₹${payment.amount}\n` +
          "Status: AMOUNT_MISMATCH\n" +
          "Wallet credit: Disabled"
        );
        continue;
      }

      if (transactionKey) {
        usedTransactions.add(transactionKey);
      }

      request.status = "EMAIL_DETAILS_MATCHED";
      matchedCount++;

      await ctx.reply(
        "FamApp Email Details Matched!\n\n" +
        `Request ID: ${requestId}\n` +
        `Amount: ₹${payment.amount}\n` +
        `Transaction ID: ${payment.transactionId || "Not found"}\n` +
        `UTR: ${payment.utr || "Not found"}\n\n` +
        "Status: EMAIL_DETAILS_MATCHED\n" +
        "Independent bank verification: Not confirmed\n" +
        "Payment approval: Disabled\n" +
        "Wallet credit: Disabled"
      );
    }

    if (matchedCount === 0) {
      await ctx.reply(
        "Email scan complete.\n\n" +
        `FamApp emails found: ${messages.length}\n` +
        `Duplicate emails skipped: ${duplicateCount}\n` +
        "Matching pending request: Not found\n" +
        "Payment approval: Disabled"
      );
    }
  } catch (error) {
    console.error("Gmail check error:", error.message);

    await ctx.reply(
      "Gmail check failed. Render logs check karein."
    );
  }
});

// Text handler
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  if (waitingForEmail.has(userId)) {
    waitingForEmail.delete(userId);

    const payment = parseFamPayEmail(text);

    if (!payment) {
      return ctx.reply(
        "Email format samajh nahi aaya.\nStatus: INVALID_EMAIL"
      );
    }

    const keys = [
      payment.transactionId,
      payment.utr
    ].filter(Boolean);

    if (keys.some(key => usedTransactions.has(key))) {
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
        "Status: AMOUNT_MISMATCH"
      );
    }

    keys.forEach(key => usedTransactions.add(key));
    request.status = "EMAIL_DETAILS_MATCHED";

    return ctx.reply(
      "Email Details Matched!\n\n" +
      `Request ID: ${requestId}\n` +
      `Amount: ₹${payment.amount}\n` +
      `Transaction ID: ${payment.transactionId || "Not found"}\n` +
      `UTR: ${payment.utr || "Not found"}\n\n` +
      "Status: EMAIL_DETAILS_MATCHED\n" +
      "Independent bank verification: Not confirmed\n" +
      "Wallet credit: Disabled"
    );
  }

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
    "Gmail matching ke liye /checkemail use karein.\n" +
    "Manual test ke liye /testemail use karein."
  );
});

// Telegram webhook
app.use(bot.webhookCallback("/telegram"));

async function start() {
  const port = process.env.PORT || 10000;

  await bot.telegram.setWebhook(`${APP_URL}/telegram`);

  app.listen(port, () => {
    console.log(
      `HAS MAT Payment Testing Bot running on port ${port}`
    );
  });
}

start().catch((error) => {
  console.error("Startup error:", error);
  process.exit(1);
});
