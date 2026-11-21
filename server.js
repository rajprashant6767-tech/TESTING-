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

// Render Persistent Disk ho to DATA_DIR=/var/data set karein.
// Free ephemeral filesystem par restart ke baad files bachengi nahi.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "payment-test-data.json");
const TOKEN_FILE = path.join(DATA_DIR, "gmail-tokens.json");

if (!TOKEN || !APP_URL) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or APP_URL");
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const bot = new Telegraf(TOKEN);

const requests = new Map();
const usedTransactions = new Set();
const processedEmails = new Set();
const waitingForEmail = new Set();
const oauthStates = new Map();

let gmailTokens = null;
let scanRunning = false;

// ------------------------------
// STORAGE
// ------------------------------

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

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

function saveData() {
  const data = {
    requests: [...requests.entries()],
    usedTransactions: [...usedTransactions],
    processedEmails: [...processedEmails]
  };

  const tempFile = DATA_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function loadGmailTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      gmailTokens = JSON.parse(
        fs.readFileSync(TOKEN_FILE, "utf8")
      );
    }
  } catch (error) {
    console.error("Gmail token load error:", error.message);
  }
}

function saveGmailTokens(tokens) {
  gmailTokens = tokens;

  const tempFile = TOKEN_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(tokens), {
    mode: 0o600
  });
  fs.renameSync(tempFile, TOKEN_FILE);
}

loadData();
loadGmailTokens();

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
  const number = Number(
    String(value || "").replace(/[₹,\s]/g, "")
  );

  return Number.isFinite(number) ? number : null;
}

function transactionKeys(payment) {
  const keys = [];

  if (payment.transactionId) {
    keys.push("TXN:" + normalizeId(payment.transactionId));
  }

  if (payment.utr) {
    keys.push("UTR:" + normalizeId(payment.utr));
  }

  return [...new Set(keys)];
}

// ------------------------------
// DATE / TIME PARSER
// ------------------------------

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
    january: 0, february: 1, march: 2, april: 3,
    may: 4, june: 5, july: 6, august: 7,
    september: 8, october: 9, november: 10, december: 11
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
    date: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

// Screenshot OCR may show "November 20 at 3:14 PM".
function parseScreenshotDateTime(text) {
  const value = String(text || "").replace(/\s+/g, " ");

  const match = value.match(
    /([A-Za-z]+)\s+(\d{1,2})(?:,)?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s+IST)?(?:,?\s+(\d{4}))?/i
  );

  if (!match) return null;

  const year = match[6] || String(new Date().getFullYear());

  return parseDateTime(
    `${match[3]}:${match[4]} ${match[5]} IST, ${match[2]} ${match[1]} ${year}`
  );
}

// ------------------------------
// FAMPAY EMAIL PARSER
// ------------------------------

