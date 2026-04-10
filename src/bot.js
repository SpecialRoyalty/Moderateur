const { Telegraf, Markup } = require("telegraf");
const pool = require("./db");

const bot = new Telegraf(process.env.BOT_TOKEN);
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

/* =========================
   GROUPE ACTIF
========================= */

async function getActiveGroupId() {
  const result = await pool.query(
    `SELECT group_id
     FROM managed_groups
     WHERE is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  return result.rows[0]?.group_id ? String(result.rows[0].group_id) : null;
}

async function getActiveGroupInfo() {
  const result = await pool.query(
    `SELECT group_id, title, is_active
     FROM managed_groups
     WHERE is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function setGroupAsActive(groupId, title = null) {
  await pool.query(
    `UPDATE managed_groups
     SET is_active = false, updated_at = NOW()`
  );

  await pool.query(
    `INSERT INTO managed_groups (group_id, title, is_active, updated_at)
     VALUES ($1, $2, true, NOW())
     ON CONFLICT (group_id)
     DO UPDATE SET
       title = EXCLUDED.title,
       is_active = true,
       updated_at = NOW()`,
    [groupId, title]
  );

  await pool.query(
    `INSERT INTO settings (group_id, updated_at)
     VALUES ($1, NOW())
     ON CONFLICT (group_id)
     DO UPDATE SET updated_at = NOW()`,
    [groupId]
  );
}

async function deactivateGroup(groupId) {
  await pool.query(
    `UPDATE managed_groups
     SET is_active = false, updated_at = NOW()
     WHERE group_id = $1`,
    [groupId]
  );
}

/* =========================
   HELPERS MODERATION
========================= */

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

  return rows.some((row) =>
    normalized.includes(String(row.word).toLowerCase())
  );
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

/* =========================
   MOTS INTERDITS
========================= */

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

/* =========================
   SETTINGS
========================= */

async function setAutoMessage(groupId, enabled, message, intervalMinutes = 30) {
  await pool.query(
    `INSERT INTO settings (
      group_id,
      auto_message,
      auto_message_enabled,
      auto_message_interval_minutes,
      updated_at
    )
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
  const activeGroupId = await getActiveGroupId();

  if (!activeGroupId) {
    throw new Error("Aucun groupe actif");
  }

  await bot.telegram.sendMessage(activeGroupId, message);

  await pool.query(
    `INSERT INTO broadcast_logs (group_id, admin_user_id, message)
     VALUES ($1, $2, $3)`,
    [activeGroupId, adminUserId, message]
  );
}

/* =========================
   REGLE MEDIA AVANT TEXTE
========================= */

async function hasUserSentMedia(groupId, userId) {
  const result = await pool.query(
    `SELECT has_sent_media
     FROM member_media_activity
     WHERE group_id = $1 AND user_id = $2
     LIMIT 1`,
    [groupId, userId]
  );

  return result.rows.length > 0;
}

async function markUserAsMediaSender(groupId, userId) {
  await pool.query(
    `INSERT INTO member_media_activity (group_id, user_id, has_sent_media, first_media_at)
     VALUES ($1, $2, true, NOW())
     ON CONFLICT (group_id, user_id)
     DO NOTHING`,
    [groupId, userId]
  );
}

async function isMediaRequirementEnabled(groupId) {
  const result = await pool.query(
    `SELECT require_media_before_text
     FROM settings
     WHERE group_id = $1
     LIMIT 1`,
    [groupId]
  );

  if (result.rows.length === 0) return false;
  return Boolean(result.rows[0].require_media_before_text);
}

async function setMediaRequirement(groupId, enabled) {
  await pool.query(
    `INSERT INTO settings (
      group_id,
      require_media_before_text,
      updated_at
    )
     VALUES ($1, $2, NOW())
     ON CONFLICT (group_id)
     DO UPDATE SET
       require_media_before_text = EXCLUDED.require_media_before_text,
       updated_at = NOW()`,
    [groupId, enabled]
  );
}

/* =========================
   UI ADMIN
========================= */

function mainAdminKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🏷️ Groupe actif", "admin_active_group")
    ],
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
    ],
    [
      Markup.button.callback("🖼️ Règle média ON", "admin_media_rule_on"),
      Markup.button.callback("🚫 Règle média OFF", "admin_media_rule_off")
    ],
    [
      Markup.button.callback("📊 Statut règle média", "admin_media_rule_status")
    ]
  ]);
}

async function showAdminHome(ctx, extraText = "") {
  const group = await getActiveGroupInfo();

  const groupLine = group
    ? `Groupe actif : ${group.title || "(sans nom)"}`
    : "Groupe actif : aucun";

  const text =
    "╭─── 🛡️ Panneau Admin ───╮\n" +
    "Gère la modération du groupe depuis ce menu.\n\n" +
    `${groupLine}\n\n` +
    "• mots interdits\n" +
    "• broadcast\n" +
    "• message automatique\n" +
    "• règle média avant texte\n" +
    "╰────────────────────╯\n\n" +
    (extraText || "Choisis une action :");

  if (ctx.updateType === "callback_query") {
    return ctx.editMessageText(text, mainAdminKeyboard());
  }

  return ctx.reply(text, mainAdminKeyboard());
}

/* =========================
   CHANGEMENT AUTO DE GROUPE
========================= */

bot.on("my_chat_member", async (ctx) => {
  try {
    const chat = ctx.chat;
    const newStatus = ctx.update.my_chat_member.new_chat_member.status;

    if (chat.type !== "group" && chat.type !== "supergroup") return;

    if (["member", "administrator"].includes(newStatus)) {
      await setGroupAsActive(chat.id, chat.title || null);
      console.log("Nouveau groupe actif :", chat.id, chat.title || "");
      return;
    }

    if (["left", "kicked"].includes(newStatus)) {
      await deactivateGroup(chat.id);
      console.log("Groupe désactivé :", chat.id, chat.title || "");
      return;
    }
  } catch (e) {
    console.error("my_chat_member error:", e.message);
  }
});

/* =========================
   START
========================= */

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
        "• les textes sans participation média\n" +
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

/* =========================
   MENU ADMIN
========================= */

bot.action("admin_active_group", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    const group = await getActiveGroupInfo();

    await ctx.answerCbQuery();

    if (!group) {
      return showAdminHome(ctx, "Aucun groupe actif détecté.");
    }

    return showAdminHome(
      ctx,
      `Groupe actif :\n\nNom : ${group.title || "(sans nom)"}\nID : ${group.group_id}`
    );
  } catch (e) {
    console.error("admin_active_group error:", e.message);
    return ctx.answerCbQuery("Erreur");
  }
});

bot.action("admin_words", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    const activeGroupId = await getActiveGroupId();

    if (!activeGroupId) {
      await ctx.answerCbQuery();
      return showAdminHome(ctx, "Aucun groupe actif détecté.");
    }

    const words = await getForbiddenWords(activeGroupId);

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

    const activeGroupId = await getActiveGroupId();
    if (!activeGroupId) return ctx.answerCbQuery("Aucun groupe actif");

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

    const activeGroupId = await getActiveGroupId();
    if (!activeGroupId) return ctx.answerCbQuery("Aucun groupe actif");

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

    const activeGroupId = await getActiveGroupId();
    if (!activeGroupId) return ctx.answerCbQuery("Aucun groupe actif");

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

    const activeGroupId = await getActiveGroupId();
    if (!activeGroupId) return ctx.answerCbQuery("Aucun groupe actif");

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

    const activeGroupId = await getActiveGroupId();
    if (!activeGroupId) return ctx.answerCbQuery("Aucun groupe actif");

    await setAutoMessage(activeGroupId, false, null, 30);
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

    const activeGroupId = await getActiveGroupId();
    if (!activeGroupId) return ctx.answerCbQuery("Aucun groupe actif");

    const settings = await getSettings(activeGroupId);
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

bot.action("admin_media_rule_on", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    const activeGroupId = await getActiveGroupId();
    if (!activeGroupId) return ctx.answerCbQuery("Aucun groupe actif");

    await setMediaRequirement(activeGroupId, true);
    await ctx.answerCbQuery("Règle activée");

    return showAdminHome(
      ctx,
      "La règle média avant texte est maintenant activée."
    );
  } catch (e) {
    console.error("admin_media_rule_on error:", e.message);
    return ctx.answerCbQuery("Erreur");
  }
});

bot.action("admin_media_rule_off", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    const activeGroupId = await getActiveGroupId();
    if (!activeGroupId) return ctx.answerCbQuery("Aucun groupe actif");

    await setMediaRequirement(activeGroupId, false);
    await ctx.answerCbQuery("Règle désactivée");

    return showAdminHome(
      ctx,
      "La règle média avant texte est maintenant désactivée."
    );
  } catch (e) {
    console.error("admin_media_rule_off error:", e.message);
    return ctx.answerCbQuery("Erreur");
  }
});

bot.action("admin_media_rule_status", async (ctx) => {
  try {
    if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery("Accès refusé");

    const activeGroupId = await getActiveGroupId();
    if (!activeGroupId) return ctx.answerCbQuery("Aucun groupe actif");

    const enabled = await isMediaRequirementEnabled(activeGroupId);

    await ctx.answerCbQuery();
    return showAdminHome(
      ctx,
      enabled
        ? "La règle média avant texte est active."
        : "La règle média avant texte est désactivée."
    );
  } catch (e) {
    console.error("admin_media_rule_status error:", e.message);
    return ctx.answerCbQuery("Erreur");
  }
});

/* =========================
   GESTION TEXTE PRIVE ADMIN
========================= */

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

    const activeGroupId = await getActiveGroupId();

    if (!activeGroupId) {
      adminStates.delete(ctx.from.id);
      return ctx.reply("Aucun groupe actif détecté.");
    }

    const text = ctx.message.text.trim();

    if (state.mode === "await_add_word") {
      await addForbiddenWord(activeGroupId, text);
      adminStates.delete(ctx.from.id);

      await ctx.reply(`✅ Mot ajouté : ${text}`);
      return ctx.reply("Retour au menu admin :", mainAdminKeyboard());
    }

    if (state.mode === "await_del_word") {
      const deleted = await deleteForbiddenWord(activeGroupId, text);
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
      await setAutoMessage(activeGroupId, true, text, 30);
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

/* =========================
   ENREGISTRER MEDIA
========================= */

bot.on(["photo", "video"], async (ctx) => {
  try {
    if (ctx.chat.type === "private") return;

    const activeGroupId = await getActiveGroupId();

    if (!activeGroupId || String(ctx.chat.id) !== String(activeGroupId)) {
      return;
    }

    await markUserAsMediaSender(ctx.chat.id, ctx.from.id);
    console.log(`Media enregistré pour user ${ctx.from.id}`);
  } catch (e) {
    console.error("media handler error:", e.message);
  }
});

/* =========================
   MODERATION GROUPE
========================= */

bot.on("text", async (ctx) => {
  try {
    if (ctx.chat.type === "private") return;

    const activeGroupId = await getActiveGroupId();

    if (!activeGroupId || String(ctx.chat.id) !== String(activeGroupId)) {
      return;
    }

    const userId = ctx.from.id;
    const text = String(ctx.message.text || "");

    console.log("Message reçu:", text);

    const mediaRequirementEnabled = await isMediaRequirementEnabled(ctx.chat.id);

    if (mediaRequirementEnabled && !isAdminUser(ctx.from.id)) {
      const alreadySentMedia = await hasUserSentMedia(ctx.chat.id, userId);

      if (!alreadySentMedia) {
        await deleteMessageSilently(ctx);
        await restrictUserSilently(ctx, userId, 3 * 60);

        const warning = await ctx.reply(
          "Veuillez envoyer un média avant de faire une demande ou un commentaire. Cela participe à l'enrichissement du groupe."
        );

        setTimeout(async () => {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, warning.message_id);
          } catch (e) {
            console.error("warning delete failed:", e.message);
          }
        }, 30000);

        return;
      }
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
