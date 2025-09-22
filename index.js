import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionFlagsBits
} from 'discord.js';
import db from './db.js';
import { parseDuration } from './util.js';

// ---- Env helpers ------------------------------------------------------------
function envSnowflake(name) {
  const raw = process.env[name] ?? '';
  const v = raw.split('#')[0].trim(); // strip inline comments
  if (!/^\d{17,20}$/.test(v)) {
    throw new Error(`${name} is invalid: "${raw}"`);
  }
  return v;
}

const DEFAULT_CHANNEL_ID = process.env.DEFAULT_CHANNEL_ID
  ? envSnowflake('DEFAULT_CHANNEL_ID')
  : null;

// ---- Client -----------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers // needed for role / join-age checks
  ],
  partials: [Partials.GuildMember]
});

const timers = new Map(); // giveawayId -> timeout

function hasManagerPerm(member) {
  const roleId = process.env.GIVEAWAY_MANAGER_ROLE_ID;
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (roleId && member.roles.cache.has(roleId)) return true;
  return false;
}

async function postGiveaway(g) {
  const channel = await client.channels.fetch(g.channel_id);
  const embed = new EmbedBuilder()
    .setTitle(`🎁 Giveaway: ${g.prize}`)
    .setDescription(
      `Ends: <t:${Math.floor(g.end_at / 1000)}:R>\nWinners: **${g.winners_count}**\n` +
      (g.required_role_id ? `Required role: <@&${g.required_role_id}>\n` : '') +
      (g.min_server_age_days ? `Min server age: ${g.min_server_age_days}d\n` : '') +
      (g.min_account_age_days ? `Min account age: ${g.min_account_age_days}d\n` : '') +
      `\nGiveaway ID: **${g.id}**`
    )
    .setColor(0x00ae86)
    .setTimestamp(new Date(g.end_at));

  const btn = new ButtonBuilder()
    .setCustomId(`enter_${g.id}`)
    .setLabel('Enter')
    .setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(btn);

  const msg = await channel.send({ embeds: [embed], components: [row] });
  db.prepare('UPDATE giveaways SET message_id=? WHERE id=?').run(msg.id, g.id);

  scheduleEnd(g.id, Math.max(0, g.end_at - Date.now()));
}

function scheduleEnd(id, delay) {
  clearTimer(id);
  const t = setTimeout(() => finalizeGiveaway(id).catch(console.error), delay);
  timers.set(id, t);
}
function clearTimer(id) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

