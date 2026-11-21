const express = require("express");
const { Telegraf } = require("telegraf");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const Tesseract = require("tesseract.js");

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
const REQUIRED_RECEIVER = "Prashant Raj";

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "data");

const DATA_FILE = path.join(DATA_DIR, "payment-data.json");
const TOKEN_FILE = path.join(DATA_DIR, "gmail-tokens.json");

if (!TOKEN || !APP_URL) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or APP_URL");
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const bot = new Telegraf(TOKEN);

const requests = new Map();
const usedTransactions = new Set();
const processedEmails = new Set();
const oauthStates = new Map();
const waitingForEmail = new Set();

let gmailTokens = null;
let scanRunning = false;

// ---------------------------------
// STORAGE
// ---------------------------------

function saveData() {
  const data = {
    requests: [...requests.entries()],
    usedTransactions: [...usedTransactions],
    processedEmails: [...processedEmails]
  };

  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, DATA_FILE);
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    for (const item of data.requests || []) {
      requests.set(item[0], item[1]);
    }

    for (const key of data.usedTransactions || []) {
      usedTransactions.add(key);
    }

    for (const id of data.processedEmails || []) {
      processedEmails.add(id);
    }
  } catch (error) {
    console.error("Data load error:", error.message);
  }
}

function saveGmailTokens(tokens) {
  gmailTokens = tokens;

  const temp = TOKEN_FILE + ".tmp";

  fs.writeFileSync(
    temp,
    JSON.stringify(tokens),
    { mode: 0o600 }
  );

  fs.renameSync(temp, TOKEN_FILE);
}

function loadGmailTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      gmailTokens = JSON.parse(
        fs.readFileSync(TOKEN_FILE, "utf8")
      );
    }
  } catch (error) {
    console.error("Token load error:", error.message);
  }
}

loadData();
loadGmailTokens();

// ---------------------------------
// BASIC HELPERS
// ---------------------------------

function isAdmin(userId) {
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

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeId(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeAmount(value) {
  const n = Number(
    String(value || "").replace(/[₹,\s]/g, "")
  );

  return Number.isFinite(n) ? n : null;
}

function transactionKeys(payment) {
  const result = [];

  if (payment.transactionId) {
    result.push(
      "TXN:" + normalizeId(payment.transactionId)
    );
  }

  if (payment.utr) {
    result.push(
      "UTR:" + normalizeId(payment.utr)
    );
  }

  return [...new Set(result)];
}

// ---------------------------------
// DATE AND TIME
// ---------------------------------

function parseDateTime(value) {
  if (!value) return null;

  const text = String(value)
    .replace(/\s+/g, " ")
    .trim();

  const match = text.match(
    /(\d{1,2}):(\d{2})\s*(AM|PM)\s*(?:IST)?[,\s]+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i
  );

  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const ampm = match[3].toUpperCase();
  const day = Number(match[4]);
  const monthName = match[5].toLowerCase();
  const year = Number(match[6]);

  const months = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11
  };

  const month = months[monthName];

  if (
    month === undefined ||
    hour < 1 || hour > 12 ||
    minute < 0 || minute > 59 ||
    day < 1 || day > 31
  ) {
    return null;
  }

  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  return {
    date:
      `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time:
      `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

function parseScreenshotDateTime(text) {
  const match = String(text || "").match(
    /([A-Za-z]+)\s+(\d{1,2})(?:,)?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s+IST)?(?:,?\s+(\d{4}))?/i
  );

  if (!match) return null;

  const year = match[6] || String(new Date().getFullYear());

  return parseDateTime(
    `${match[3]}:${match[4]} ${match[5]} IST, ${match[2]} ${match[1]} ${year}`
  );
}

// ---------------------------------
// EMAIL PARSER
// ---------------------------------

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    );
}

