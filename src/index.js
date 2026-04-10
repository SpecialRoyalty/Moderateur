require("dotenv").config();

const express = require("express");
const bot = require("./bot");
const adminRoutes = require("./admin");
const cron = require("node-cron");
const pool = require("./db");

const app = express();
app.use(express.json());

// Inject bot dans req
app.use((req, res, next) => {
  req.bot = bot;
  next();
});

app.use("/admin", adminRoutes);

// Auto message toutes les 30 min
cron.schedule("*/30 * * * *", async () => {
  const res = await pool.query("SELECT * FROM settings LIMIT 1");

  if (res.rows.length === 0) return;

  const settings = res.rows[0];

  if (settings.auto_message_enabled && settings.auto_message) {
    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      settings.auto_message
    );
  }
});

// Start bot
bot.launch();

// Start server
app.listen(process.env.PORT, () => {
  console.log("Server running");
});
