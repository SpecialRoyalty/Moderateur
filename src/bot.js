const { Telegraf } = require("telegraf");
const pool = require("./db");

const bot = new Telegraf(process.env.BOT_TOKEN);

const GROUP_ID = process.env.GROUP_ID;

// Vérifier liens ou bots
function containsLink(text) {
  return /(https?:\/\/|t\.me|telegram\.me|@\w+bot)/i.test(text);
}

// Vérifier mots interdits
async function containsForbiddenWord(text) {
  const res = await pool.query(
    "SELECT word FROM forbidden_words WHERE is_active = true"
  );

  return res.rows.some(row =>
    text.toLowerCase().includes(row.word.toLowerCase())
  );
}

// Gérer les sanctions
async function handleOffense(ctx, type) {
  const userId = ctx.from.id;

  const result = await pool.query(
    `SELECT * FROM member_offenses 
     WHERE user_id=$1 AND offense_type=$2`,
    [userId, type]
  );

  if (result.rows.length === 0) {
    await pool.query(
      `INSERT INTO member_offenses (group_id, user_id, offense_type)
       VALUES ($1,$2,$3)`,
      [GROUP_ID, userId, type]
    );

    // 1h
    await ctx.restrictChatMember(userId, {
      permissions: {},
      until_date: Math.floor(Date.now() / 1000) + 3600
    });

  } else {
    await pool.query(
      `UPDATE member_offenses 
       SET offense_count = offense_count + 1 
       WHERE user_id=$1 AND offense_type=$2`,
      [userId, type]
    );

    // 1 semaine
    await ctx.restrictChatMember(userId, {
      permissions: {},
      until_date: Math.floor(Date.now() / 1000) + 604800
    });
  }
}

// Listener messages
bot.on("text", async (ctx) => {
  if (ctx.chat.id.toString() !== GROUP_ID) return;

  const text = ctx.message.text;

  if (containsLink(text)) {
    await handleOffense(ctx, "link_or_bot_tag");
    return;
  }

  if (await containsForbiddenWord(text)) {
    await handleOffense(ctx, "forbidden_word");
  }
});

module.exports = bot;
