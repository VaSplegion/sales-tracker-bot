const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require("discord.js");

// =============================================
// Set these in your .env file or Render/Railway
// environment variables
// =============================================
const BOT_TOKEN     = process.env.BOT_TOKEN;
const CLIENT_ID     = process.env.CLIENT_ID;      // Your bot's application ID
const WATCH_CHANNEL = process.env.WATCH_CHANNEL;  // Channel ID to watch for account embeds
const LB_CHANNEL    = process.env.LB_CHANNEL;     // Channel ID to post the leaderboard
// =============================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ─── In-memory sales store ────────────────────────────────────────────────────
// { userId: { username, tag, count, sales: [{ accountUsername, ownsMC, capes, date, messageId }] } }
const salesData = new Map();

// Track the leaderboard message ID so we can edit it instead of reposting
let leaderboardMessageId = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Parse an embed from the watched channel and extract account info
function parseAccountEmbed(embed) {
  if (!embed || !embed.fields || embed.fields.length === 0) return null;

  const get = (name) => {
    const field = embed.fields.find(f =>
      f.name.toLowerCase().includes(name.toLowerCase())
    );
    return field ? field.value.trim() : "N/A";
  };

  return {
    accountUsername: get("username"),
    ownsMC:          get("owns mc"),
    capes:           get("capes"),
    recoveryCode:    get("recovery"),
    title:           embed.title || "Account",
    securedIn:       embed.title || "",
  };
}

// Record a sale for a user
function recordSale(userId, username, accountInfo, messageId) {
  if (!salesData.has(userId)) {
    salesData.set(userId, { username, count: 0, sales: [] });
  }
  const entry = salesData.get(userId);
  entry.username = username; // keep username fresh
  entry.count++;
  entry.sales.push({
    ...accountInfo,
    date: new Date().toISOString(),
    messageId,
  });
}

// Sort sellers by sale count descending
function getSortedSellers() {
  return [...salesData.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
}

// Build the leaderboard embed
function buildLeaderboardEmbed() {
  const sellers = getSortedSellers();
  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

  const totalSales = [...salesData.values()].reduce((sum, s) => sum + s.count, 0);

  const description = sellers.length === 0
    ? "*No sales recorded yet. Start selling!*"
    : sellers.map(([userId, data], i) =>
        `${medals[i]} <@${userId}> — **${data.count}** sale${data.count !== 1 ? "s" : ""}`
      ).join("\n");

  return new EmbedBuilder()
    .setTitle("🏆 Top Account Sellers")
    .setDescription(description)
    .setColor(0xFFD700)
    .addFields({
      name: "📊 Total Sales",
      value: `**${totalSales}** account${totalSales !== 1 ? "s" : ""} sold`,
      inline: false,
    })
    .setFooter({ text: "Auto-updates after every sale" })
    .setTimestamp();
}

// Post or edit the leaderboard in the LB channel
async function updateLeaderboard(guild) {
  try {
    const lbChannel = await guild.channels.fetch(LB_CHANNEL).catch(() => null);
    if (!lbChannel) return console.error("Leaderboard channel not found.");

    const embed = buildLeaderboardEmbed();

    if (leaderboardMessageId) {
      // Try to edit existing message
      const existing = await lbChannel.messages.fetch(leaderboardMessageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
    }

    // Post fresh leaderboard
    const msg = await lbChannel.send({ embeds: [embed] });
    leaderboardMessageId = msg.id;

  } catch (err) {
    console.error("Failed to update leaderboard:", err);
  }
}

// ─── Scan past messages in the watch channel ──────────────────────────────────
async function scanPastMessages(guild) {
  const watchChannel = await guild.channels.fetch(WATCH_CHANNEL).catch(() => null);
  if (!watchChannel) return console.error("Watch channel not found.");

  console.log("Scanning past messages...");

  let lastId = null;
  let scanned = 0;
  let found = 0;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const messages = await watchChannel.messages.fetch(options).catch(() => null);
    if (!messages || messages.size === 0) break;

    for (const [, msg] of messages) {
      scanned++;

      // Look for embeds that look like account submissions
      for (const embed of msg.embeds) {
        const accountInfo = parseAccountEmbed(embed);
        if (!accountInfo || accountInfo.accountUsername === "N/A") continue;

        // Try to get the interaction user from the message
        // Most bots store the submitter in the embed footer or as the message author
        const submitterId = msg.interaction?.user?.id || msg.author?.id;
        const submitterName = msg.interaction?.user?.username || msg.author?.username || "Unknown";

        if (submitterId) {
          recordSale(submitterId, submitterName, accountInfo, msg.id);
          found++;
        }
      }
    }

    lastId = messages.last()?.id;
    if (messages.size < 100) break;
  }

  console.log(`Scan complete. Scanned ${scanned} messages, found ${found} sales.`);
  await updateLeaderboard(guild);
}

// ─── Register slash commands ──────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription("Show the top account sellers leaderboard")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("mystats")
      .setDescription("Show your personal sales stats")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("scan")
      .setDescription("Re-scan the channel for past sales (admin only)")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("resetsales")
      .setDescription("Reset all sales data (admin only)")
      .addStringOption(opt =>
        opt.setName("confirm")
          .setDescription("Type CONFIRM to reset everything")
          .setRequired(true)
      )
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();

  // Scan all guilds the bot is in
  for (const [, guild] of client.guilds.cache) {
    await scanPastMessages(guild);
  }
});

