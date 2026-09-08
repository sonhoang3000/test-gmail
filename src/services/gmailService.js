import { google } from "googleapis";

const VNA_OTP_SENDER = "noreply5.lotusmiles@info.vietnamairlines.com";

const VNA_OTP_PATTERN =
  /mật\s+khẩu\s+xác\s+thực\s+OTP.*?là\s*[:：]?\s*(\d{6})/is;

const SIX_DIGIT_PATTERN = /\b(\d{6})\b/;

const OTP_TTL_MS = 5 * 60 * 1000;

// ==========================================
// TEMP CACHE
//
// key:
// vu.h.o.angson3000@gmail.com
//
// value:
// {
//   otp: "289984",
//   expiredAt: 123456789
// }
// ==========================================

const otpCache = new Map();

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

  console.log("Gmail watch registered:", {
    historyId: response.data.historyId,

    expiration: response.data.expiration,
  });

  return response.data;
}

// ==========================================
// PROCESS PUB/SUB NOTIFICATION
// ==========================================

async function processNotification(requestBody) {
  const data = requestBody?.message?.data;

  if (!data) {
    console.log("Pub/Sub message data is empty");

    return;
  }

  // ========================================
  // Decode Pub/Sub message
  // ========================================

  const decoded = Buffer.from(data, "base64").toString("utf8");

  const notification = JSON.parse(decoded);

  console.log("Gmail notification:", {
    emailAddress: notification.emailAddress,

    historyId: notification.historyId,
  });

  // ========================================
  // Có Gmail notification
  // -> lấy những mail VNA gần nhất
  // ========================================

  await processLatestVnaEmails();
}

// ==========================================
// SEARCH VNA EMAILS
// ==========================================