function parseFamPayEmail(emailText) {
  const text = String(emailText || "")
    .replace(/\s+/g, " ");

  // Only incoming-payment wording is accepted.
  if (!/you have successfully received/i.test(text)) {
    return null;
  }

  const receiverMatch = text.match(
    /Hey\s+([A-Za-z][A-Za-z .'-]{1,70}?)[,\s]+You have successfully received/i
  );

  const amountMatch = text.match(
    /You have successfully received\s*₹\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const transactionMatch = text.match(
    /Transaction\s*ID\s*:\s*([A-Z0-9-]+)/i
  );

  const utrMatch = text.match(
    /\bUTR\s*:\s*(\d{6,})/i
  );

  const dateMatch = text.match(
    /Date\s*:\s*(\d{1,2}:\d{2}\s*(?:AM|PM)\s*IST[,\s]+\d{1,2}\s+[A-Za-z]+\s+\d{4})/i
  );

  if (!receiverMatch || !amountMatch || !dateMatch) {
    return null;
  }

  const amount = normalizeAmount(amountMatch[1]);
  const dateTime = parseDateTime(dateMatch[1]);

  if (amount === null || !dateTime) return null;

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

    for (const child of part.parts || []) {
      walk(child);
    }
  }

  walk(payload);

  return plainText.trim()
    ? plainText
    : stripHtml(htmlText);
}

// ------------------------------
// SCREENSHOT OCR
// ------------------------------

async function readScreenshot(fileId) {
  const fileLink = await bot.telegram.getFileLink(fileId);

  const response = await fetch(fileLink.href);

  if (!response.ok) {
    throw new Error("Telegram screenshot download failed");
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  const result = await Tesseract.recognize(buffer, "eng");

  return result.data.text || "";
}

function parseScreenshot(text) {
  const value = String(text || "");

  const amountMatch = value.match(
    /₹\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const receiverMatch = value.match(
    /(?:Hey\s+)?([A-Za-z][A-Za-z .'-]{1,60})\s*(?:\n|$)/i
  );

  const transactionMatch = value.match(
    /(?:Transaction\s*ID|Ref(?:erence)?\s*ID)\s*:?\s*([A-Z0-9-]+)/i
  );

  const utrMatch = value.match(
    /\bUTR\s*:?\s*(\d{6,})/i
  );

  const dateTime = parseScreenshotDateTime(value);

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
    time: dateTime?.time || null,
    rawText: value
  };
}

// ------------------------------
// FIELD COMPARISON
// ------------------------------

function comparePayment(request, email, screenshot) {
  const checks = [];

  function add(label, passed, reason) {
    checks.push({
      label,
      passed: Boolean(passed),
      reason
    });
  }

  add(
    "Receiver name",
    normalizeName(email.receiver) === normalizeName(REQUIRED_RECEIVER) &&
    normalizeName(screenshot.receiver) === normalizeName(REQUIRED_RECEIVER),
    "Receiver must be " + REQUIRED_RECEIVER
  );

  add(
    "Amount",
    email.amount === request.amount &&
    screenshot.amount === request.amount &&
    email.amount === screenshot.amount,
    "Request, email and screenshot amounts must be equal"
  );

  add(
    "Date",
    Boolean(email.date && screenshot.date) &&
    email.date === screenshot.date,
    "Email and screenshot dates must match"
  );

  add(
    "Time",
    Boolean(email.time && screenshot.time) &&
    email.time === screenshot.time,
    "Email and screenshot times must match"
  );

  const emailIds = transactionKeys(email);
  const screenshotIds = transactionKeys(screenshot);

  const identifierMatch = emailIds.some(key =>
    screenshotIds.includes(key)
  );

  add(
    "Transaction ID / UTR",
    emailIds.length > 0 &&
    screenshotIds.length > 0 &&
    identifierMatch,
    "At least one email identifier must match screenshot"
  );

  return checks;
}

function getPendingRequests() {
  return [...requests.entries()]
    .filter(([id, item]) =>
      item.status === "SCREENSHOT_RECEIVED"
    )
    .reverse();
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
      return res.status(500).send("Google OAuth variables missing.");
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
    const result = await oauth2Client.getToken(String(code));

    if (!result.tokens.refresh_token) {
      return res.status(400).send(
        "Refresh token not received. Revoke this app's access in Google Account permissions and connect again."
      );
    }

    saveGmailTokens(result.tokens);

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
    console.error("Gmail OAuth error:", error.message);
    res.status(500).send("Gmail connection failed. Check Render logs.");
  }
});

// ------------------------------
// START COMMAND
// ------------------------------

bot.start(async (ctx) => {
  waitingForEmail.delete(ctx.from.id);

  await ctx.reply(
    "Welcome to HAS MAT Payment Testing Bot!\n\n" +
    "Testing only. No payment approval or wallet credit.\n\n" +
    "Amount enter karein (whole rupees only).\n\n" +
    "Example: 5\n\n" +
    "Commands:\n" +
    "/myid - Telegram ID\n" +
    "/connectgmail - Gmail connect (admin)\n" +
    "/checkemail - FamApp email scan (admin)\n" +
    "/testemail - Manual email parser test (admin)"
  );
});

// ------------------------------
// TELEGRAM ID
// ------------------------------

bot.command("myid", async (ctx) => {
  await ctx.reply(`Your Telegram ID: ${ctx.from.id}`);
});

// ------------------------------
// CONNECT GMAIL
// ------------------------------

bot.command("connectgmail", async (ctx) => {
  if (!isGmailAdmin(ctx.from.id)) {
    return ctx.reply("Gmail admin access nahi hai.");
  }

  if (!gmailConfigured()) {
    return ctx.reply("Google OAuth environment variables missing hain.");
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
    "\n\nGoogle permission screen ko review karein."
  );
});

// ------------------------------
// CHECK EMAIL
// ------------------------------

bot.command("checkemail", async (ctx) => {
  if (!isGmailAdmin(ctx.from.id)) {
    return ctx.reply("Gmail admin access nahi hai.");
  }

  if (scanRunning) {
    return ctx.reply("Email scan already running. Thoda wait karein.");
  }

  if (!gmailTokens) {
    return ctx.reply(
      "Gmail connection available nahi hai.\n" +
      "Pehle /connectgmail karein."
    );
  }

  scanRunning = true;

  try {
    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials(gmailTokens);

    oauth2Client.on("tokens", (tokens) => {
      const updated = {
        ...gmailTokens,
        ...tokens
      };
      saveGmailTokens(updated);
    });

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    const response = await gmail.users.messages.list({
      userId: "me",
      q: `from:${FAMPAY_SENDER} newer_than:30d`,
      maxResults: 30
    });

    const messages = response.data.messages || [];

    if (!messages.length) {
      return ctx.reply(
        "FamApp incoming emails found: 0\nEmail scan complete."
      );
    }

    let matchedCount = 0;
    let duplicateCount = 0;
    let ignoredCount = 0;
    let unreadableCount = 0;
    let mismatchCount = 0;

    for (const message of messages) {
      if (processedEmails.has(message.id)) {
        ignoredCount++;
        continue;
      }

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
        ignoredCount++;
        processedEmails.add(message.id);
        continue;
      }

      const emailText = extractEmailBody(full.data.payload);
      const payment = parseFamPayEmail(emailText);

      if (!payment) {
        ignoredCount++;
        processedEmails.add(message.id);
        continue;
      }

      const keys = transactionKeys(payment);

      if (
        keys.length &&
        keys.some(key => usedTransactions.has(key))
      ) {
        duplicateCount++;
        processedEmails.add(message.id);
        continue;
      }

      const candidates = getPendingRequests();

      if (!candidates.length) {
        ignoredCount++;
        processedEmails.add(message.id);
        continue;
      }

      let foundCandidate = null;
      let foundChecks = null;

      for (const [requestId, request] of candidates) {
        if (!request.screenshotFileId) continue;

        let screenshotText;

        try {
          screenshotText = await readScreenshot(
            request.screenshotFileId
          );
        } catch (error) {
          console.error("OCR error:", error.message);
          continue;
        }

        const screenshot = parseScreenshot(screenshotText);
        const checks = comparePayment(
          request,
          payment,
          screenshot
        );

        if (checks.every(check => check.passed)) {
          foundCandidate = {
            requestId,
            request,
            screenshot
          };
          foundChecks = checks;
          break;
        }
      }

      if (!foundCandidate) {
        // Do not spam users with every unrelated FamApp email.
        ignoredCount++;
        processedEmails.add(message.id);
        continue;
      }

      // Reserve both identifiers before changing request status.
      // This protects against reuse within this running process.
      if (
        keys.length === 0 ||
        keys.some(key => usedTransactions.has(key))
      ) {
        duplicateCount++;
        processedEmails.add(message.id);
        continue;
      }

      for (const key of keys) {
        usedTransactions.add(key);
      }

      const { requestId, request } = foundCandidate;

      request.status = "EMAIL_SCREENSHOT_MATCHED";
      request.matchedAt = new Date().toISOString();
      request.emailMessageId = message.id;
      request.matchedTransactionKeys = keys;

      processedEmails.add(message.id);
      saveData();

      matchedCount++;

      await ctx.telegram.sendMessage(
        request.userId,
        "Testing details matched!\n\n" +
        `Request ID: ${requestId}\n` +
        `Amount: ₹${payment.amount}\n` +
        `Receiver: ${payment.receiver}\n` +
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
      `Matched: ${matchedCount}\n` +
      `Duplicates skipped: ${duplicateCount}\n` +
      `Unrelated/old emails ignored: ${ignoredCount}\n` +
      `Unreadable emails: ${unreadableCount}\n` +
      `Mismatches: ${mismatchCount}\n\n` +
      "Payment approval: Disabled\n" +
      "Wallet credit: Disabled"
    );
  } catch (error) {
    console.error("Gmail check error:", error.message);

    await ctx.reply(
      "Gmail check failed.\nRender logs check karein."
    );
  } finally {
    scanRunning = false;
  }
});

// ------------------------------
// MANUAL EMAIL TEST
// ------------------------------

bot.command("testemail", async (ctx) => {
  if (!isGmailAdmin(ctx.from.id)) {
    return ctx.reply("Admin access nahi hai.");
  }

  waitingForEmail.add(ctx.from.id);

  await ctx.reply(
    "Redacted FamApp sample email text paste karein.\n" +
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

  if (waitingForEmail.has(userId)) {
    if (!isGmailAdmin(userId)) {
      waitingForEmail.delete(userId);
      return ctx.reply("Admin access nahi hai.");
    }

    waitingForEmail.delete(userId);

    const payment = parseFamPayEmail(text);

    if (!payment) {
      return ctx.reply(
        "FamApp email format incomplete ya unreadable hai.\n" +
        "Required: receiver, amount, date, time and ID/UTR."
      );
    }

    return ctx.reply(
      "Email parser result:\n\n" +
      `Receiver: ${payment.receiver}\n` +
      `Amount: ₹${payment.amount}\n` +
      `Date: ${payment.date}\n` +
      `Time: ${payment.time} IST\n` +
      `Transaction ID: ${payment.transactionId || "Not found"}\n` +
      `UTR: ${payment.utr || "Not found"}\n\n` +
      "This is parser testing only. No payment approval."
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

  saveData();

  await ctx.reply(
    "Test Request Created\n\n" +
    `Request ID: ${requestId}\n` +
    `Amount: ₹${amount}\n\n` +
    "Ab FamApp payment notification ka screenshot bhejein.\n" +
    "Real payment approval aur wallet credit disabled hain."
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
      (
        item.status === "AWAITING_SCREENSHOT" ||
        item.status === "SCREENSHOT_NEEDS_REUPLOAD"
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
    "Status: Pending email and screenshot matching.\n\n" +
    "Admin email scan ke liye /checkemail use kare."
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
