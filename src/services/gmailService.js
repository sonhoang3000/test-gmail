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
  // 2. Initialize checkpoint
  // ----------------------------------------

  if (!lastHistoryId) {
    lastHistoryId = currentHistoryId;

    console.log("Initialize Gmail historyId:", lastHistoryId);

    return;
  }

  // ----------------------------------------
  // 3. Get history
  // ----------------------------------------

  await processHistory(lastHistoryId);

  // ----------------------------------------
  // 4. Update checkpoint
  // ----------------------------------------

  lastHistoryId = currentHistoryId;
}

// ==========================================
// PROCESS HISTORY
// ==========================================

async function processHistory(previousHistoryId) {
  let pageToken;

  do {
    const response = await gmail.users.history.list({
      userId: "me",

      startHistoryId: previousHistoryId,

      historyTypes: ["messageAdded"],

      pageToken,
    });

    const histories = response.data.history || [];

    for (const history of histories) {
      const messagesAdded = history.messagesAdded || [];

      for (const item of messagesAdded) {
        const messageId = item.message?.id;

        if (!messageId) {
          continue;
        }

        await processMessage(messageId);
      }
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);
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
    return;
  }

  const headers = payload.headers || [];

  const from = getHeader(headers, "From");

  const subject = getHeader(headers, "Subject");

  console.log("Gmail message:", {
    messageId,
    from,
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
  // Extract body
  // ----------------------------------------

  const body = extractBody(payload);

  if (!body) {
    processedMessageIds.add(messageId);

    return;
  }

  // ----------------------------------------
  // Extract OTP
  // ----------------------------------------

  const otp = extractOtp(body);

  if (!otp) {
    console.log("VNA email found but OTP not found");

    processedMessageIds.add(messageId);

    return;
  }

  // ----------------------------------------
  // CACHE OTP 5 phút
  // ----------------------------------------

  latestOtp = otp;

  otpExpiredAt = Date.now() + 5 * 60 * 1000;

  console.log("Vietnam Airlines OTP received successfully", {
    messageId,
  });

  // Chỉ dùng khi DEV
  console.log("OTP:", otp);

  processedMessageIds.add(messageId);
}

// ==========================================
// GET LATEST OTP
// ==========================================

function getLatestOtp() {
  if (!latestOtp) {
    return null;
  }

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

  if (part.body?.data) {
    let body = Buffer.from(part.body.data, "base64url").toString("utf8");

    if (part.mimeType === "text/html") {
      body = body.replace(/<[^>]*>/g, " ");
    }

    return body;
  }

  const parts = part.parts || [];

  // ưu tiên text/plain
  for (const child of parts) {
    if (child.mimeType === "text/plain") {
      const body = extractBody(child);

      if (body) {
        return body;
      }
    }
  }

  // recursive fallback
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

export default {
  watch,
  processNotification,
  getLatestOtp,
};
