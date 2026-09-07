import "dotenv/config";
import express from "express";
import gmailController from "./controllers/gmailController.js";

const app = express();

app.use(express.json());

app.use("/api", gmailController);

app.get("/", (req, res) => {
  res.json({
    status: "UP",
    message: "Gmail OTP Service",
  });
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
