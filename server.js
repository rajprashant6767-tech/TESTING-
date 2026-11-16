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

const GMAIL_ADMIN_TELEGRAM_ID =
  process.env.GMAIL_ADMIN_TELEGRAM_ID;

const FAMPAY_SENDER = "no-reply@famapp.in";

if (!TOKEN || !APP_URL) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or APP_URL");
}

const bot = new Telegraf(TOKEN);

// Temporary storage.
// Render restart par data clear ho jayega.
const requests = new Map();
const usedTransactions = new Set();
const waitingForEmail = new Set();
const oauthStates = new Map();

let gmailTokens = null;

// ------------------------------
// BASIC HELPERS
// ------------------------------

function isGmailAdmin(userId) {
  return Boolean(
    GMAIL_ADMIN_TELEGRAM_ID &&
    String(userId) === String(GMAIL_ADMIN_TELEGRAM_ID)
  );
}

function gmailConfigured() {
  return Boolean(
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET &&
    GOOGLE_REDIRECT_URI
  );
}

function createOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function transactionKeys(payment) {
  const keys = [];

  if (payment.transactionId) {
    keys.push("TXN:" + payment.transactionId);
  }

  if (payment.utr) {
    keys.push("UTR:" + payment.utr);
  }

  return keys;
}

// ------------------------------
// FAMPAY EMAIL PARSER
// ------------------------------

