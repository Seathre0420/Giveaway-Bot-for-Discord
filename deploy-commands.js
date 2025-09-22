import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

// Slash command schema (guild-scoped for instant availability)
const giveaway = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Manage giveaways')
  .addSubcommand(sc => sc.setName('start').setDescription('Start a giveaway')
    .addStringOption(o => o.setName('prize').setDescription('Prize title').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('e.g., 30m, 2h, 1d').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setRequired(true))
    .addRoleOption(o => o.setName('required_role').setDescription('Role required to enter'))
    .addIntegerOption(o => o.setName('min_server_age_days').setDescription('Min days in server'))
    .addIntegerOption(o => o.setName('min_account_age_days').setDescription('Min days since account created'))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in'))
  )
  .addSubcommand(sc => sc.setName('end').setDescription('End a giveaway early')
    .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))
  )
  .addSubcommand(sc => sc.setName('reroll').setDescription('Reroll winners')
    .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))
    .addIntegerOption(o => o.setName('count').setDescription('How many to reroll (default 1)'))
  )
  .addSubcommand(sc => sc.setName('status').setDescription('Show entries and status')
    .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))
  )
  .addSubcommand(sc => sc.setName('winners').setDescription('List winners and gift status')
    .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))
  )
  .addSubcommand(sc => sc.setName('gifted').setDescription('Mark a winner as gifted (tracking only)')
    .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))
    .addUserOption(o => o.setName('user').setDescription('Winner to mark gifted').setRequired(true))
  )
  .addSubcommand(sc => sc.setName('entries').setDescription('Check number of entries for a giveaway')
    .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))
  )
  .addSubcommand(sc => sc.setName('removeentry').setDescription('Remove a giveaway entry by Discord ID')
    .addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID to remove').setRequired(true))
    .addBooleanOption(o => o.setName('purge_winner').setDescription('Also remove from winners, if present'))
  )
  // Visible to everyone; permission checks happen in code
  .setDefaultMemberPermissions(null);

const cmds = [giveaway].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  if (!process.env.APP_ID || !process.env.GUILD_ID) {
    throw new Error('APP_ID and GUILD_ID must be set in .env');
  }
  await rest.put(
    Routes.applicationGuildCommands(process.env.APP_ID, process.env.GUILD_ID),
    { body: cmds }
  );
  console.log('Slash commands deployed.');
}

main().catch(err => {
  console.error('Failed to deploy commands:', err);
  process.exit(1);
});