function parseFamPayEmail(emailText) {
  const text = decodeEntities(
    String(emailText || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();

  if (!/you have successfully received/i.test(text)) {
    return null;
  }

  const receiverMatch = text.match(
    /Hey\s+(.{2,70}?),\s*You have successfully received/i
  );

  const amountMatch = text.match(
    /You have successfully received\s*₹\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const transactionMatch = text.match(
    /Transaction\s*ID\s*:\s*([A-Z0-9-]+)/i
  );

  const utrMatch = text.match(
    /\bUTR(?:\s*ID)?\s*:\s*(\d{6,})/i
  );

  const dateMatch = text.match(
    /Date\s*:\s*(\d{1,2}:\d{2}\s*(?:AM|PM)\s*IST[,\s]+\d{1,2}\s+[A-Za-z]+\s+\d{4})/i
  );

  if (!receiverMatch || !amountMatch || !dateMatch) {
    return null;
  }

  const dateTime = parseDateTime(dateMatch[1]);
  const amount = normalizeAmount(amountMatch[1]);

  if (!dateTime || amount === null) return null;

  const payment = {
    receiver: receiverMatch[1].trim(),
    amount,
    transactionId: transactionMatch
      ? transactionMatch[1].trim()
      : null,
    utr: utrMatch ? utrMatch[1].trim() : null,
    date: dateTime.date,
    time: dateTime.time
  };

  if (!payment.transactionId && !payment.utr) {
    return null;
  }

  return payment;
}

// ---------------------------------
// EMAIL BODY
// ---------------------------------

function decodeBase64Url(value) {
  if (!value) return "";

  return Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

function stripHtml(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ");
}

function extractEmailBody(payload) {
  let plain = "";
  let html = "";

  function walk(part) {
    if (!part) return;

    if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);

      if (part.mimeType === "text/plain") {
        plain += decoded + "\n";
      }

      if (part.mimeType === "text/html") {
        html += decoded + "\n";
      }
    }

    for (const child of part.parts || []) {
      walk(child);
    }
  }

  walk(payload);

  return plain.trim() ? plain : stripHtml(html);
}

// ---------------------------------
// SCREENSHOT OCR
// ---------------------------------

async function readScreenshot(fileId) {
  const url = await bot.telegram.getFileLink(fileId);
  const response = await fetch(url.href);

  if (!response.ok) {
    throw new Error("Screenshot download failed");
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  const result = await Tesseract.recognize(
    buffer,
    "eng"
  );

  return result.data.text || "";
}

function parseScreenshot(text) {
  const value = String(text || "");

  const amountMatch = value.match(
    /₹\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const transactionMatch = value.match(
    /(?:Transaction\s*ID|Ref(?:erence)?\s*ID)\s*:?\s*([A-Z0-9-]+)/i
  );

  const utrMatch = value.match(
    /\bUTR\s*:?\s*(\d{6,})/i
  );

  const dateTime = parseScreenshotDateTime(value);

  // Avoid guessing a receiver from arbitrary first OCR line.
  const receiverMatch = value.match(
    /(?:receiver|received by|to)\s*:?\s*([A-Za-z][A-Za-z .'-]{1,60})/i
  );

  return {
    amount: amountMatch
      ? normalizeAmount(amountMatch[1])
      : null,
    receiver: receiverMatch
      ? receiverMatch[1].trim()
      : null,
    transactionId: transactionMatch
      ? transactionMatch[1].trim()
      : null,
    utr: utrMatch ? utrMatch[1].trim() : null,
    date: dateTime?.date || null,
    time: dateTime?.time || null
  };
}

// ---------------------------------
// MATCHING
// ---------------------------------

function comparePayment(request, email, screenshot) {
  const checks = [];

  checks.push({
    field: "Receiver",
    ok:
      normalizeName(email.receiver) ===
        normalizeName(REQUIRED_RECEIVER) &&
      normalizeName(screenshot.receiver) ===
        normalizeName(REQUIRED_RECEIVER)
  });

  checks.push({
    field: "Amount",
    ok:
      email.amount === request.amount &&
      screenshot.amount === request.amount &&
      email.amount === screenshot.amount
  });

  checks.push({
    field: "Date",
    ok:
      Boolean(email.date && screenshot.date) &&
      email.date === screenshot.date
  });

  checks.push({
    field: "Time",
    ok:
      Boolean(email.time && screenshot.time) &&
      email.time === screenshot.time
  });

  const emailKeys = transactionKeys(email);
  const screenshotKeys = transactionKeys(screenshot);

  checks.push({
    field: "Transaction ID / UTR",
    ok:
      emailKeys.length > 0 &&
      screenshotKeys.length > 0 &&
      emailKeys.some(key => screenshotKeys.includes(key))
  });

  return checks;
}

function getPendingRequests() {
  return [...requests.entries()]
    .filter(([id, item]) =>
      item.status === "SCREENSHOT_RECEIVED"
    )
    .reverse();
}

// ---------------------------------
// HEALTH
// ---------------------------------

app.get("/", (req, res) => {
  res.send("HAS MAT Payment Testing Bot is running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    gmailConnected: Boolean(gmailTokens),
    persistentDirectory: DATA_DIR
  });
});

// ---------------------------------
// GMAIL OAUTH CALLBACK
// ---------------------------------

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

    const client = createOAuthClient();
    const result = await client.getToken(String(code));

    if (!result.tokens.refresh_token) {
      return res.status(400).send(
        "Refresh token not received. Reconnect Gmail and review Google's permission screen."
      );
    }

    saveGmailTokens(result.tokens);

    res.send(
      "<h2>Gmail connection successful</h2>" +
      "<p>Return to Telegram and use /checkemail.</p>" +
      "<p>Payment approval and wallet credit are disabled.</p>"
    );
  } catch (error) {
    console.error("OAuth error:", error.message);
    res.status(500).send("Gmail connection failed.");
  }
});

// ---------------------------------
// START
// ---------------------------------

bot.start(async ctx => {
  await ctx.reply(
    "HAS MAT Payment Testing Bot\n\n" +
    "Testing only. No payment approval or wallet credit.\n\n" +
    "Amount enter karein. Example: 5\n\n" +
    "/myid - Telegram ID\n" +
    "/connectgmail - Admin Gmail connection\n" +
    "/checkemail - Admin FamApp scan\n" +
    "/testemail - Admin email parser test"
  );
});

bot.command("myid", async ctx => {
  await ctx.reply(`Your Telegram ID: ${ctx.from.id}`);
});

// ---------------------------------
// CONNECT GMAIL
// ---------------------------------

bot.command("connectgmail", async ctx => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply("Admin access nahi hai.");
  }

  if (!gmailConfigured()) {
    return ctx.reply("Google OAuth variables missing hain.");
  }

  const state = crypto.randomBytes(24).toString("hex");
  oauthStates.set(state, ctx.from.id);

  const client = createOAuthClient();

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly"
    ],
    state
  });

  await ctx.reply(
    "Gmail connect link:\n\n" + authUrl
  );
});