function parseFamPayEmail(emailText) {
  const amountMatch = emailText.match(
    /successfully received[\s\S]{0,250}?₹\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const transactionMatch = emailText.match(
    /Transaction\s*ID\s*:\s*([A-Z0-9-]+)/i
  );

  const utrMatch = emailText.match(
    /\bUTR(?:\s*ID)?\s*:\s*(\d+)/i
  );

  if (!amountMatch) {
    return null;
  }

  const amount = Number(
    amountMatch[1].replace(/,/g, "")
  );

  if (!Number.isFinite(amount)) {
    return null;
  }

  return {
    amount,
    transactionId: transactionMatch
      ? transactionMatch[1].trim()
      : null,
    utr: utrMatch
      ? utrMatch[1].trim()
      : null
  };
}

// ------------------------------
// EMAIL BODY EXTRACTION
// ------------------------------

function decodeBase64Url(value) {
  if (!value) return "";

  return Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ");
}

function extractEmailBody(payload) {
  let plainText = "";
  let htmlText = "";

  function walk(part) {
    if (!part) return;

    if (part.body && part.body.data) {
      const decoded = decodeBase64Url(part.body.data);

      if (part.mimeType === "text/plain") {
        plainText += decoded + "\n";
      }

      if (part.mimeType === "text/html") {
        htmlText += decoded + "\n";
      }
    }

    if (part.parts) {
      for (const child of part.parts) {
        walk(child);
      }
    }
  }

  walk(payload);

  if (plainText.trim()) {
    return plainText;
  }

  return stripHtml(htmlText);
}

// ------------------------------
// HEALTH ROUTES
// ------------------------------

app.get("/", (req, res) => {
  res.send("HAS MAT Payment Testing Bot is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ------------------------------
// GMAIL OAUTH CALLBACK
// ------------------------------

app.get("/gmail/oauth2callback", async (req, res) => {
  try {
    if (!gmailConfigured()) {
      return res.status(500).send(
        "Google OAuth variables missing."
      );
    }

    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(
        "Google authorization was not completed."
      );
    }

    if (!code || !state || !oauthStates.has(String(state))) {
      return res.status(400).send(
        "Invalid or expired OAuth state. Run /connectgmail again."
      );
    }

    oauthStates.delete(String(state));

    const oauth2Client = createOAuthClient();

    const result = await oauth2Client.getToken(
      String(code)
    );

    const tokens = result.tokens;

    if (!tokens.refresh_token) {
      return res.status(400).send(
        "Refresh token not received. Run /connectgmail again " +
        "and review Google's permission screen."
      );
    }

    gmailTokens = tokens;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Gmail Connected</title>
      </head>
      <body>
        <h2>Gmail connection successful</h2>
        <p>HAS MAT test bot is connected.</p>
        <p>Return to Telegram and use /checkemail.</p>
        <p>Payment approval and wallet credit remain disabled.</p>
      </body>
      </html>
    `);

  } catch (error) {
    console.error(
      "Gmail OAuth error:",
      error.message
    );

    res.status(500).send(
      "Gmail connection failed. Check Render logs."
    );
  }
});

// ------------------------------
// START COMMAND
// ------------------------------

bot.start(async (ctx) => {
  waitingForEmail.delete(ctx.from.id);

  await ctx.reply(
    "Welcome to HAS MAT Payment Testing Bot!\n\n" +
    "Ye sirf testing ke liye hai.\n\n" +
    "Amount enter karein (whole rupees only).\n\n" +
    "Example: 5\n\n" +
    "Commands:\n" +
    "/myid - Telegram ID\n" +
    "/connectgmail - Gmail connect\n" +
    "/checkemail - FamApp email scan\n" +
    "/testemail - Manual email test"
  );
});

// ------------------------------
// TELEGRAM ID
// ------------------------------

bot.command("myid", async (ctx) => {
  await ctx.reply(
    `Your Telegram ID: ${ctx.from.id}`
  );
});

// ------------------------------
// CONNECT GMAIL
// ------------------------------

bot.command("connectgmail", async (ctx) => {
  if (!isGmailAdmin(ctx.from.id)) {
    return ctx.reply(
      "Gmail admin access configured nahi hai."
    );
  }

  if (!gmailConfigured()) {
    return ctx.reply(
      "Google OAuth environment variables missing hain."
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
    "Gmail connect karne ke liye link kholo:\n\n" +
    authUrl +
    "\n\nGoogle permission screen ko dhyan se review karein."
  );
});

// ------------------------------
// CHECK FAMPAY EMAILS
// ------------------------------

bot.command("checkemail", async (ctx) => {
  if (!isGmailAdmin(ctx.from.id)) {
    return ctx.reply("Gmail admin access nahi hai.");
  }

  if (!gmailTokens) {
    return ctx.reply(
      "Gmail connection available nahi hai.\n" +
      "Pehle /connectgmail karein."
    );
  }

  try {
    const oauth2Client = createOAuthClient();

    oauth2Client.setCredentials(gmailTokens);

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    const response = await gmail.users.messages.list({
      userId: "me",
      q: `from:${FAMPAY_SENDER} newer_than:30d`,
      maxResults: 20
    });

    const messages = response.data.messages || [];

    if (messages.length === 0) {
      return ctx.reply(
        "FamApp emails found: 0\n" +
        "Email scan complete."
      );
    }

    let matchedCount = 0;
    let duplicateCount = 0;
    let mismatchCount = 0;
    let unreadableCount = 0;

    for (const message of messages) {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "full"
      });

      const headers =
        full.data.payload?.headers || [];

      const fromHeader = headers.find(
        h => h.name.toLowerCase() === "from"
      );

      if (
        !fromHeader ||
        !fromHeader.value
          .toLowerCase()
          .includes(FAMPAY_SENDER)
      ) {
        continue;
      }

      const emailText = extractEmailBody(
        full.data.payload
      );

      const payment = parseFamPayEmail(emailText);

      if (!payment) {
        unreadableCount++;
        continue;
      }

      const keys = transactionKeys(payment);

      if (
        keys.length > 0 &&
        keys.some(key => usedTransactions.has(key))
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

      if (!pending) {
        continue;
      }

      const [requestId, request] = pending;

      if (payment.amount !== request.amount) {
        mismatchCount++;

        await ctx.reply(
          "FamApp email mili, lekin amount match nahi hua.\n\n" +
          `Request: ₹${request.amount}\n` +
          `Email: ₹${payment.amount}\n` +
          "Status: AMOUNT_MISMATCH\n" +
          "Payment approval: Disabled\n" +
          "Wallet credit: Disabled"
        );

        continue;
      }

      keys.forEach(key => usedTransactions.add(key));

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

    await ctx.reply(
      "Email Scan Complete!\n\n" +
      `FamApp emails found: ${messages.length}\n` +
      `Matched: ${matchedCount}\n` +
      `Duplicates skipped: ${duplicateCount}\n` +
      `Amount mismatches: ${mismatchCount}\n` +
      `Unreadable emails: ${unreadableCount}\n\n` +
      "Payment approval: Disabled\n" +
      "Wallet credit: Disabled"
    );

  } catch (error) {
    console.error(
      "Gmail check error:",
      error.message
    );

    await ctx.reply(
      "Gmail check failed.\n" +
      "Render logs check karein."
    );
  }
});

// ------------------------------
// MANUAL EMAIL TEST
// ------------------------------

bot.command("testemail", async (ctx) => {
  waitingForEmail.add(ctx.from.id);

  await ctx.reply(
    "Redacted FamApp sample email text paste karein.\n\n" +
    "Personal details hide karke test data use karein."
  );
});

// ------------------------------
// TEXT HANDLER
// ------------------------------

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  // Manual email parsing
  if (waitingForEmail.has(userId)) {
    waitingForEmail.delete(userId);

    const payment = parseFamPayEmail(text);

    if (!payment) {
      return ctx.reply(
        "Email format samajh nahi aaya.\n" +
        "Status: INVALID_EMAIL"
      );
    }

    const keys = transactionKeys(payment);

    if (
      keys.some(key => usedTransactions.has(key))
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
      return ctx.reply(
        "Status: NO_PENDING_REQUEST"
      );
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
      "Payment approval: Disabled\n" +
      "Wallet credit: Disabled"
    );
  }

  // Amount request
  const amount = Number(text);

  if (
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > 100000
  ) {
    return ctx.reply(
      "Valid whole amount enter karein.\n" +
      "Example: 5"
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

  await ctx.reply(
    "Test Request Created\n\n" +
    `Request ID: ${requestId}\n` +
    `Amount: ₹${amount}\n\n` +
    "Ab test screenshot bhejein.\n" +
    "Real payment aur wallet credit enabled nahi hai."
  );
});

// ------------------------------
// SCREENSHOT HANDLER
// ------------------------------

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
    ctx.message.photo[
      ctx.message.photo.length - 1
    ].file_id;

  request.status = "SCREENSHOT_RECEIVED";

  await ctx.reply(
    "Screenshot Received!\n\n" +
    `Request ID: ${requestId}\n` +
    `Amount: ₹${request.amount}\n` +
    "Status: Pending Verification\n\n" +
    "Gmail test ke liye /checkemail bhejein."
  );
});

// ------------------------------
// TELEGRAM WEBHOOK
// ------------------------------

app.use(bot.webhookCallback("/telegram"));

// ------------------------------
// START SERVER
// ------------------------------

async function start() {
  const port = process.env.PORT || 10000;

  await bot.telegram.setWebhook(
    `${APP_URL}/telegram`
  );

  app.listen(port, () => {
    console.log(
      `HAS MAT Payment Testing Bot running on port ${port}`
    );
  });
}

start().catch(error => {
  console.error("Startup error:", error);
  process.exit(1);
});