// Watch for new messages in the watched channel
client.on("messageCreate", async (message) => {
  if (message.channelId !== WATCH_CHANNEL) return;
  if (message.author.bot === false && message.embeds.length === 0) return;

  for (const embed of message.embeds) {
    const accountInfo = parseAccountEmbed(embed);
    if (!accountInfo || accountInfo.accountUsername === "N/A") continue;

    const submitterId = message.interaction?.user?.id || message.author?.id;
    const submitterName = message.interaction?.user?.username || message.author?.username || "Unknown";

    if (!submitterId) continue;

    recordSale(submitterId, submitterName, accountInfo, message.id);
    console.log(`New sale recorded: ${submitterName} sold ${accountInfo.accountUsername}`);

    // Send a confirmation embed in the same channel
    const confirmEmbed = new EmbedBuilder()
      .setDescription(`✅ Sale recorded for <@${submitterId}>! Check the leaderboard.`)
      .setColor(0x23A55A);

    await message.channel.send({ embeds: [confirmEmbed] }).catch(() => {});

    // Update the leaderboard
    await updateLeaderboard(message.guild);
  }
});

// Handle slash commands
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /leaderboard ────────────────────────────────────────────────────────────
  if (commandName === "leaderboard") {
    await interaction.reply({ embeds: [buildLeaderboardEmbed()] });
    await updateLeaderboard(interaction.guild);
  }

  // ── /mystats ─────────────────────────────────────────────────────────────────
  else if (commandName === "mystats") {
    const userId = interaction.user.id;
    const data = salesData.get(userId);

    if (!data || data.count === 0) {
      await interaction.reply({
        content: "You haven't recorded any sales yet!",
        ephemeral: true,
      });
      return;
    }

    const sorted = getSortedSellers();
    const rank = sorted.findIndex(([id]) => id === userId) + 1;

    const recentSales = data.sales
      .slice(-5)
      .reverse()
      .map(s => `• **${s.accountUsername}** — ${new Date(s.date).toLocaleDateString()}`)
      .join("\n");

    const statsEmbed = new EmbedBuilder()
      .setTitle(`📊 Your Sales Stats`)
      .setColor(0x5865F2)
      .addFields(
        { name: "🏆 Rank",        value: `#${rank} of ${salesData.size}`, inline: true },
        { name: "📦 Total Sales", value: `${data.count}`,                 inline: true },
        { name: "🕓 Recent Sales (last 5)", value: recentSales || "None", inline: false }
      )
      .setFooter({ text: interaction.user.username });

    await interaction.reply({ embeds: [statsEmbed], ephemeral: true });
  }

  // ── /scan ─────────────────────────────────────────────────────────────────────
  else if (commandName === "scan") {
    // Admin only check
    if (!interaction.member.permissions.has("Administrator")) {
      await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
      return;
    }

    await interaction.reply({ content: "🔍 Scanning past messages...", ephemeral: true });
    salesData.clear();
    leaderboardMessageId = null;
    await scanPastMessages(interaction.guild);
    await interaction.followUp({ content: "✅ Scan complete! Leaderboard updated.", ephemeral: true });
  }

  // ── /resetsales ───────────────────────────────────────────────────────────────
  else if (commandName === "resetsales") {
    if (!interaction.member.permissions.has("Administrator")) {
      await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
      return;
    }

    const confirm = interaction.options.getString("confirm");
    if (confirm !== "CONFIRM") {
      await interaction.reply({ content: '❌ Type exactly `CONFIRM` to reset.', ephemeral: true });
      return;
    }

    salesData.clear();
    leaderboardMessageId = null;
    await updateLeaderboard(interaction.guild);
    await interaction.reply({ content: "✅ All sales data has been reset.", ephemeral: true });
  }
});

client.login(BOT_TOKEN);
