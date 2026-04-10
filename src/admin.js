const express = require("express");
const pool = require("./db");

const router = express.Router();

function isAdmin(req, res, next) {
  const userId = req.headers["x-admin-id"];
  const allowed = process.env.ADMIN_IDS.split(",");

  if (!allowed.includes(userId)) {
    return res.status(403).send("Not allowed");
  }

  next();
}

// Ajouter mot interdit
router.post("/words", isAdmin, async (req, res) => {
  const { word } = req.body;

  await pool.query(
    "INSERT INTO forbidden_words (word, group_id) VALUES ($1,$2)",
    [word, process.env.GROUP_ID]
  );

  res.send("OK");
});

// Liste mots
router.get("/words", isAdmin, async (req, res) => {
  const result = await pool.query("SELECT * FROM forbidden_words");
  res.json(result.rows);
});

// Broadcast
router.post("/broadcast", isAdmin, async (req, res) => {
  const { message } = req.body;

  await req.bot.telegram.sendMessage(process.env.GROUP_ID, message);

  await pool.query(
    "INSERT INTO broadcast_logs (group_id, admin_user_id, message) VALUES ($1,$2,$3)",
    [process.env.GROUP_ID, req.headers["x-admin-id"], message]
  );

  res.send("sent");
});

module.exports = router;
