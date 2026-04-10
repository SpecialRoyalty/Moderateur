const { Telegraf, Markup } = require("telegraf");
const pool = require("./db");

const bot = new Telegraf(process.env.BOT_TOKEN);
const GROUP_ID = String(process.env.GROUP_ID || "");

const adminStates = new Map();

function getAdminIds() {
  return String(process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAdminUser(userId) {
  return getAdminIds().includes(String(userId));
}

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

async function getForbiddenWords(groupId) {
  const result = await pool.query(
    `SELECT id, word
     FROM forbidden_words
     WHERE group_id = $1 AND is_active = true
     ORDER BY id DESC`,
    [groupId]
  );

  return result.rows;
}

async function containsForbiddenWord(groupId, text) {
  if (!text) return false;

  const rows = await getForbiddenWords(groupId);
  const normalized = String(text).toLowerCase();

  return rows.some((row) => normalized.includes(String(row.word).toLowerCase()));
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

  const newCount = Number(existing.rows[0].offense_count) + 1;

  await pool.query(
    `UPDATE member_offenses
     SET offense_count = $1, last_offense_at = NOW()
     WHERE id = $2`,
    [newCount, existing.rows[0].id]
  );

  return newCount;
}

async function addForbiddenWord(groupId, word) {
  await pool.query(
    `INSERT INTO forbidden_words (group_id, word, is_active)
     VALUES ($1, $2, true)`,
    [groupId, word]
  );
}

async function deleteForbiddenWord(groupId, word) {
  const result = await pool.query(
    `DELETE FROM forbidden_words
     WHERE group_id = $1 AND LOWER(word) = LOWER($2)`,
    [groupId, word]
  );

  return result.rowCount;
}

async function setAutoMessage(groupId, enabled, message, intervalMinutes = 30) {
  await pool.query(
    `INSERT INTO settings (group_id, auto_message, auto_message_enabled, auto_message_interval_minutes, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (group_id)
     DO UPDATE SET
       auto_message = EXCLUDED.auto_message,
       auto_message_enabled = EXCLUDED.auto_message_enabled,
       auto_message_interval_minutes = EXCLUDED.auto_message_interval_minutes,
       updated_at = NOW()`,
    [groupId, message, enabled, intervalMinutes]
  );
}

async function getSettings(groupId) {
  const result = await pool.query(
    `SELECT *
     FROM settings
     WHERE group_id = $1
     LIMIT 1`,
    [groupId]
  );

  return result.rows[0] || null;
}

async function sendBroadcast(adminUserId, message) {
  await bot.telegram.sendMessage(GROUP_ID, message);

  await pool.query(
    `INSERT INTO broadcast_logs (group_id, admin_user_id, message)
     VALUES ($1, $2, $3)`,
    [GROUP_ID, adminUserId, message]
  );
}

function mainAdminKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📜 Voir les mots", "admin_words"),
      Markup.button.callback("➕ Ajouter mot", "admin_add_word")
    ],
    [
      Markup.button.callback("➖ Supprimer mot", "admin_del_word"),
      Markup.button.callback("📢 Broadcast", "admin_broadcast")
    ],
    [
      Markup.button.callback("✅ Auto-message ON", "admin_automsg_on"),
      Markup.button.callback("⛔ Auto-message OFF", "admin_automsg_off")
    ],
    [
      Markup.button.callback("⚙️ Statut auto-message", "admin_automsg_status")
    ]
  ]);
}

async function showAdminHome(ctx, extraText = "") {
  const text =
    "╭─── 🛡️ Panneau Admin ───╮\n" +
    "Gère la modération du groupe depuis ce menu.\n\n" +
    "• mots interdits\n" +
    "• broadcast\n" +
    "• message automatique\n" +
    "• actions rapides\n" +
    "╰────────────────────╯\n\n" +
    (extraText || "Choisis une action :");

  if (ctx.updateType === "callback_query") {
    return ctx.editMessageText(text, mainAdminKeyboard());
  }

  return ctx.reply(text, mainAdminKeyboard());
}

/* START */

bot.start(async (ctx) => {
  try {
    if (ctx.chat.type !== "private") return;

    if (!isAdminUser(ctx.from.id)) {
      return ctx.reply(
        "╭── 🤖 Bot de modération ──╮\n" +
        "Je protège le groupe contre :\n" +
        "• les mots interdits\n" +
        "• les liens\n" +
        "• les tags de bots\n" +
        "╰────────────────────╯\n\n" +
        "Les fonctions d'administration sont réservées aux admins autorisés."
      );
    }

    adminStates.delete(ctx.from.id);
    return showAdminHome(ctx);
  } catch (e) {
    console.error("/start error:", e.message);
  }
});

/* MENU ADMIN */

bot.action("admin_words", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    const words = await getForbiddenWords(GROUP_ID);

    if (words.length === 0) {
      await ctx.answerCbQuery();
      return showAdminHome(ctx, "Aucun mot interdit enregistré.");
    }

    const list = words.map((w) => `• ${w.word}`).join("\n");

    await ctx.answerCbQuery();
    return showAdminHome(ctx, `Liste actuelle des mots interdits :\n\n${list}`);
  } catch (e) {
    console.error("admin_words error:", e.message);
    return ctx.answerCbQuery("Erreur");
  }
});

