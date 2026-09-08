import express from "express";
import gmailService from "../services/gmailService.js";

const router = express.Router();

// ==========================================
// PUB/SUB WEBHOOK
// ==========================================

router.post("/webhook/gmail", async (req, res) => {
  try {
    await gmailService.processNotification(req.body);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Gmail webhook error:", error);

    // Return 500 để Pub/Sub retry
    return res.sendStatus(500);
  }
});

// ==========================================
// REGISTER GMAIL WATCH
// ==========================================

router.post("/gmail/watch", async (req, res) => {
  try {
    const response = await gmailService.watch();

    return res.json({
      success: true,
      historyId: response.historyId,
      expiration: response.expiration,
    });
  } catch (error) {
    console.error("Gmail watch error:", error.response?.data || error);

    return res.status(500).json({
      success: false,
      message: error.response?.data || error.message,
    });
  }
});

// ==========================================
// GET OTP BY EMAIL
//
// VD:
// /api/gmail/otp?email=vu.h.o.angson3000
//
// hoặc
//
// /api/gmail/otp?email=vu.h.o.angson3000@gmail.com
// ==========================================

router.get("/gmail/otp", (req, res) => {
  const email = req.query.email;

  if (!email) {
    return res.status(400).json({
      message: "email is required",
    });
  }

  const result = gmailService.getLatestOtp(email);

  if (!result) {
    return res.status(404).json({
      message: "OTP not found",
      email,
    });
  }

  return res.json({
    email: result.email,
    otp: result.otp,
  });
});

export default router;
