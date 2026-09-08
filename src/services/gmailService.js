import { google } from "googleapis";

const VNA_OTP_SENDER = "noreply5.lotusmiles@info.vietnamairlines.com";

const VNA_OTP_PATTERN =
  /mật\s+khẩu\s+xác\s+thực\s+OTP.*?là\s*[:：]?\s*(\d{6})/is;

const SIX_DIGIT_PATTERN = /\b(\d{6})\b/;

// ==========================================
// TEMP CACHE
// ==========================================

let lastHistoryId = null;

let latestOtp = null;

let otpExpiredAt = null;

const processedMessageIds = new Set();

// ==========================================
// GMAIL CLIENT
// ==========================================

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

const gmail = google.gmail({
  version: "v1",
  auth: oauth2Client,
});

// ==========================================
// WATCH
// ==========================================

async function watch() {
  const response = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: process.env.GMAIL_TOPIC_NAME,

      labelIds: ["INBOX"],

      labelFilterBehavior: "INCLUDE",
    },
  });

  lastHistoryId = response.data.historyId;

  console.log("Gmail watch registered:", {
    historyId: response.data.historyId,
    expiration: response.data.expiration,
  });

  return response.data;
}

// ==========================================
// PROCESS PUBSUB NOTIFICATION
// ==========================================

async function processNotification(requestBody) {
  const data = requestBody?.message?.data;

  if (!data) {
    console.log("Pub/Sub message data is empty");
    return;
  }

  // ----------------------------------------
  // 1. Decode Pub/Sub message
  // ----------------------------------------

  const decoded = Buffer.from(data, "base64").toString("utf8");

  const notification = JSON.parse(decoded);

  const currentHistoryId = notification.historyId;

  console.log("Gmail notification:", {
    emailAddress: notification.emailAddress,

    historyId: currentHistoryId,
  });

  // ----------------------------------------
  // 2. Có notification
  //    -> search email VNA mới nhất
  // ----------------------------------------

  await processLatestVnaEmails();

  // ----------------------------------------
  // 3. Update historyId
  //    chỉ giữ để log/checkpoint
  // ----------------------------------------

  lastHistoryId = currentHistoryId;
}

// ==========================================
// GET LATEST VNA EMAILS
// ==========================================

async function processLatestVnaEmails() {
  const response = await gmail.users.messages.list({
    userId: "me",

    // Chỉ search mail từ VNA
    // và chỉ mail trong vòng 1 ngày gần nhất
    q: `from:${VNA_OTP_SENDER} newer_than:1d`,

    maxResults: 10,

    includeSpamTrash: false,
  });

  const messages = response.data.messages || [];

  console.log(
    "Latest VNA messageIds:",
    messages.map((message) => message.id),
  );

  if (messages.length === 0) {
    console.log("No Vietnam Airlines emails found");

    return;
  }

  // Gmail thường trả newest trước.
  // Process tất cả message chưa xử lý.
  for (const message of messages) {
    const messageId = message.id;

    if (!messageId) {
      continue;
    }

    if (processedMessageIds.has(messageId)) {
      continue;
    }

    await processMessage(messageId);
  }
}

// ==========================================
// PROCESS MESSAGE
// ==========================================

async function processMessage(messageId) {
  // ----------------------------------------
  // chống duplicate
  // ----------------------------------------

  if (processedMessageIds.has(messageId)) {
    return;
  }

  // ----------------------------------------
  // GET MESSAGE
  // ----------------------------------------

  const response = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const message = response.data;

  const payload = message.payload;

  if (!payload) {
    processedMessageIds.add(messageId);

    return;
  }

  // ----------------------------------------
  // GET HEADER
  // ----------------------------------------

  const headers = payload.headers || [];

  const from = getHeader(headers, "From");

  const subject = getHeader(headers, "Subject");

  const date = getHeader(headers, "Date");

  const to = getHeader(headers, "To");
  const deliveredTo = getHeader(headers, "Delivered-To");
  const originalTo = getHeader(headers, "X-Original-To");

  console.log("Gmail message:", {
    messageId,
    from,
    to,
    date,
    deliveredTo,
    originalTo,
    subject,
  });

  // ----------------------------------------
  // Chỉ xử lý email Vietnam Airlines
  // ----------------------------------------

  if (!from || !from.toLowerCase().includes(VNA_OTP_SENDER.toLowerCase())) {
    processedMessageIds.add(messageId);

    return;
  }

  // ----------------------------------------
  // EXTRACT BODY
  // ----------------------------------------

  const body = extractBody(payload);

  if (!body) {
    console.log("VNA email body is empty", {
      messageId,
    });

    processedMessageIds.add(messageId);

    return;
  }

  // ----------------------------------------
  // EXTRACT OTP
  // ----------------------------------------

  const otp = extractOtp(body);

  if (!otp) {
    console.log("VNA email found but OTP not found", {
      messageId,
    });

    processedMessageIds.add(messageId);

    return;
  }

  // ----------------------------------------
  // CACHE OTP 5 PHÚT
  // ----------------------------------------

  latestOtp = otp;

  otpExpiredAt = Date.now() + 5 * 60 * 1000;

  console.log("Vietnam Airlines OTP received successfully", {
    messageId,
    subject,
  });

  // DEV ONLY
  // Production thì nên bỏ log OTP
  console.log("OTP:", otp);

  // ----------------------------------------
  // MARK PROCESSED
  // ----------------------------------------

  processedMessageIds.add(messageId);
}

// ==========================================
// GET LATEST OTP
// ==========================================

function getLatestOtp() {
  if (!latestOtp) {
    return null;
  }

  // OTP hết hạn
  if (otpExpiredAt && Date.now() > otpExpiredAt) {
    latestOtp = null;
    otpExpiredAt = null;

    return null;
  }

  return latestOtp;
}

// ==========================================
// GET HEADER
// ==========================================

function getHeader(headers, name) {
  const header = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );

  return header?.value || null;
}

// ==========================================
// EXTRACT BODY
// ==========================================

function extractBody(part) {
  if (!part) {
    return null;
  }

  // ----------------------------------------
  // Body trực tiếp
  // ----------------------------------------

  if (part.body?.data) {
    let body = Buffer.from(part.body.data, "base64url").toString("utf8");

    // HTML -> plain text đơn giản
    if (part.mimeType === "text/html") {
      body = body.replace(/<[^>]*>/g, " ");
    }

    return body;
  }

  const parts = part.parts || [];

  // ----------------------------------------
  // Ưu tiên text/plain
  // ----------------------------------------

  for (const child of parts) {
    if (child.mimeType === "text/plain") {
      const body = extractBody(child);

      if (body) {
        return body;
      }
    }
  }

  // ----------------------------------------
  // Recursive fallback
  // ----------------------------------------

  for (const child of parts) {
    const body = extractBody(child);

    if (body) {
      return body;
    }
  }

  return null;
}

// ==========================================
// EXTRACT OTP
// ==========================================

function extractOtp(body) {
  // ----------------------------------------
  // Pattern chính xác của VNA
  // ----------------------------------------

  let matcher = body.match(VNA_OTP_PATTERN);

  if (matcher) {
    return matcher[1];
  }

  // ----------------------------------------
  // Fallback số 6 chữ số
  // ----------------------------------------

  matcher = body.match(SIX_DIGIT_PATTERN);

  if (matcher) {
    return matcher[1];
  }

  return null;
}

// ==========================================
// EXPORT
// ==========================================

export default {
  watch,
  processNotification,
  getLatestOtp,
};
