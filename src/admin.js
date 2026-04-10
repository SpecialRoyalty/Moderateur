const express = require("express");
const pool = require("./db");

const router = express.Router();

function isAdmin(req, res, next) {
  const adminId = String(req.headers["x-admin-id"] || "");
  const allowed = String(process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!allowed.includes(adminId)) {
    return res.status(403).json({ error: "Access denied" });
  }

  req.adminId = adminId;
  next();
}

router.get("/", (req, res) => {
  res.send("Admin API OK");
});

router.get("/words", isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, word, is_active, created_at
       FROM forbidden_words
       WHERE group_id = $1
       ORDER BY id DESC`,
      [process.env.GROUP_ID]
    );

    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch words" });
  }
});

router.post("/words", isAdmin, async (req, res) => {
  try {
    const { word } = req.body;

    if (!word || !String(word).trim()) {
      return res.status(400).json({ error: "word is required" });
    }

    await pool.query(
      `INSERT INTO forbidden_words (group_id, word, is_active)
       VALUES ($1, $2, true)`,
      [process.env.GROUP_ID, String(word).trim()]
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to add word" });
  }
});

router.delete("/words/:id", isAdmin, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM forbidden_words
       WHERE id = $1 AND group_id = $2`,
      [req.params.id, process.env.GROUP_ID]
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete word" });
  }
});

router.post("/broadcast", isAdmin, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    await req.bot.telegram.sendMessage(process.env.GROUP_ID, String(message));

    await pool.query(
      `INSERT INTO broadcast_logs (group_id, admin_user_id, message)
       VALUES ($1, $2, $3)`,
      [process.env.GROUP_ID, req.adminId, String(message)]
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Broadcast failed" });
  }
});

router.get("/settings", isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM settings
       WHERE group_id = $1
       LIMIT 1`,
      [process.env.GROUP_ID]
    );

    res.json(result.rows[0] || null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.post("/settings/auto-message", isAdmin, async (req, res) => {
  try {
    const { auto_message, auto_message_enabled, auto_message_interval_minutes } = req.body;

    await pool.query(
      `UPDATE settings
       SET auto_message = $1,
           auto_message_enabled = $2,
           auto_message_interval_minutes = $3,
           updated_at = NOW()
       WHERE group_id = $4`,
      [
        auto_message || null,
        Boolean(auto_message_enabled),
        Number(auto_message_interval_minutes || 30),
        process.env.GROUP_ID
      ]
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

module.exports = router;