bot.action("admin_add_word", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    adminStates.set(ctx.from.id, { mode: "await_add_word" });
    await ctx.answerCbQuery();

    return ctx.reply(
      "➕ Envoi du mot interdit\n\n" +
      "Écris maintenant le mot à ajouter.\n\n" +
      "Exemple :\ncasino"
    );
  } catch (e) {
    console.error("admin_add_word error:", e.message);
  }
});

bot.action("admin_del_word", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    adminStates.set(ctx.from.id, { mode: "await_del_word" });
    await ctx.answerCbQuery();

    return ctx.reply(
      "➖ Suppression d'un mot interdit\n\n" +
      "Écris maintenant le mot à supprimer."
    );
  } catch (e) {
    console.error("admin_del_word error:", e.message);
  }
});

bot.action("admin_broadcast", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    adminStates.set(ctx.from.id, { mode: "await_broadcast" });
    await ctx.answerCbQuery();

    return ctx.reply(
      "📢 Broadcast groupe\n\n" +
      "Envoie maintenant le message à publier dans le groupe."
    );
  } catch (e) {
    console.error("admin_broadcast error:", e.message);
  }
});

bot.action("admin_automsg_on", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    adminStates.set(ctx.from.id, { mode: "await_automsg_text" });
    await ctx.answerCbQuery();

    return ctx.reply(
      "✅ Auto-message\n\n" +
      "Envoie maintenant le texte à publier automatiquement toutes les 30 minutes."
    );
  } catch (e) {
    console.error("admin_automsg_on error:", e.message);
  }
});

bot.action("admin_automsg_off", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    await setAutoMessage(GROUP_ID, false, null, 30);
    await ctx.answerCbQuery("Auto-message désactivé");

    return showAdminHome(ctx, "Le message automatique est maintenant désactivé.");
  } catch (e) {
    console.error("admin_automsg_off error:", e.message);
    return ctx.answerCbQuery("Erreur");
  }
});

bot.action("admin_automsg_status", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    const settings = await getSettings(GROUP_ID);
    const text = settings?.auto_message_enabled
      ? `Auto-message actif.\n\nMessage actuel :\n${settings.auto_message || "(vide)"}`
      : "Auto-message désactivé.";

    await ctx.answerCbQuery();
    return showAdminHome(ctx, text);
  } catch (e) {
    console.error("admin_automsg_status error:", e.message);
    return ctx.answerCbQuery("Erreur");
  }
});

/* GESTION TEXTE PRIVE ADMIN */

bot.on("message", async (ctx, next) => {
  try {
    if (ctx.chat.type !== "private") {
      return next();
    }

    if (!ctx.message.text) {
      return;
    }

    if (!isAdminUser(ctx.from.id)) {
      if (ctx.message.text.startsWith("/")) return next();

      return ctx.reply(
        "Tu n'es pas autorisé à gérer l'administration du bot."
      );
    }

    if (ctx.message.text.startsWith("/")) {
      return next();
    }

    const state = adminStates.get(ctx.from.id);

    if (!state) {
      return ctx.reply(
        "Menu admin disponible ci-dessous.",
        mainAdminKeyboard()
      );
    }

    const text = ctx.message.text.trim();

    if (state.mode === "await_add_word") {
      await addForbiddenWord(GROUP_ID, text);
      adminStates.delete(ctx.from.id);

      await ctx.reply(`✅ Mot ajouté : ${text}`);
      return ctx.reply("Retour au menu admin :", mainAdminKeyboard());
    }

    if (state.mode === "await_del_word") {
      const deleted = await deleteForbiddenWord(GROUP_ID, text);
      adminStates.delete(ctx.from.id);

      if (deleted === 0) {
        await ctx.reply(`Aucun mot trouvé : ${text}`);
      } else {
        await ctx.reply(`✅ Mot supprimé : ${text}`);
      }

      return ctx.reply("Retour au menu admin :", mainAdminKeyboard());
    }

    if (state.mode === "await_broadcast") {
      await sendBroadcast(ctx.from.id, text);
      adminStates.delete(ctx.from.id);

      await ctx.reply("✅ Broadcast envoyé dans le groupe.");
      return ctx.reply("Retour au menu admin :", mainAdminKeyboard());
    }

    if (state.mode === "await_automsg_text") {
      await setAutoMessage(GROUP_ID, true, text, 30);
      adminStates.delete(ctx.from.id);

      await ctx.reply("✅ Auto-message activé.");
      await ctx.reply(`Message enregistré :\n${text}`);
      return ctx.reply("Retour au menu admin :", mainAdminKeyboard());
    }

    return ctx.reply("Action inconnue.", mainAdminKeyboard());
  } catch (e) {
    console.error("private message handler error:", e.message);
  }
});

/* MODERATION GROUPE */

bot.on("text", async (ctx) => {
  try {
    if (ctx.chat.type === "private") return;

    const userId = ctx.from.id;
    const text = String(ctx.message.text || "");

    console.log("Message reçu:", text);

    if (String(ctx.chat.id) !== GROUP_ID) {
      return;
    }

    if (containsRestrictedLink(text)) {
      await deleteMessageSilently(ctx);
      await registerOffense(ctx.chat.id, userId, "link_or_bot_tag");
      await restrictUserSilently(ctx, userId, 7 * 24 * 60 * 60);
      return;
    }

    const hasForbiddenWord = await containsForbiddenWord(ctx.chat.id, text);

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
    console.error("Bot text handler error:", e.message);
  }
});

module.exports = bot;
