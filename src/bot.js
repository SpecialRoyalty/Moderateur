const { Telegraf } = require("telegraf");
const pool = require("./db");

const bot = new Telegraf(process.env.BOT_TOKEN);
const GROUP_ID = String(process.env.GROUP_ID);

function containsRestrictedLink(text) {
  if (!text) return false;

  const patterns = [
    /https?:\/\/\S+/i,
    /t\.me\/\S+/i,
    /telegram\.me\/\S+/i,
    /www\.\S+\.\S+/i,
    /\b\S+\.(com|net|org|io|me|gg|co|fr|ru|xyz)\b/i,
    /@\w*bot\b/i
  ];

  return patterns.some((pattern) => pattern.test(text));
}

async function getForbiddenWords() {
  const result = await pool.query(
    `SELECT word
     FROM forbidden_words
     WHERE group_id = $1 AND is_active = true`,
    [GROUP_ID]
  );
  return result.rows.map((row) => row.word.toLowerCase());
}

async function containsForbiddenWord(text) {
  if (!text) return false;

  const words = await getForbiddenWords();
  const normalized = text.toLowerCase();

  return words.some((word) => normalized.includes(word));
}

async function deleteMessageSilently(ctx) {
  try {
    await ctx.deleteMessage();
  } catch (e) {
    console.error("Delete message failed:", e.message);
  }
}

async function restrictUserSilently(ctx, userId, seconds) {
  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false
      },
      until_date: Math.floor(Date.now() / 1000) + seconds
    });
  } catch (e) {
    console.error("Restrict failed:", e.message);
  }
}

async function registerOffense(groupId, userId, offenseType) {
  const existing = await pool.query(
    `SELECT id, offense_count
     FROM member_offenses
     WHERE group_id = $1 AND user_id = $2 AND offense_type = $3`,
    [groupId, userId, offenseType]
  );

  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO member_offenses (group_id, user_id, offense_type, offense_count, last_offense_at)
       VALUES ($1, $2, $3, 1, NOW())`,
      [groupId, userId, offenseType]
    );
    return 1;
  }

  const newCount = existing.rows[0].offense_count + 1;

  await pool.query(
    `UPDATE member_offenses
     SET offense_count = $1, last_offense_at = NOW()
     WHERE id = $2`,
    [newCount, existing.rows[0].id]
  );

  return newCount;
}

bot.on("text", async (ctx) => {
  try {
    if (String(ctx.chat.id) !== GROUP_ID) return;
    if (!ctx.message || !ctx.message.text) return;

    const userId = ctx.from.id;
    const text = ctx.message.text;

    console.log("Message reçu:", text);

    if (containsRestrictedLink(text)) {
      await deleteMessageSilently(ctx);
      await registerOffense(ctx.chat.id, userId, "link_or_bot_tag");
      await restrictUserSilently(ctx, userId, 7 * 24 * 60 * 60);
      return;
    }

    const hasForbiddenWord = await containsForbiddenWord(text);

    if (hasForbiddenWord) {
      await deleteMessageSilently(ctx);

      const count = await registerOffense(ctx.chat.id, userId, "forbidden_word");

      if (count === 1) {
        await restrictUserSilently(ctx, userId, 60 * 60);
      } else {
        await restrictUserSilently(ctx, userId, 7 * 24 * 60 * 60);
      }
    }
  } catch (e) {
    console.error("Bot text handler error:", e);
  }
});

module.exports = bot;