async function processLatestVnaEmails() {
  const response = await gmail.users.messages.list({
    userId: "me",

    q: `from:${VNA_OTP_SENDER} ` + "newer_than:1d",

    maxResults: 20,

    includeSpamTrash: false,
  });

  const messages = response.data.messages || [];

  console.log(
    "Latest VNA messageIds:",
    messages.map((message) => message.id),
  );

  if (messages.length === 0) {
    return;
  }

  /*
   * Gmail thường trả newest -> oldest.
   *
   * Ta reverse thành:
   *
   * oldest -> newest
   *
   * để nếu cùng email alias có nhiều OTP
   * thì OTP mới nhất được ghi cuối cùng.
   */
  const orderedMessages = [...messages].reverse();

  for (const message of orderedMessages) {
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
  if (processedMessageIds.has(messageId)) {
    return;
  }

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

  const headers = payload.headers || [];

  // ========================================
  // HEADERS
  // ========================================

  const from = getHeader(headers, "From");

  const to = getHeader(headers, "To");

  const deliveredTo = getHeader(headers, "Delivered-To");

  const originalTo = getHeader(headers, "X-Original-To");

  const subject = getHeader(headers, "Subject");

  const date = getHeader(headers, "Date");

  console.log("Gmail message:", {
    messageId,
    from,
    to,
    deliveredTo,
    originalTo,
    subject,
    date,
  });

  // ========================================
  // Chỉ xử lý VNA
  // ========================================

  if (!from || !from.toLowerCase().includes(VNA_OTP_SENDER.toLowerCase())) {
    processedMessageIds.add(messageId);

    return;
  }

  // ========================================
  // LẤY EMAIL ALIAS NHẬN MAIL
  //
  // Ưu tiên To vì đây thường chính là địa chỉ
  // VNA đã gửi tới:
  //
  // vu.h.o.angson3000@gmail.com
  //
  // chứ không normalize mất dấu "."
  // ========================================

  const recipientEmail = extractRecipientEmail(to, originalTo, deliveredTo);

  if (!recipientEmail) {
    console.log("Cannot determine recipient email", {
      messageId,
      to,
      originalTo,
      deliveredTo,
    });

    processedMessageIds.add(messageId);

    return;
  }

  // ========================================
  // EXTRACT BODY
  // ========================================

  const body = extractBody(payload);

  if (!body) {
    console.log("VNA email body is empty", {
      messageId,
    });

    processedMessageIds.add(messageId);

    return;
  }

  // ========================================
  // EXTRACT OTP
  // ========================================

  const otp = extractOtp(body);

  if (!otp) {
    console.log("VNA email found but OTP not found", {
      messageId,
      recipientEmail,
    });

    processedMessageIds.add(messageId);

    return;
  }

  // ========================================
  // CACHE OTP THEO EMAIL ALIAS
  // ========================================

  const cacheKey = normalizeEmail(recipientEmail);

  otpCache.set(cacheKey, {
    otp,
    expiredAt: Date.now() + OTP_TTL_MS,

    messageId,
  });

  console.log("Vietnam Airlines OTP cached successfully", {
    messageId,
    recipientEmail: cacheKey,
  });

  // DEV ONLY
  console.log("OTP:", otp);

  processedMessageIds.add(messageId);
}

// ==========================================
// GET OTP BY EMAIL
// ==========================================

function getLatestOtp(email) {
  if (!email) {
    return null;
  }

  const normalizedEmail = normalizeEmail(email);

  const cached = otpCache.get(normalizedEmail);

  if (!cached) {
    return null;
  }

  // ========================================
  // Check TTL
  // ========================================

  if (Date.now() > cached.expiredAt) {
    otpCache.delete(normalizedEmail);

    return null;
  }

  return {
    email: normalizedEmail,

    otp: cached.otp,
  };
}

// ==========================================
// NORMALIZE EMAIL
//
// vu.h.o.angson3000
//
// ->
//
// vu.h.o.angson3000@gmail.com
//
// QUAN TRỌNG:
// KHÔNG xóa dấu "."
// ==========================================

function normalizeEmail(email) {
  let value = email.trim().toLowerCase();

  if (!value.includes("@")) {
    value += "@gmail.com";
  }

  return value;
}

// ==========================================
// EXTRACT RECIPIENT EMAIL
// ==========================================

function extractRecipientEmail(to, originalTo, deliveredTo) {
  /*
   * Ưu tiên To.
   *
   * Vì đây thường giữ đúng alias mà bên VNA
   * đã gửi tới.
   */

  const candidates = [to, originalTo, deliveredTo];

  for (const candidate of candidates) {
    const email = extractEmailAddress(candidate);

    if (email) {
      return email;
    }
  }

  return null;
}

// ==========================================
// EXTRACT EMAIL ADDRESS
//
// Input:
//
// Hoang Son <vu.h.o.angson3000@gmail.com>
//
// Output:
//
// vu.h.o.angson3000@gmail.com
// ==========================================

function extractEmailAddress(value) {
  if (!value) {
    return null;
  }

  /*
   * Trường hợp:
   *
   * Name <email@gmail.com>
   */

  const angleMatch = value.match(/<([^<>@\s]+@[^<>@\s]+)>/);

  if (angleMatch) {
    return angleMatch[1].trim().toLowerCase();
  }

  /*
   * Trường hợp:
   *
   * email@gmail.com
   */

  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  if (emailMatch) {
    return emailMatch[0].trim().toLowerCase();
  }

  return null;
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

  // ========================================
  // BODY TRỰC TIẾP
  // ========================================

  if (part.body?.data) {
    let body = Buffer.from(part.body.data, "base64url").toString("utf8");

    if (part.mimeType === "text/html") {
      body = body.replace(/<[^>]*>/g, " ");
    }

    return body;
  }

  const parts = part.parts || [];

  // ========================================
  // ƯU TIÊN TEXT/PLAIN
  // ========================================

  for (const child of parts) {
    if (child.mimeType === "text/plain") {
      const body = extractBody(child);

      if (body) {
        return body;
      }
    }
  }

  // ========================================
  // RECURSIVE FALLBACK
  // ========================================

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
  let matcher = body.match(VNA_OTP_PATTERN);

  if (matcher) {
    return matcher[1];
  }

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
