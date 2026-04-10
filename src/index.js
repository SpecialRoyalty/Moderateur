require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const bot = require("./bot");
const adminRoutes = require("./admin");
const pool = require("./db");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing");
}

if (!BASE_URL) {
  throw new Error("BASE_URL is missing");
}

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot server is running");
});

app.use((req, res, next) => {
  req.bot = bot;
  next();
});

app.use("/admin", adminRoutes);

const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;

app.use(bot.webhookCallback(WEBHOOK_PATH));

cron.schedule("* * * * *", async () => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM settings
       WHERE group_id = $1
       LIMIT 1`,
      [process.env.GROUP_ID]
    );

    if (result.rows.length === 0) return;

    const settings = result.rows[0];

    if (!settings.auto_message_enabled) return;
    if (!settings.auto_message) return;

    const interval = Number(settings.auto_message_interval_minutes || 30);

    const now = new Date();
    const minute = now.getUTCMinutes();

    if (minute % interval !== 0) return;

    await bot.telegram.sendMessage(process.env.GROUP_ID, settings.auto_message);
    console.log("Auto-message envoyé");
  } catch (e) {
    console.error("Cron error:", e.message);
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    const cleanBaseUrl = BASE_URL.replace(/\/+$/, ""); 
    await bot.telegram.setWebhook(`${cleanBaseUrl}${WEBHOOK_PATH}`);
    console.log("Webhook set:", `${BASE_URL}${WEBHOOK_PATH}`);
  } catch (e) {
    console.error("Webhook setup failed:", e.message);
  }
});
