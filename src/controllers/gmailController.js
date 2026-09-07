import express from "express";
import gmailService from "../services/gmailService.js";

const router = express.Router();

// Pub/Sub gọi vào đây
router.post("/webhook/gmail", async (req, res) => {
  try {
    await gmailService.processNotification(req.body);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Gmail webhook error:", error);

    // Pub/Sub sẽ retry khi nhận status lỗi
    return res.sendStatus(500);
  }
});

// Đăng ký Gmail Watch
router.post("/gmail/watch", async (req, res) => {
  try {
    const response = await gmailService.watch();

    return res.json({
      success: true,
      historyId: response.historyId,
      expiration: response.expiration,
    });
  } catch (error) {
    console.error("Gmail watch error:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Lấy OTP mới nhất
router.get("/gmail/otp", (req, res) => {
  const otp = gmailService.getLatestOtp();

  if (!otp) {
    return res.status(404).json({
      message: "OTP not found",
    });
  }

  return res.json({
    otp,
  });
});

export default router;