// ---------------------------------
// CHECK EMAIL
// ---------------------------------

bot.command("checkemail", async ctx => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply("Admin access nahi hai.");
  }

  if (scanRunning) {
    return ctx.reply("Scan already running. Wait karein.");
  }

  if (!gmailTokens) {
    return ctx.reply(
      "Gmail connected nahi hai. /connectgmail karein."
    );
  }

  scanRunning = true;

  try {
    const client = createOAuthClient();
    client.setCredentials(gmailTokens);

    client.on("tokens", tokens => {
      saveGmailTokens({
        ...gmailTokens,
        ...tokens
      });
    });

    const gmail = google.gmail({
      version: "v1",
      auth: client
    });

    const response = await gmail.users.messages.list({
      userId: "me",
      q: `from:${FAMPAY_SENDER} newer_than:30d`,
      maxResults: 30
    });

    const messages = response.data.messages || [];

    let matched = 0;
    let duplicates = 0;
    let unrelated = 0;
    let unreadable = 0;
    let mismatches = 0;
    let noPending = 0;

    for (const message of messages) {
      if (processedEmails.has(message.id)) {
        unrelated++;
        continue;
      }

      const full = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "full"
      });

      const headers = full.data.payload?.headers || [];

      const from = headers.find(
        h => h.name.toLowerCase() === "from"
      );

      if (
        !from ||
        !from.value.toLowerCase().includes(FAMPAY_SENDER)
      ) {
        unrelated++;
        processedEmails.add(message.id);
        saveData();
        continue;
      }

      const text = extractEmailBody(full.data.payload);
      const payment = parseFamPayEmail(text);

      if (!payment) {
        unreadable++;
        // Keep email eligible for retry after parser improvements.
        continue;
      }

      const keys = transactionKeys(payment);

      if (
        keys.length &&
        keys.some(key => usedTransactions.has(key))
      ) {
        duplicates++;
        processedEmails.add(message.id);
        saveData();
        continue;
      }

      const candidates = getPendingRequests();

      if (!candidates.length) {
        noPending++;
        // Do not mark processed: a later request may be checked.
        continue;
      }

      let matchedRequest = null;
      let lastChecks = null;

      for (const [requestId, request] of candidates) {
        if (!request.screenshotFileId) continue;

        let ocrText;

        try {
          ocrText = await readScreenshot(
            request.screenshotFileId
          );
        } catch (error) {
          console.error("OCR error:", error.message);
          continue;
        }

        const screenshot = parseScreenshot(ocrText);
        const checks = comparePayment(
          request,
          payment,
          screenshot
        );

        if (checks.every(check => check.ok)) {
          matchedRequest = {
            requestId,
            request,
            screenshot
          };
          lastChecks = checks;
          break;
        }

        lastChecks = checks;
      }

      if (!matchedRequest) {
        // Do not mark as processed; allow retry.
        mismatches++;
        continue;
      }

      // Re-check all keys immediately before reserving.
      if (
        keys.length === 0 ||
        keys.some(key => usedTransactions.has(key))
      ) {
        duplicates++;
        processedEmails.add(message.id);
        saveData();
        continue;
      }

      for (const key of keys) {
        usedTransactions.add(key);
      }

      const { requestId, request } = matchedRequest;

      request.status = "EMAIL_SCREENSHOT_MATCHED";
      request.matchedAt = new Date().toISOString();
      request.emailMessageId = message.id;
      request.matchedTransactionKeys = keys;

      processedEmails.add(message.id);
      saveData();

      matched++;

      await ctx.telegram.sendMessage(
        request.userId,
        "Testing details matched!\n\n" +
        `Request ID: ${requestId}\n` +
        `Receiver: ${payment.receiver}\n` +
        `Amount: ₹${payment.amount}\n` +
        `Date: ${payment.date}\n` +
        `Time: ${payment.time} IST\n` +
        `Transaction ID: ${payment.transactionId || "Not found"}\n` +
        `UTR: ${payment.utr || "Not found"}\n\n` +
        "Status: EMAIL_SCREENSHOT_MATCHED\n" +
        "Independent bank verification: NOT CONFIRMED\n" +
        "Payment approval: DISABLED\n" +
        "Wallet credit: DISABLED"
      );
    }

    saveData();

    await ctx.reply(
      "Email Scan Complete!\n\n" +
      `FamApp emails found: ${messages.length}\n` +
      `Matched: ${matched}\n` +
      `Duplicates skipped: ${duplicates}\n` +
      `Unrelated/previously processed: ${unrelated}\n` +
      `Unreadable emails: ${unreadable}\n` +
      `Mismatches: ${mismatches}\n` +
      `No pending request: ${noPending}\n\n` +
      "Payment approval: Disabled\n" +
      "Wallet credit: Disabled"
    );
  } catch (error) {
    console.error("Gmail scan error:", error.message);

    await ctx.reply(
      "Gmail scan failed. Render logs check karein."
    );
  } finally {
    scanRunning = false;
  }
});