function pickRandom(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// finalize: end the giveaway, pick winners if any, and announce
// Returns { status: 'ended'|'already_ended'|'not_found', winners: string[], reason?: 'no_entries' }
async function finalizeGiveaway(id, rerollCount = 0) {
  const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
  if (!g) return { status: 'not_found', winners: [] };
  if (g.status !== 'ACTIVE') return { status: 'already_ended', winners: [] };

  const entries = db.prepare('SELECT user_id FROM entries WHERE giveaway_id=?').all(id).map(r => r.user_id);
  const alreadyWon = new Set(db.prepare('SELECT user_id FROM winners WHERE giveaway_id=?').all(id).map(r => r.user_id));
  const pool = entries.filter(u => !alreadyWon.has(u));
  const winnersNeeded = rerollCount || g.winners_count;

  const ch = await client.channels.fetch(g.channel_id).catch(() => null);

  if (!pool.length) {
    db.prepare("UPDATE giveaways SET status='ENDED' WHERE id=?").run(id);
    clearTimer(id);
    if (ch) ch.send(`No valid entries for **${g.prize}** (ID ${id}).`);
    return { status: 'ended', winners: [], reason: 'no_entries' };
  }

  const winners = pickRandom(pool, Math.min(winnersNeeded, pool.length));

  const insert = db.prepare('INSERT OR REPLACE INTO winners (giveaway_id, user_id, notified) VALUES (?,?,0)');
  const tx = db.transaction(ws => ws.forEach(u => insert.run(id, u)));
  tx(winners);

  db.prepare("UPDATE giveaways SET status='ENDED' WHERE id=?").run(id);
  clearTimer(id);

  if (ch) ch.send({
    content: `🎉 **Winners for** *${g.prize}* (ID ${id}):\n${winners.map(u => `• <@${u}>`).join('\n')}\nStaff will send a Steam gift directly.`
  });

  return { status: 'ended', winners };
}

// Prefer clientReady (v14 deprecation-safe)
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const active = db.prepare("SELECT * FROM giveaways WHERE status='ACTIVE'").all();
  for (const g of active) {
    const remaining = Math.max(0, g.end_at - Date.now());
    scheduleEnd(g.id, remaining);
  }
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'giveaway') {
      const sub = i.options.getSubcommand();

      // ---- start ------------------------------------------------------------
      if (sub === 'start') {
        if (!hasManagerPerm(i.member)) return i.reply({ content: 'No permission.', flags: 64 });
        const prize = i.options.getString('prize', true);
        const durationStr = i.options.getString('duration', true);
        const winners = i.options.getInteger('winners', true);
        const requiredRole = i.options.getRole('required_role');
        const minServerAge = i.options.getInteger('min_server_age_days') ?? Number(process.env.MIN_SERVER_AGE_DAYS || 0);
        const minAccountAge = i.options.getInteger('min_account_age_days') ?? Number(process.env.MIN_ACCOUNT_AGE_DAYS || 0);
        const channel = i.options.getChannel('channel') || (DEFAULT_CHANNEL_ID ? await client.channels.fetch(DEFAULT_CHANNEL_ID) : i.channel);

        const durMs = parseDuration(durationStr);
        if (!durMs || durMs < 60_000) return i.reply({ content: 'Duration must be >= 1 minute.', flags: 64 });

        const endAt = Date.now() + durMs;
        const info = db.prepare(
          `INSERT INTO giveaways (guild_id, channel_id, prize, winners_count, required_role_id, min_server_age_days, min_account_age_days, started_at, end_at, status)
           VALUES (?,?,?,?,?,?,?,?,?, 'ACTIVE')`
        ).run(
          i.guild.id, channel.id, prize, winners, requiredRole?.id ?? null, minServerAge, minAccountAge, Date.now(), endAt
        );
        const id = info.lastInsertRowid;

        await i.reply({ content: `Giveaway **${prize}** started (ID ${id}). Posting...`, flags: 64 });
        await postGiveaway({
          id, guild_id: i.guild.id, channel_id: channel.id, prize,
          winners_count: winners, required_role_id: requiredRole?.id ?? null,
          min_server_age_days: minServerAge, min_account_age_days: minAccountAge,
          started_at: Date.now(), end_at: endAt
        });
      }

      // ---- end --------------------------------------------------------------
      if (sub === 'end') {
        if (!hasManagerPerm(i.member)) return i.reply({ content: 'No permission.', flags: 64 });
        try { await i.deferReply({ flags: 64 }); } catch {}
        try {
          const id = i.options.getInteger('id', true);
          const result = await finalizeGiveaway(id);
          let msg;
          if (result.status === 'not_found') msg = `Giveaway ID ${id} was not found.`;
          else if (result.status === 'already_ended') msg = `Giveaway ID ${id} is already ENDED.`;
          else if (result.reason === 'no_entries') msg = `Ended giveaway ID ${id}. There were no valid entries.`;
          else msg = `Ended giveaway ID ${id}. Winners: ${result.winners.map(u => `<@${u}>`).join(', ')}`;
          if (i.deferred) await i.editReply(msg).catch(() => {});
          else await i.reply({ content: msg, flags: 64 }).catch(() => {});
        } catch (err) {
          console.error(err);
          if (i.deferred) await i.editReply('Failed to end the giveaway. Check logs.').catch(() => {});
          else await i.reply({ content: 'Failed to end the giveaway. Check logs.', flags: 64 }).catch(() => {});
        }
      }

      // ---- reroll -----------------------------------------------------------
      if (sub === 'reroll') {
        if (!hasManagerPerm(i.member)) return i.reply({ content: 'No permission.', flags: 64 });
        try { await i.deferReply({ flags: 64 }); } catch {}
        const id = i.options.getInteger('id', true);
        const count = i.options.getInteger('count') ?? 1;
        await finalizeGiveaway(id, count);
        if (i.deferred) await i.editReply(`Rerolled ${count} winner(s) for giveaway ID ${id}.`).catch(() => {});
        else await i.reply({ content: `Rerolled ${count} winner(s) for giveaway ID ${id}.`, flags: 64 }).catch(() => {});
      }

      // ---- status -----------------------------------------------------------
      if (sub === 'status') {
        if (!hasManagerPerm(i.member)) return i.reply({ content: 'No permission.', flags: 64 });
        const id = i.options.getInteger('id', true);
        const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
        if (!g) return i.reply({ content: 'Not found.', flags: 64 });
        const entries = db.prepare('SELECT COUNT(*) as c FROM entries WHERE giveaway_id=?').get(id).c;
        const extra = entries === 0 ? ' (no entries yet)' : '';
        return i.reply({
          content: `Giveaway ${id} → ${entries} entr${entries === 1 ? 'y' : 'ies'}${extra}. Status: ${g.status}. Ends/Ended: <t:${Math.floor(g.end_at/1000)}:F>`,
          flags: 64
        });
      }

      // ---- winners list -----------------------------------------------------
      if (sub === 'winners') {
        if (!hasManagerPerm(i.member)) return i.reply({ content: 'No permission.', flags: 64 });
        const id = i.options.getInteger('id', true);
        const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
        if (!g) return i.reply({ content: 'Giveaway not found.', flags: 64 });
        const rows = db.prepare('SELECT user_id, notified FROM winners WHERE giveaway_id=?').all(id);
        if (!rows.length) return i.reply({ content: 'No winners stored for this giveaway.', flags: 64 });
        const lines = rows.map(r => `${r.notified ? '✅' : '⬜️'} <@${r.user_id}>`);
        return i.reply({ content: `Winners for **${g.prize}** (ID ${id}):\n${lines.join('\n')}`, flags: 64 });
      }

      // ---- mark gifted ------------------------------------------------------
      if (sub === 'gifted') {
        if (!hasManagerPerm(i.member)) return i.reply({ content: 'No permission.', flags: 64 });
        const id = i.options.getInteger('id', true);
        const user = i.options.getUser('user', true);
        const exists = db.prepare('SELECT 1 FROM winners WHERE giveaway_id=? AND user_id=?').get(id, user.id);
        if (!exists) return i.reply({ content: 'That user is not a recorded winner for this giveaway.', flags: 64 });
        db.prepare('UPDATE winners SET notified=1 WHERE giveaway_id=? AND user_id=?').run(id, user.id);
        return i.reply({ content: `Marked <@${user.id}> as gifted for giveaway ID ${id}.`, flags: 64 });
      }

      // ---- entries count ----------------------------------------------------
      if (sub === 'entries') {
        if (!hasManagerPerm(i.member)) return i.reply({ content: 'No permission.', flags: 64 });
        const id = i.options.getInteger('id', true);
        const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
        if (!g) return i.reply({ content: 'Not found.', flags: 64 });
        const count = db.prepare('SELECT COUNT(*) as c FROM entries WHERE giveaway_id=?').get(id).c;
        return i.reply({ content: `Giveaway ${id} has ${count} entr${count === 1 ? 'y' : 'ies'}.`, flags: 64 });
      }

      // ---- remove entry by Discord ID --------------------------------------
      if (sub === 'removeentry') {
        if (!hasManagerPerm(i.member)) return i.reply({ content: 'No permission.', flags: 64 });
        const id = i.options.getInteger('id', true);
        const rawUserId = (i.options.getString('user_id', true) || '').trim();
        const userId = rawUserId.split('#')[0].trim(); // ignore inline comments if any
        if (!/^\d{17,20}$/.test(userId)) {
          return i.reply({ content: `Invalid Discord ID: "${rawUserId}"`, flags: 64 });
        }
        const purgeWinner = i.options.getBoolean('purge_winner') ?? false;

        const del = db.prepare('DELETE FROM entries WHERE giveaway_id=? AND user_id=?').run(id, userId);
        let msg = `Removed ${del.changes} entr${del.changes === 1 ? 'y' : 'ies'} for user <@${userId}> in giveaway ${id}.`;

        if (purgeWinner) {
          const dw = db.prepare('DELETE FROM winners WHERE giveaway_id=? AND user_id=?').run(id, userId);
          msg += ` Removed ${dw.changes} winner record${dw.changes === 1 ? '' : 's'}.`;
        }

        return i.reply({ content: msg, flags: 64 });
      }
    }

    // ---- Button handler (Enter) --------------------------------------------
    if (i.isButton()) {
      const m = i.customId.match(/^enter_(\d+)$/);
      if (!m) return;
      const id = Number(m[1]);
      const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
      if (!g || g.status !== 'ACTIVE') return i.reply({ content: 'This giveaway is not active.', flags: 64 });

      // Role requirement
      if (g.required_role_id) {
        const member = await i.guild.members.fetch(i.user.id).catch(() => null);
        if (!member?.roles.cache.has(g.required_role_id)) {
          return i.reply({ content: `You need the <@&${g.required_role_id}> role to enter.`, flags: 64 });
        }
      }
      // Min server age
      if (g.min_server_age_days) {
        const member = await i.guild.members.fetch(i.user.id).catch(() => null);
        const joined = member?.joinedTimestamp || 0;
        const minJoin = Date.now() - g.min_server_age_days * 86400000;
        if (joined > 0 && joined > minJoin) {
          return i.reply({ content: `You must be in the server for at least ${g.min_server_age_days} day(s).`, flags: 64 });
        }
      }
      // Min account age
      if (g.min_account_age_days) {
        const created = i.user.createdTimestamp;
        const minCreated = Date.now() - g.min_account_age_days * 86400000;
        if (created > minCreated) {
          return i.reply({ content: `Your Discord account must be at least ${g.min_account_age_days} day(s) old.`, flags: 64 });
        }
      }

      try {
        db.prepare('INSERT INTO entries (giveaway_id, user_id, entered_at) VALUES (?,?,?)')
          .run(id, i.user.id, Date.now());
        await i.reply({ content: 'Entry recorded. Good luck!', flags: 64 });
      } catch {
        return i.reply({ content: 'You are already entered.', flags: 64 });
      }
    }
  } catch (err) {
    console.error(err);
    if (i.isRepliable()) {
      try { await i.reply({ content: 'Something broke. Try again or ping an admin.', flags: 64 }); } catch {}
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