// ---------------------------------
// MANUAL EMAIL PARSER TEST
// ---------------------------------

bot.command("testemail", async ctx => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply("Admin access nahi hai.");
  }

  waitingForEmail.add(ctx.from.id);

  await ctx.reply(
    "Redacted FamApp email ka complete text paste karein."
  );
});

// ---------------------------------
// TEXT HANDLER
// ---------------------------------

bot.on("text", async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  if (waitingForEmail.has(userId)) {
    if (!isAdmin(userId)) {
      waitingForEmail.delete(userId);
      return ctx.reply("Admin access nahi hai.");
    }

    waitingForEmail.delete(userId);

    const payment = parseFamPayEmail(text);

    if (!payment) {
      return ctx.reply(
        "Email parser could not read required fields.\n" +
        "Required: receiver, amount, date, time and ID/UTR."
      );
    }

    return ctx.reply(
      "Email Parser Result\n\n" +
      `Receiver: ${payment.receiver}\n` +
      `Amount: ₹${payment.amount}\n` +
      `Date: ${payment.date}\n` +
      `Time: ${payment.time} IST\n` +
      `Transaction ID: ${payment.transactionId || "Not found"}\n` +
      `UTR: ${payment.utr || "Not found"}\n\n` +
      "Parser test only. No payment approval."
    );
  }

  const amount = normalizeAmount(text);

  if (
    amount === null ||
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > 100000
  ) {
    return ctx.reply(
      "Valid whole amount enter karein. Example: 5"
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

  saveData();

  await ctx.reply(
    "Test Request Created\n\n" +
    `Request ID: ${requestId}\n` +
    `Amount: ₹${amount}\n\n` +
    "FamApp notification screenshot bhejein.\n" +
    "Approval and wallet credit disabled."
  );
});

// ---------------------------------
// PHOTO HANDLER
// ---------------------------------

bot.on("photo", async ctx => {
  const userId = ctx.from.id;

  const pending = [...requests.entries()]
    .reverse()
    .find(([id, item]) =>
      item.userId === userId &&
      (
        item.status === "AWAITING_SCREENSHOT" ||
        item.status === "SCREENSHOT_RECEIVED"
      )
    );

  if (!pending) {
    return ctx.reply(
      "Pehle amount request banayein."
    );
  }

  const [requestId, request] = pending;

  request.screenshotFileId =
    ctx.message.photo[
      ctx.message.photo.length - 1
    ].file_id;

  request.status = "SCREENSHOT_RECEIVED";

  saveData();

  await ctx.reply(
    "Screenshot received.\n\n" +
    `Request ID: ${requestId}\n` +
    `Amount: ₹${request.amount}\n` +
    "Admin can now use /checkemail."
  );
});

// ---------------------------------
// WEBHOOK
// ---------------------------------

app.use(bot.webhookCallback("/telegram"));

// ---------------------------------
// SERVER START
// ---------------------------------

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
