require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
  PermissionsBitField ,
  SlashCommandBuilder ,
} = require('discord.js');
const mysql = require('mysql2');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./init');
const express = require('express');
const passport = require('passport');
const session = require('express-session');
const { Strategy } = require('passport-discord'); 
const http = require('http'); 
const { Server } = require('socket.io'); 
const axios = require('axios'); // Use axios for API calls 1
const schedule = require('node-schedule');
const gameSpectators = {}; // Tracks spectators per gameId
const connectedUsers = {}; // Maps socket IDs to game IDs
const gameTimers = {};
const INITIAL_GAME_TIME = 10 * 60 * 1000;
const fs = require('fs');
const path = require('path');
// Express-App
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.use(session({ secret: 'random-secret', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());
app.use('/public', express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let botStatus = true;

// Discord Bot Client
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers,],
});

const updateBotStatus = () => {
  db.query('SELECT COUNT(*) AS gameCount FROM active_games', (err, results) => {
    if (err) {
      console.error('Fehler beim Abrufen der aktiven Spiele:', err);
      return;
    }

    const baseGameCount = results[0]?.gameCount || 0;
    const adjustedGameCount = baseGameCount + 400; // Automatisch 400 hinzufügen
    const statusMessage = `${adjustedGameCount} chess games!`;

    try {
      bot.user.setActivity({
        name: statusMessage,
        type: ActivityType.Watching, // Nutze ActivityType Enum
      });
    } catch (error) {
      console.error('Fehler beim Setzen des Status:', error);
    }
  });
};




bot.once('ready', async () => {
  console.log(`"${bot.user.tag}" is ready!`);
  botStatus = true;
  updateBotStatus();
  scheduleDailyLeaderboardUpdate();

  // Alle 60 Sekunden den Status aktualisieren
  setInterval(updateBotStatus, 60000);

  const commands = [
  new SlashCommandBuilder()
    .setName('challenge')
    .setDescription('Challenge a user or a role to a chess game.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('user')
        .setDescription('Challenge a specific user.')
        .addUserOption((option) =>
          option.setName('target').setDescription('The user to challenge.').setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('time')
            .setDescription('Select the playtime for the game.')
            .setRequired(true)
            .addChoices(
              { name: '1 minute', value: '60000' },
              { name: '3 minutes', value: '180000' },
              { name: '5 minutes', value: '300000' },
              { name: '10 minutes', value: '600000' },
              { name: '15 minutes', value: '900000' },
              { name: '20 minutes', value: '1200000' }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('role')
        .setDescription('Challenge all members of a specific role.')
        .addStringOption((option) =>
          option
            .setName('target')
            .setDescription('Select a role to challenge.')
            .setAutocomplete(true) // Enable autocomplete for custom roles
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('time')
            .setDescription('Select the playtime for the game.')
            .setRequired(true)
            .addChoices(
              { name: '1 minute', value: '60000' },
              { name: '3 minutes', value: '180000' },
              { name: '5 minutes', value: '300000' },
              { name: '10 minutes', value: '600000' },
              { name: '15 minutes', value: '900000' },
              { name: '20 minutes', value: '1200000' }
            )
        )
    )
    .toJSON(),
];

  // Register commands with Discord
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

  try {
    console.log('Refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(bot.user.id), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error refreshing application commands:', error);
  }
});

  bot.login(process.env.BOT_TOKEN);

bot.on('interactionCreate', async (interaction) => {
  if (interaction.isCommand() && interaction.commandName === 'challenge') {
    const subcommand = interaction.options.getSubcommand(); // Determines if 'user' or 'role' is chosen

    try {
      // Fetch guild configuration
      const [guildRows] = await db.promise().query(
        'SELECT active_matches_channel, challenges_channel, defined_roles FROM bot_guilds WHERE guild_id = ?',
        [interaction.guildId]
      );

      if (guildRows.length === 0) {
        return interaction.reply({
          content: 'Please contact the Admin of this server because Chessy is not set up correctly!',
          ephemeral: true,
        });
      }

      const { challenges_channel, defined_roles } = guildRows[0];

      if (interaction.channelId !== challenges_channel) {
        return interaction.reply({
          content: `This command can only be used in the channel <#${challenges_channel}>.`,
          ephemeral: true,
        });
      }

      const selectedTime = interaction.options.getString('time'); // Fetch the selected playtime

      if (subcommand === 'user') {
        const targetUser = interaction.options.getUser('target'); // Retrieve the target user

        if (!targetUser || targetUser.bot) {
          return interaction.reply({
            content: 'Please mention a valid user.',
            ephemeral: true,
          });
        }

        if (targetUser.id === interaction.user.id) {
          return interaction.reply({
            content: 'You cannot challenge yourself to a chess game!',
            ephemeral: true,
          });
        }

        // Validate user challenge and send the challenge
        await validateUserChallenge(interaction, targetUser);
        await createAndSendChallenge(interaction, targetUser, null, selectedTime);
      } else if (subcommand === 'role') {
        if (!defined_roles) {
          return interaction.reply({
            content: 'No roles are configured for challenges on this server.',
            ephemeral: true,
          });
        }

        const allowedRoles = defined_roles.split(','); // Extract allowed roles
        const targetRoleId = interaction.options.getString('target'); // Retrieve the selected role ID

        if (!allowedRoles.includes(targetRoleId)) {
          return interaction.reply({
            content: 'The selected role is not allowed for challenges.',
            ephemeral: true,
          });
        }

        const targetRole = interaction.guild.roles.cache.get(targetRoleId);

        if (!targetRole) {
          return interaction.reply({
            content: 'The selected role is no longer available.',
            ephemeral: true,
          });
        }

        // Send the challenge
        await createAndSendChallenge(interaction, null, targetRole, selectedTime);
      }
    } catch (error) {
      console.error('Error processing interaction:', error);
      return interaction.reply({
        content: 'An error occurred while processing your request.',
        ephemeral: true,
      });
    }
  }

  // Handle autocomplete interactions
  if (interaction.isAutocomplete() && interaction.commandName === 'challenge') {
    if (interaction.options.getSubcommand() === 'role') {
      try {
        const [guildRows] = await db.promise().query(
          'SELECT defined_roles FROM bot_guilds WHERE guild_id = ?',
          [interaction.guildId]
        );

        if (guildRows.length === 0 || !guildRows[0].defined_roles) {
          return interaction.respond([]);
        }

        const definedRoles = guildRows[0].defined_roles.split(',');
        const roles = definedRoles
          .map((roleId) => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? { name: `@${role.name}`, value: role.id } : null;
          })
          .filter(Boolean);

        return interaction.respond(roles.map((role) => ({ name: role.name, value: role.value })));
      } catch (error) {
        console.error('Error handling autocomplete:', error);
        return interaction.respond([]);
      }
    }
  }


  if (interaction.isButton()) {
    const [action, challengeId] = interaction.customId.split('_');

    if (action === 'decline') {
      await handleDecline(interaction, challengeId);
    }

    if (action === 'accept') {
      await handleAccept(interaction, challengeId);
    }
  }
});

async function validateUserChallenge(interaction, targetUser) {
  try {
    // Validate if the challenger (interaction.user) is banned or timed out
    const [challengerStatusRows] = await db.promise().query(
      'SELECT status, time_out FROM players WHERE discord_id = ?',
      [interaction.user.id]
    );

    if (challengerStatusRows.length > 0) {
      const { status, time_out } = challengerStatusRows[0];

      if (status === 'banned') {
        return interaction.reply({
          content: 'You are banned on Chessy.gg! If you have concerns, please visit our Discord Server: [Chessy.gg Discord](https://discord.gg/JRMgXxNw8Q)',
          ephemeral: true,
        });
      }

      if (status === 'timed out') {
        return interaction.reply({
          content: `You are currently timed out from Chessy.gg until ${new Date(time_out).toLocaleString()}. If you have concerns, please visit our Discord Server: [Chessy.gg Discord](https://discord.gg/JRMgXxNw8Q)`,
          ephemeral: true,
        });
      }
    }

    // Validate if the target user is banned or timed out
    const [targetStatusRows] = await db.promise().query(
      'SELECT status, time_out FROM players WHERE discord_id = ?',
      [targetUser.id]
    );

    if (targetStatusRows.length > 0) {
      const { status, time_out } = targetStatusRows[0];

      if (status === 'banned') {
        return interaction.reply({
          content: 'This user is banned on Chessy.gg!',
          ephemeral: true,
        });
      }

      if (status === 'timed out') {
        return interaction.reply({
          content: `This user is not available until ${new Date(time_out).toLocaleString()} on Chessy.gg!`,
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error('Error validating user challenge:', error);
    return interaction.reply({
      content: 'An error occurred while validating the challenge. Please try again later.',
      ephemeral: true,
    });
  }
}

// Helper function for creating and sending a challenge
async function createAndSendChallenge(interaction, targetUser, targetRole, selectedTime) {
  const challengeId = uuidv4();
  const challengedId = targetUser ? targetUser.id : targetRole.id;
    
 // Check if there's already an active challenge for the challenged user or role
  const [existingChallengeRows] = await db.promise().query(
    'SELECT * FROM challenges WHERE challenged_id = ? AND challenger_id = ?',
    [challengedId, interaction.user.id]
  );

  if (existingChallengeRows.length > 0) {
    return interaction.reply({
      content: 'You cannot challenge this user or role when you have an active challenge against them.',
      ephemeral: true,
    });
  }

  // Check if there's an existing active game between the challenger and the challenged with game_status = 'not started'
  const [existingGameRows] = await db.promise().query(
    'SELECT * FROM active_games WHERE challenger_id = ? AND challenged_id = ? AND game_status = "not started"',
    [interaction.user.id, challengedId]
  );

  if (existingGameRows.length > 0) {
    return interaction.reply({
      content: 'You cannot challenge this user or role because an active game already exists with them that has not started yet.',
      ephemeral: true,
    });
  }
   const embed = new EmbedBuilder()
  .setTitle('Chess Challenge')
  .setDescription(
    targetUser
      ? `${interaction.user} challenges ${targetUser} to a game of chess!`
      : `${interaction.user} challenges all members of the role ${targetRole} to a game of chess! **Be quick!**`
  )
  .setColor('#0366fc')
  .setImage(
    targetUser
      ? 'https://i.imgur.com/vBtqDK6.png' // Image for user challenge
      : 'https://i.imgur.com/oOr1MJw.png' // Image for role challenge
  )
  .addFields({ name: 'Playtime', value: `${parseInt(selectedTime) / 60000} minutes` })
  .setFooter({
    text: 'Powered by Chessy.gg | Revolutionizing chess on Discord | This challenge will be active for 24 Hours!',
    iconURL: 'https://i.imgur.com/H2AFhcV.jpeg',
  });


  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${challengeId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`decline_${challengeId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
  );

  // Send the embed and fetch the sent message
  const message = await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: false,
    fetchReply: true, // Fetch the sent message object
  });
    
     const pingMessageContent = targetUser
    ? `<@${targetUser.id}> ${interaction.user.username} challenges you to a game of chess!`
    : `<@&${targetRole.id}> ${interaction.user.username} challenges you to a game of chess!`;

  const pingMessage = await interaction.channel.send({
    content: pingMessageContent,
    allowedMentions: { users: [targetUser?.id], roles: [targetRole?.id] },
  });

  // Delete the ping message after 2 seconds
  setTimeout(() => {
    pingMessage.delete().catch(console.error);
  }, 2000);


  // Insert the challenge into the database, including the selected time
  await db.promise().query(
    'INSERT INTO challenges (challenge_uuid, message_id, challenger_id, challenged_id, selected_time, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
    [challengeId, message.id, interaction.user.id, challengedId, selectedTime]
  );

  console.log(`Challenge created successfully with message ID: ${message.id}`);
}


// Handle Decline Button
async function handleDecline(interaction, challengeId) {
  await interaction.deferUpdate();
  const [challengeRows] = await db.promise().query(
    'SELECT * FROM challenges WHERE challenge_uuid = ? AND challenged_id = ?',
    [challengeId, interaction.user.id]
  );

  if (challengeRows.length === 0) {
    return interaction.followUp({
      content: 'This challenge does not exist or does not belong to you.',
      ephemeral: true,
    });
  }

  const challengerId = challengeRows[0].challenger_id;
  const challenger = interaction.guild.members.cache.get(challengerId)?.user || 'Unknown User';

  await db.promise().query('DELETE FROM challenges WHERE challenge_uuid = ?', [challengeId]);

  const embed = new EmbedBuilder()
    .setTitle('Challenge Declined')
    .setDescription(`${interaction.user} has declined the chess challenge from ${challenger}.`)
    .setColor('#FF0000')
    .setFooter({
      text: 'Powered by Chessy.gg | Revolutionizing chess on Discord',
      iconURL: 'https://i.imgur.com/H2AFhcV.jpeg',
    });

  await interaction.editReply({
    embeds: [embed],
    components: [],
  });
}

async function handleAccept(interaction, challengeId) {
  await interaction.deferUpdate();
  const [challengeRows] = await db.promise().query(
    'SELECT * FROM challenges WHERE challenge_uuid = ?',
    [challengeId]
  );

  if (challengeRows.length === 0) {
    return interaction.followUp({
      content: 'This challenge does not exist or has already been handled.',
      ephemeral: true,
    });
  }

  const challenge = challengeRows[0];
    
     // Prevent the challenger from accepting their own challenge
  if (challenge.challenger_id === interaction.user.id) {
    return interaction.followUp({
      content: 'You cannot accept your own challenge.',
      ephemeral: true,
    });
  }

  // Check if the challenge is targeted to a role
  const isRoleChallenge = interaction.guild.roles.cache.has(challenge.challenged_id);

  if (isRoleChallenge) {
    // Ensure the user accepting the challenge has the role
    const role = interaction.guild.roles.cache.get(challenge.challenged_id);
    if (!interaction.member.roles.cache.has(role.id)) {
      return interaction.followUp({
        content: 'You do not have the required role to accept this challenge!',
        ephemeral: true,
      });
    }
  } else if (challenge.challenged_id !== interaction.user.id) {
    // Validate if the challenge is targeted to the specific user
    return interaction.followUp({
      content: 'You are not authorized to accept this challenge!',
      ephemeral: true,
    });
  }

  const gameId = uuidv4();
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const randomAssign = Math.random() < 0.5;

  // Determine white and black players
  const whitePlayer = randomAssign ? challenge.challenger_id : interaction.user.id;
  const blackPlayer = randomAssign ? interaction.user.id : challenge.challenger_id;

  const guildId = interaction.guildId; // Fetch the guild ID from the interaction
  const messageId = challenge.message_id; // Fetch the message ID from the challenge
  const selectedTime = challenge.selected_time;
    
 // Insert the game into the active_games table
  await db.promise().query(
    'INSERT INTO active_games (game_uuid, guild_id, challenger_id, challenged_id, white_player_id, black_player_id, fen, message_id, selected_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
    [
      gameId,
      guildId,
      challenge.challenger_id,
      interaction.user.id, // Use the accepting user's ID as challenged_id for role challenges
      whitePlayer,
      blackPlayer,
      fen,
      messageId, // Include the message ID
      selectedTime, // Include the selected playtime
    ]
  );

  const embed = new EmbedBuilder()
    .setTitle('Challenge Accepted')
    .setDescription(`Game created! [Click here to join](http://localhost:3000/game/${gameId})`)
    .setImage('https://i.imgur.com/ZspH20V.jpeg')
    .addFields(
      { name: 'White', value: `<@${whitePlayer}>`, inline: true },
      { name: 'Black', value: `<@${blackPlayer}>`, inline: true },
      { name: 'Playtime', value: `${parseInt(selectedTime) / 60000} minutes`, inline: true }
    )
    .setColor('#0366fc')
    .setFooter({
      text: 'Powered by Chessy.gg | Revolutionizing chess on Discord | This challenge will be active for 24 Hours!',
      iconURL: 'https://i.imgur.com/H2AFhcV.jpeg',
    });

  await interaction.editReply({
    embeds: [embed],
    components: [],
  });

  // Delete the challenge from the challenges table
  await db.promise().query('DELETE FROM challenges WHERE challenge_uuid = ?', [challengeId]);
}

bot.on('guildDelete', async (guild) => {
  try {
    console.log(`Bot wurde von dem Server "${guild.name}" (ID: ${guild.id}) entfernt.`);

    // Setze is_in_guild auf "no" in der Datenbank für diesen Server
    await db.promise().query(
      'UPDATE bot_guilds SET is_in_guild = ? WHERE guild_id = ?',
      ['no', guild.id]
    );

    console.log(`Datenbank aktualisiert: Server "${guild.name}" wurde als verlassen markiert.`);
  } catch (error) {
    console.error(`Fehler beim Verarbeiten des guildDelete-Events für Server ${guild.id}:`, error);
  }
});



function logErrorToFile(error) {
  const errorMsg = `[${new Date().toISOString()}] ${error.stack || error.message || error}\n`;
  fs.appendFileSync('error_log.txt', errorMsg);
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  logErrorToFile(reason);  // Logge den Fehler in die Datei
  botStatus = false; // Setze den Bot-Status auf false bei einem Fehler
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  logErrorToFile(error);  // Logge den Fehler in die Datei
  botStatus = false; // Setze den Bot-Status auf false bei einem Fehler
});

// Passport-Discord Auth
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new Strategy(
    {
      clientID: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      callbackURL: process.env.REDIRECT_URI,
      scope: ['identify', 'guilds'],
    },
    (accessToken, refreshToken, profile, done) => {
      process.nextTick(() => done(null, profile));
    }
  )
);

// Middleware
function checkAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

app.get('/', (req, res) => {
 res.render('index', { user: req.user });
});

app.get('/help', (req, res) => {
 res.render('help', { user: req.user });
});

app.get('/test', (req, res) => {
 res.render('test', { user: req.user });
});

app.get('/elo-explained', (req, res) => {
 res.render('elo-explained', { user: req.user });
});

app.get('/privacy', (req, res) => {
 res.render('privacy', { user: req.user });
});

app.get('/terms-of-service', (req, res) => {
 res.render('terms-of-service', { user: req.user });
});

app.get('/support-chessy', (req, res) => {
 res.render('support-chessy', { user: req.user });
});

// ADMIN
app.get('/admin/dashboard', checkOwner, async (req, res) => {
  try {
    // Anzahl der Einträge pro Seite und aktuelle Seite aus der Query
    const entriesPerPage = parseInt(req.query.entriesPerPage) || 10; // Standard: 10 Einträge
    const page = parseInt(req.query.page) || 1; // Standard: Seite 1

    // Analytics-Daten
    const [serverRows] = await db.promise().query('SELECT COUNT(*) AS total FROM bot_guilds WHERE is_in_guild = "yes"');
    const [liveGamesRows] = await db.promise().query('SELECT COUNT(*) AS total FROM active_games WHERE game_status = "started"');
    const [totalGamesRows] = await db.promise().query('SELECT COUNT(*) AS total FROM active_games');
    const [totalPlayersRows] = await db.promise().query('SELECT COUNT(*) AS total FROM players');
    
    // Spieleranzahl und Pagination
    const totalPlayersCount = totalPlayersRows[0].total;
    const totalPages = Math.ceil(totalPlayersCount / entriesPerPage);
    const offset = (page - 1) * entriesPerPage;

    // Spieler für die aktuelle Seite abrufen
    const [playersRows] = await db.promise().query('SELECT * FROM players LIMIT ? OFFSET ?', [entriesPerPage, offset]);

    // Füge Spiele und Gewinne pro Spieler hinzu
    const players = await Promise.all(playersRows.map(async (player) => {
      const [gamesPlayedRows] = await db.promise().query(
        `SELECT COUNT(*) AS total FROM active_games 
         WHERE challenger_id = ? OR challenged_id = ?`,
        [player.discord_id, player.discord_id]
      );

      const [winsRows] = await db.promise().query(
        `SELECT COUNT(*) AS total FROM wins 
         WHERE discord_id = ?`,
        [player.discord_id]
      );

      // Hole den Benutzernamen von der Discord API
      try {
        const discordApiResponse = await axios.get(`https://discord.com/api/users/${player.discord_id}`, {
          headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
        });

        const username = discordApiResponse.data.username || 'Unknown';

        return {
  username,
  discordId: player.discord_id,
  elo: player.elo,
  gamesPlayed: gamesPlayedRows[0].total,
  wins: winsRows[0].total,
  status: player.status,
  timeOut: player.time_out,
  reason: player.reason,
  supporter: player.supporter, // Hier muss der Supporter-Wert korrekt zurückgegeben werden
        };
      } catch (error) {
        console.error(`Fehler beim Abrufen von Benutzerdaten für Discord-ID ${player.discord_id}:`, error);
       return {
  username,
  discordId: player.discord_id,
  elo: player.elo,
  gamesPlayed: gamesPlayedRows[0].total,
  wins: winsRows[0].total,
  status: player.status,
  timeOut: player.time_out,
  reason: player.reason,
  supporter: player.supporter, // Hier muss der Supporter-Wert korrekt zurückgegeben werden
};
      }
    }));

    res.render('admin/dashboard', {
      user: req.user,
      totalServers: serverRows[0].total,
      liveGames: liveGamesRows[0].total,
      totalGames: totalGamesRows[0].total,
      totalPlayers: totalPlayersCount,
      players,
      totalPages,
      currentPage: page,
      entriesPerPage,
    });
  } catch (error) {
    console.error('Fehler beim Laden der Analytics:', error);
    res.status(500).send('Interner Serverfehler');
  }
});

// API-Endpoint für Analytics-Daten
app.get('/api/get-stats', checkOwner, async (req, res) => {
  try {
    const [serverRows] = await db.promise().query('SELECT COUNT(*) AS total FROM bot_guilds WHERE is_in_guild = "yes"');
    const [liveGamesRows] = await db.promise().query('SELECT COUNT(*) AS total FROM active_games WHERE game_status = "started"');
    const [totalGamesRows] = await db.promise().query('SELECT COUNT(*) AS total FROM active_games');
    const [totalPlayersRows] = await db.promise().query('SELECT COUNT(*) AS total FROM players');

    res.json({
      totalServers: serverRows[0].total,
      liveGames: liveGamesRows[0].total,
      totalGames: totalGamesRows[0].total,
      totalPlayers: totalPlayersRows[0].total,
    });
  } catch (error) {
    console.error('Fehler beim Laden der Analytics:', error);
    res.status(500).send('Interner Serverfehler');
  }
});

app.post('/api/edit-player', checkOwner, async (req, res) => {
  const { discordId, elo, status, timeOut, reason, supporter } = req.body;

  try {
    // Validierung: Status 'timed out' benötigt Time Out Datum und Grund
    if (status === 'timed out') {
      if (!timeOut) {
        return res.json({ success: false, message: 'Time Out date is required for "Timed Out" status.' });
      }

      const timeOutDate = new Date(timeOut);
      const now = new Date();
      if (timeOutDate < now) {
        return res.json({ success: false, message: 'Time Out date cannot be in the past.' });
      }

      if (!reason || reason.trim() === '') {
        return res.json({ success: false, message: 'A reason is required for "Timed Out" status.' });
      }
    }

    // Validierung: Status 'banned' benötigt einen Grund
    if (status === 'banned' && (!reason || reason.trim() === '')) {
      return res.json({ success: false, message: 'A reason is required for "Banned" status.' });
    }

    // Spieler-Daten aktualisieren
    await db.promise().query(
      `UPDATE players 
       SET elo = ?, status = ?, time_out = ?, reason = ?, supporter = ?
       WHERE discord_id = ?`,
      [elo, status || null, timeOut || null, reason || null, supporter || 'no', discordId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Aktualisieren des Spielers:', error);
    res.json({ success: false, message: 'Internal server error' });
  }
});

app.get('/admin/games', checkOwner, async (req, res) => {
  try {
    // Anzahl der Einträge pro Seite und aktuelle Seite aus der Query
    const entriesPerPage = parseInt(req.query.entriesPerPage) || 10; // Standard: 10 Einträge
    const page = parseInt(req.query.page) || 1; // Standard: Seite 1

    // Gesamtanzahl der Spiele für die Paginierung
    const [totalGamesRows] = await db.promise().query('SELECT COUNT(*) AS total FROM active_games');
    const totalGamesCount = totalGamesRows[0].total;
    const totalPages = Math.ceil(totalGamesCount / entriesPerPage);
    const offset = (page - 1) * entriesPerPage;

    // Spiele für die aktuelle Seite abrufen
    const [gamesRows] = await db.promise().query('SELECT * FROM active_games LIMIT ? OFFSET ?', [entriesPerPage, offset]);

    // Spiele mit Benutzernamen aus der Datenbank anreichern
    const games = await Promise.all(
      gamesRows.map(async (game) => {
        const [challengerRows] = await db.promise().query('SELECT username FROM players WHERE discord_id = ?', [game.challenger_id]);
        const [challengedRows] = await db.promise().query('SELECT username FROM players WHERE discord_id = ?', [game.challenged_id]);

        return {
          ...game,
          challengerUsername: challengerRows.length > 0 ? challengerRows[0].username : 'Unknown',
          challengedUsername: challengedRows.length > 0 ? challengedRows[0].username : 'Unknown',
        };
      })
    );

    res.render('admin/games', {
      user: req.user,
      games,
      totalPages,
      currentPage: page,
      entriesPerPage,
    });
  } catch (error) {
    console.error('Fehler beim Laden der aktiven Spiele:', error);
    res.status(500).send('Interner Serverfehler');
  }
});

app.get('/api/game-details/:gameUuid', checkOwner, async (req, res) => {
  try {
    const { gameUuid } = req.params;

    // Spielinformationen aus der Datenbank abrufen
    const [gameRows] = await db.promise().query('SELECT * FROM active_games WHERE game_uuid = ?', [gameUuid]);

    if (gameRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Game not found' });
    }

    const game = gameRows[0];

    // Benutzernamen aus der Tabelle `players` abrufen
    const [challengerRows] = await db.promise().query('SELECT username FROM players WHERE discord_id = ?', [game.challenger_id]);
    const [challengedRows] = await db.promise().query('SELECT username FROM players WHERE discord_id = ?', [game.challenged_id]);
    const [blackPlayerRows] = await db.promise().query('SELECT username FROM players WHERE discord_id = ?', [game.black_player_id]);
    const [whitePlayerRows] = await db.promise().query('SELECT username FROM players WHERE discord_id = ?', [game.white_player_id]);

    const challengerUsername = challengerRows.length > 0 ? challengerRows[0].username : 'Unknown';
    const challengedUsername = challengedRows.length > 0 ? challengedRows[0].username : 'Unknown';
    const blackPlayerUsername = blackPlayerRows.length > 0 ? blackPlayerRows[0].username : 'Unknown';
    const whitePlayerUsername = whitePlayerRows.length > 0 ? whitePlayerRows[0].username : 'Unknown';

    // Erweiterte Spieldetails zurückgeben
    res.json({
      success: true,
      game: {
        ...game,
        challengerUsername,
        challengedUsername,
        blackPlayerUsername,
        whitePlayerUsername,
      },
    });
  } catch (error) {
    console.error('Fehler beim Laden der Spieldetails:', error);
    res.status(500).json({ success: false, message: 'Interner Serverfehler' });
  }
});



app.get('/api/game-details/:gameUuid', checkOwner, async (req, res) => {
  try {
    const { gameUuid } = req.params;

    // Spielinformationen aus der Datenbank abrufen
    const [gameRows] = await db.promise().query('SELECT * FROM active_games WHERE game_uuid = ?', [gameUuid]);

    if (gameRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Game not found' });
    }

    const game = gameRows[0];

   const fetchUsername = async (discordId) => {
  try {
    console.log(`Abrufen des Benutzernamens für Discord-ID: ${discordId}`);
    const discordApiResponse = await axios.get(`https://discord.com/api/users/${discordId}`, {
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
    });
    console.log(`API-Antwort für ${discordId}:`, discordApiResponse.data);
    return discordApiResponse.data.username || 'Unknown';
  } catch (error) {
    console.error(`Fehler beim Abrufen des Benutzernamens für Discord-ID ${discordId}:`, error.message);
    return 'Unknown';
  }
};

    const challengerUsername = await fetchUsername(game.challenger_id);
    const challengedUsername = await fetchUsername(game.challenged_id);
    const blackPlayerUsername = await fetchUsername(game.black_player_id);
    const whitePlayerUsername = await fetchUsername(game.white_player_id);

    // Erweiterte Spieldetails zurückgeben
    res.json({
      success: true,
      game: {
        ...game,
        challengerUsername,
        challengedUsername,
        blackPlayerUsername,
        whitePlayerUsername,
      },
    });
  } catch (error) {
    console.error('Fehler beim Laden der Spieldetails:', error);
    res.status(500).json({ success: false, message: 'Interner Serverfehler' });
  }
});

// Abrufen des Anonymous-Mode-Status
app.get('/api/admin/anonymous-mode', checkOwner, async (req, res) => {
  try {
    const [settings] = await db.promise().query('SELECT anonymous_mode FROM settings LIMIT 1');
    if (settings.length === 0) {
      return res.status(404).json({ success: false, message: 'Einstellung nicht gefunden' });
    }
    res.json({ success: true, anonymousMode: settings[0].anonymous_mode });
  } catch (error) {
    console.error('Fehler beim Abrufen des Anonymous-Mode-Status:', error);
    res.status(500).json({ success: false, message: 'Interner Serverfehler' });
  }
});

// Aktualisieren des Anonymous-Mode-Status
app.post('/api/admin/anonymous-mode', checkOwner, async (req, res) => {
  try {
    const { anonymousMode } = req.body;
    if (!['yes', 'no'].includes(anonymousMode)) {
      return res.status(400).json({ success: false, message: 'Ungültiger Wert' });
    }
    await db.promise().query('UPDATE settings SET anonymous_mode = ? WHERE id = 1', [anonymousMode]);
    res.json({ success: true, message: 'Anonymous-Mode aktualisiert' });
  } catch (error) {
    console.error('Fehler beim Aktualisieren des Anonymous-Mode-Status:', error);
    res.status(500).json({ success: false, message: 'Interner Serverfehler' });
  }
});


function checkOwner(req, res, next) {
  if (req.session.isOwner) {
    return next(); // Weiter zur nächsten Middleware oder Route
  }
  res.redirect('/'); // Weiterleitung zur Startseite
}


app.get('/status', (req, res) => {
  try {
    // Direkt den Systemstatus prüfen
    const status = checkSystemStatus();

    res.render('status', {
      user: req.user,
      status, // Gibt den gesamten Status-Objekt direkt weiter
    });
  } catch (error) {
    console.error('Error fetching system status:', error.message);
    // Falls ein Fehler auftritt, alle Systeme als DOWN anzeigen
    res.render('status', {
      user: req.user,
      status: { website: false, bot: false, api: false, dashboard: false },
    });
  }
});

// Mock function to check system status
function checkSystemStatus() {
  return {
    website: true, // true = UP, false = DOWN
    bot: botStatus,
    api: false,
    dashboard: true,
  };
}

app.get('/public-servers', async (req, res) => {
  try {
    // Abrufen der Server aus der Datenbank, inklusive Invite-Link
   const [rows] = await db.promise().query('SELECT guild_id, invite_link FROM bot_guilds WHERE is_in_guild = "yes"');

    // Discord-API-Aufrufe, um zusätzliche Serverinformationen zu erhalten
    const servers = await Promise.all(
      rows.map(async (row) => {
        const guildId = row.guild_id;
        const inviteLink = row.invite_link; // Invite-Link aus der DB

        try {
          // Abruf des Guild Preview Endpunkts für erweiterte Informationen
          const response = await axios.get(`https://discord.com/api/guilds/${guildId}/preview`, {
            headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
          });

          const guild = response.data;

          return {
            id: guild.id,
            name: guild.name,
            icon: guild.icon
              ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
              : '/public/img/default_icon.png',
            members: guild.approximate_member_count || 0, // Mitgliederanzahl
            description: guild.description || 'No description available.', // Beschreibung
            inviteLink: inviteLink || null, // Nutze den Invite-Link aus der DB, wenn vorhanden
          };
        } catch (error) {
          console.warn(`Fehler beim Abrufen von Informationen für Guild ID ${guildId}:`, error.message);

          // Fallback für Server, bei denen keine erweiterten Informationen verfügbar sind
          return {
            id: guildId,
            name: 'Unknown Server',
            icon: '/public/img/default_icon.png',
            members: 0,
            description: 'No description available.',
            inviteLink: inviteLink || null, // Nutze den Invite-Link aus der DB, wenn vorhanden
          };
        }
      })
    );

    // Übergabe der Serverdaten und Benutzerinformationen an die View
    res.render('public-servers', { servers, user: req.user });
  } catch (error) {
    console.error('Fehler beim Laden der öffentlichen Server:', error);
    res.status(500).send('Interner Serverfehler');
  }
});



app.get('/discord-msg-tmpl', (req, res) => {
  res.render('discord-msg-tmpl');
});
// Routen
app.get('/login', passport.authenticate('discord'));

app.get(
  '/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  async (req, res) => {
    const discordId = req.user.id;

    try {
      // Rollenprüfung hinzufügen
      const guildId = '1276609781330743408';
      const ownerRoleId = '1276611180915327119';
      const teamRoleId = '1317229252042555506';

      const guildResponse = await axios.get(
        `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
        {
          headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
        }
      );

      const userRoles = guildResponse.data.roles;
      req.session.isOwner = userRoles.includes(ownerRoleId);
      req.session.isTeam = userRoles.includes(teamRoleId);

      // Benutzernamen aus der Discord-API abrufen
      const fetchUsername = async (discordId) => {
        try {
          const discordApiResponse = await axios.get(`https://discord.com/api/users/${discordId}`, {
            headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
          });
          return discordApiResponse.data.username || 'Unknown';
        } catch (error) {
          console.error(`Fehler beim Abrufen des Benutzernamens für Discord-ID ${discordId}:`, error);
          return 'Unknown';
        }
      };

      const username = await fetchUsername(discordId);

      // Benutzerstatus überprüfen
      db.query('SELECT * FROM players WHERE discord_id = ?', [discordId], async (err, results) => {
        if (err) {
          console.error('Fehler beim Überprüfen der Discord-ID:', err);
          return res.redirect('/');
        }

        if (results.length === 0) {
          // Benutzer hinzufügen, wenn nicht vorhanden
          const userType = req.session.isOwner
            ? 'admin'
            : req.session.isTeam
            ? 'team'
            : 'player';

          db.query(
            'INSERT INTO players (discord_id, username, elo, status, type) VALUES (?, ?, ?, ?, ?)',
            [discordId, username, 100, 'active', userType],
            (insertErr) => {
              if (insertErr) {
                console.error('Fehler beim Hinzufügen des Benutzers:', insertErr);
                return res.redirect('/');
              }

              console.log(`Benutzer mit Discord-ID ${discordId} und Username ${username} wurde hinzugefügt.`);
              return res.redirect('/select-platform?welcome');
            }
          );
        } else {
          // Benutzer existiert, Status und Username aktualisieren
          const user = results[0];

          const userType = req.session.isOwner
            ? 'admin'
            : req.session.isTeam
            ? 'team'
            : 'player';

          db.query(
            'UPDATE players SET username = ?, type = ? WHERE discord_id = ?',
            [username, userType, discordId],
            (updateErr) => {
              if (updateErr) {
                console.error('Fehler beim Aktualisieren des Benutzers:', updateErr);
                return res.redirect('/');
              }

              console.log(`Benutzer mit Discord-ID ${discordId} wurde aktualisiert: Username ${username}, Type ${userType}.`);

              if (user.status === 'banned') {
                console.log(`Benutzer ${discordId} ist gesperrt.`);
                req.logout(() => {
                  res.redirect('/?banned');
                });
                return;
              }

              if (user.status === 'timed out') {
                const timeOut = new Date(user.time_out);
                const now = new Date();

                if (now > timeOut) {
                  console.log(`Time Out für Benutzer ${discordId} abgelaufen. Status wird zurückgesetzt.`);

                  db.query(
                    'UPDATE players SET status = ?, time_out = NULL, reason = NULL WHERE discord_id = ?',
                    ['active', discordId],
                    (updateStatusErr) => {
                      if (updateStatusErr) {
                        console.error('Fehler beim Zurücksetzen des Status:', updateStatusErr);
                        return res.redirect('/');
                      }

                      console.log(`Benutzer ${discordId} wurde reaktiviert.`);
                      return res.redirect('/select-platform?welcome');
                    }
                  );
                } else {
                  console.log(`Benutzer ${discordId} ist vorübergehend gesperrt bis ${user.time_out}.`);
                  req.logout(() => {
                    res.redirect(`/?timed_out=${encodeURIComponent(user.time_out)}`);
                  });
                  return;
                }
              } else {
                console.log(`Benutzer mit Discord-ID ${discordId} ist aktiv und wird eingeloggt.`);
                res.redirect('/select-platform?welcome');
              }
            }
          );
        }
      });
    } catch (error) {
      console.error('Fehler bei der Rollenprüfung oder beim Abrufen des Benutzernamens:', error);
      res.redirect('/');
    }
  }
);



app.get('/select-platform', checkAuth, async (req, res) => {
  try {
    const discordApiHeaders = {
      headers: {
        Authorization: `Bot ${process.env.BOT_TOKEN}`,
      }
    };

    // Abrufen der Benutzerdaten von Discord
    const userId = req.user.id;
    const userData = await axios.get(`https://discord.com/api/v10/users/${userId}`, discordApiHeaders);

    const userAvatar = userData.data.avatar
      ? `https://cdn.discordapp.com/avatars/${userId}/${userData.data.avatar}.png`
      : '/public/img/default_avatar.png';

    res.render('select-platform', {
      user: req.user,
      discordAvatar: userAvatar,
      discordUsername: userData.data.username
    });
  } catch (error) {
    console.error('Fehler beim Abrufen des Discord-Avatars und Benutzernamens:', error);
    res.redirect('/login'); // Umleiten, falls ein Fehler auftritt
  }
});

app.get('/your-servers', checkAuth, async (req, res) => {
  // Filtere nur die Server, bei denen der User der Besitzer ist
  const servers = req.user.guilds
    .filter((guild) => guild.owner) // Nur die Server, die dem User gehören
    .map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon
        ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
        : null, // Korrigiere die Syntax für die URL
      botInGuild: bot.guilds.cache.has(guild.id), // Boolean, ob der Bot im Server ist
    }));

  res.render('your-servers', { user: req.user, servers });
});

app.get('/invite/:id', checkAuth, (req, res) => {
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=8&scope=bot&redirect_uri=https%3A%2F%2Fchessy.gg%2Fyour-servers%3Fsuccess&guild_id=${req.params.id}`;
    res.redirect(inviteUrl);
});


app.get('/invite/:id', checkAuth, (req, res) => {
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=8&scope=bot&redirect_uri=https%3A%2F%2Fchessy.gg%2Fyour-servers%3Fsuccess&guild_id=${req.params.id}`;
    res.redirect(inviteUrl);
});


bot.on('guildCreate', async (guild) => {
  try {
    // Überprüfen, ob der Guild-Owner verfügbar ist
    const owner = await guild.fetchOwner();
      
     // Nachricht mit Embed an den Owner senden
    const embed = new EmbedBuilder()
      .setTitle('Welcome to Chessy.gg! 🏆')
      .setDescription(
        `Hello ${owner.user.username},\n\nThank you for adding **Chessy.gg**, the ultimate Discord chess gaming platform, to your server **${guild.name}**! 🎉\n\nYou've already completed the first step: adding Chessy.gg to your server. Now it's time to set things up and start playing:\n\n1️⃣ **Visit [Chessys Dashboard](http://localhost:3000/select-platform)**\n\n2️⃣ Go to the **Server Owner** section.\n\n3️⃣ Select your server and complete the setup – it’s quick and straightforward!\n\n### Pro Tip\nConfigure your server channels for **leaderboards**, **live matches**, and **finished matches** to ensure no one has typing permissions in these channels. This keeps everything clean and professional for your community.\n\nThat's it! You're all set to enjoy Chessy.gg with your community.\n\nSee you on the board! 😉`
      )
      .setColor('#7289DA')
      .setImage('https://i.imgur.com/1T6nra2.jpeg')
      .setFooter({
        text: 'Powered by Chessy.gg | Revolutionizing chess on Discord',
        iconURL: 'https://i.imgur.com/H2AFhcV.jpeg',
      });

    try {
      await owner.send({ embeds: [embed] });
      //console.log(`DM sent to the owner of guild "${guild.name}" (${guild.id})`);
    } catch (dmError) {
      //console.warn(`Could not send DM to guild owner of ${guild.name}:`, dmError.message);
    }

    // Ermitteln des Bots als GuildMember
    const botMember = await guild.members.fetch(bot.user.id);

    // Erstellen eines nie ablaufenden Invite-Links
    const textChannel = guild.channels.cache.find(
      (channel) =>
        channel.type === 0 && // Prüfen, ob es ein Textkanal ist (0 = GuildText)
        channel.permissionsFor(botMember).has(PermissionsBitField.Flags.CreateInstantInvite) // Berechtigung prüfen
    );

    let inviteLink = null;

    if (textChannel) {
      const invite = await textChannel.createInvite({
        maxAge: 0, // Kein Ablaufdatum
        maxUses: 0, // Unbegrenzte Anzahl an Nutzungen
        unique: true, // Erzwinge die Erstellung eines neuen Links
      });
      inviteLink = invite.url;
    } else {
      console.warn(`Kein geeigneter Textkanal für das Erstellen eines Invite-Links in Server ${guild.name}`);
    }

    // Prüfen, ob der Eintrag bereits existiert
    db.query('SELECT COUNT(*) AS count FROM bot_guilds WHERE guild_id = ?', [guild.id], (err, results) => {
      if (err) {
        console.error('Fehler beim Überprüfen der Guild:', err);
        return;
      }

      const exists = results[0].count > 0;

      if (exists) {
        // Eintrag existiert -> Update
       db.query(
  'UPDATE bot_guilds SET guild_name = ?, owner_id = ?, invite_link = ?, is_in_guild = ?, updated_at = NOW() WHERE guild_id = ?',
  [guild.name, owner.id, inviteLink, 'yes', guild.id],
  (updateErr) => {
    if (updateErr) {
      console.error('Fehler beim Aktualisieren der Guild:', updateErr);
    } else {
      console.log(`Server ${guild.name} (${guild.id}) erfolgreich aktualisiert.`);
    }
  }
);
      } else {
        // Eintrag existiert nicht -> Hinzufügen
        db.query(
          'INSERT INTO bot_guilds (guild_id, guild_name, owner_id, added_at, invite_link) VALUES (?, ?, ?, NOW(), ?)',
          [guild.id, guild.name, owner.id, inviteLink],
          (insertErr) => {
            if (insertErr) {
              console.error('Fehler beim Einfügen in die Datenbank:', insertErr);
            } else {
              console.log(`Server ${guild.name} (${guild.id}) erfolgreich hinzugefügt mit Invite-Link: ${inviteLink}`);
            }
          }
        );
      }
    });
  } catch (error) {
    console.error('Fehler beim Verarbeiten eines neuen Servers:', error);
  }
});

// Express-Route, die den Benutzer zur Discord-OAuth2-URL weiterleitet
app.get('/add-server', (req, res) => {
  const discordOAuthURL = 'https://discord.com/oauth2/authorize?client_id=1313872381617639566&scope=bot%20applications.commands&permissions=8&redirect_uri=https%3A%2F%2Fchessy.gg%2Foauth%2Finvite-chessy';
  res.redirect(discordOAuthURL); // Weiterleitung zur OAuth2-Seite
});



app.get('/oauth/invite-chessy', async (req, res) => {
  const guildId = req.query.guild_id; // Get the guild ID from the query parameters
  const inviteCode = req.query.code; // This is the OAuth code

  if (!inviteCode) {
    return res.status(400).send('Authorization code is missing.');
  }

  try {
    // Exchange the code for an access token
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', null, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      params: {
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        code: inviteCode,
        redirect_uri: process.env.REDIRECT_URI,
        grant_type: 'authorization_code',
      },
    });

    const { access_token } = tokenResponse.data;

    // Fetch the guild's information
    const guildResponse = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    const guild = guildResponse.data.find((g) => g.id === guildId);
    if (!guild) {
      return res.status(400).send('Guild not found.');
    }

    // Now that the guild is authorized, insert it into the database
    db.query(
      'INSERT INTO bot_guilds (guild_id, guild_name) VALUES (?, ?)',
      [guild.id, guild.name],
      (err) => {
        if (err) {
          console.error('Error inserting guild:', err);
          return res.status(500).send('Internal server error.');
        }

        res.send('Server successfully added to the database!');
      }
    );
  } catch (error) {
    console.error('Error during OAuth process:', error);
    res.status(500).send('Error processing the invite.');
  }
});



app.get('/configure/:id', checkAuth, async (req, res) => {
  const serverId = req.params.id;

  db.query('SELECT * FROM bot_guilds WHERE guild_id = ?', [serverId], async (err, results) => {
    if (err || results.length === 0) {
      console.error('Fehler beim Abrufen des Servers:', err);
      return res.redirect('/your-servers');
    }

    const server = results[0];
    const userGuild = req.user.guilds.find((guild) => guild.id === serverId);

    if (!userGuild || server.owner_id !== req.user.id) {
      return res.redirect('/your-servers');
    }

    try {
      const guild = await bot.guilds.fetch(serverId);
      const channels = guild.channels.cache
        .filter((channel) => channel.type === 0)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
        }));

      const roles = guild.roles.cache
        .filter((role) => role.name !== '@everyone')
        .map((role) => ({
          id: role.id,
          name: role.name,
        }));

      const selectedRoles = server.defined_roles ? server.defined_roles.split(',') : []; // CSV zu Array

      res.render('configure', {
        server: {
          ...userGuild,
          leaderboard_channel: server.leaderboard_channel,
          active_matches_channel: server.active_matches_channel,
          finished_matches_channel: server.finished_matches_channel,
          challenges_channel: server.challenges_channel,
        },
        channels,
        roles,
        selectedRoles, // Hinzufügen der ausgewählten Rollen
        selectedLeaderboardChannel: channels.find(channel => channel.id === server.leaderboard_channel)?.name || 'Select a Channel',
        selectedActiveMatchesChannel: channels.find(channel => channel.id === server.active_matches_channel)?.name || 'Select Channel',
        selectedFinishedMatchesChannel: channels.find(channel => channel.id === server.finished_matches_channel)?.name || 'Select Channel',
        selectedChallengesChannel: channels.find(channel => channel.id === server.challenges_channel)?.name || 'Select Channel',
        user: req.user,
      });
    } catch (error) {
      console.error('Fehler beim Abrufen der Kanäle oder Rollen:', error);
      res.redirect('/dashboard');
    }
  });
});


app.post('/configure/:id', checkAuth, async (req, res) => {
  const serverId = req.params.id;
  const {
    leaderboard_channel,
    active_matches_channel,
    finished_matches_channel,
    challenges_channel,
    roles_dropdown // Das neue Feld für ausgewählte Rollen
  } = req.body;

  console.log('Server ID:', serverId);
  console.log('Empfangene Daten:', req.body);

  const userGuild = req.user.guilds.find((guild) => guild.id === serverId);
  if (!userGuild || !userGuild.owner) {
    console.error('Keine Berechtigung zur Konfiguration.');
    return res.redirect(`/your-servers?error=true`);
  }

  try {
    // Wenn roles_dropdown kein Array ist, mache es zu einem Array
    const rolesArray = Array.isArray(roles_dropdown) ? roles_dropdown : [roles_dropdown];

    // Update der Datenbank
    await db.promise().query(
      `UPDATE bot_guilds 
       SET leaderboard_channel = ?, active_matches_channel = ?, finished_matches_channel = ?, challenges_channel = ?, defined_roles = ?
       WHERE guild_id = ?`,
      [
        leaderboard_channel,
        active_matches_channel,
        finished_matches_channel,
        challenges_channel,
        rolesArray.length ? rolesArray.join(',') : null, // Speichere Rollen als CSV oder null
        serverId
      ]
    );
    return res.redirect(`/configure/${serverId}?success=true`);
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Konfiguration:', error);
    return res.redirect(`/configure/${serverId}?error=true`);
  }
});


app.use(session({
  secret: 'random-secret',
  resave: false,
  saveUninitialized: false,
}));
app.use(passport.initialize());
app.use(passport.session());

app.get('/game/:gameId', async (req, res) => {
  const { gameId } = req.params;

  try {
    // Fetch game data from the database
    const [gameRows] = await db.promise().query('SELECT * FROM active_games WHERE game_uuid = ?', [gameId]);
    if (gameRows.length === 0) {
      return res.status(404).send('Spiel nicht gefunden.');
    }

    const game = gameRows[0];

    // Check if user is authenticated
    const isAuthenticated = req.isAuthenticated ? req.isAuthenticated() : false;
    const userId = isAuthenticated ? req.user.id : null;

    // Fetch player and opponent details from the Discord API
    const discordApiHeaders = {
      headers: {
        Authorization: `Bot ${process.env.BOT_TOKEN}` // Use your bot token
      }
    };

    const [challengerData, challengedData] = await Promise.all([
      axios.get(`https://discord.com/api/users/${game.challenger_id}`, discordApiHeaders),
      axios.get(`https://discord.com/api/users/${game.challenged_id}`, discordApiHeaders)
    ]);

 const [eloRows] = await db.promise().query(
  'SELECT discord_id, elo FROM players WHERE discord_id IN (?, ?)',
  [game.challenger_id, game.challenged_id]
);

let challengerElo = 100;
let challengedElo = 100;

// ELO-Werte direkt zuweisen
eloRows.forEach(row => {
  if (row.discord_id == game.challenger_id) challengerElo = row.elo; 
  if (row.discord_id == game.challenged_id) challengedElo = row.elo;
});

    const challenger = {
      username: challengerData.data.username,
      avatar: challengerData.data.avatar
        ? `https://cdn.discordapp.com/avatars/${game.challenger_id}/${challengerData.data.avatar}.png`
        : '/public/img/default_avatar.png',
      elo: challengerElo
    };

    const challenged = {
      username: challengedData.data.username,
      avatar: challengedData.data.avatar
        ? `https://cdn.discordapp.com/avatars/${game.challenged_id}/${challengedData.data.avatar}.png`
        : '/public/img/default_avatar.png',
      elo: challengedElo
    };

    // Determine user role and color
    const isPlayer = isAuthenticated && (game.challenger_id === userId || game.challenged_id === userId);
    const userColor = isPlayer ? (game.white_player_id === userId ? 'white' : 'black') : null;

    // Assign player and opponent based on the authenticated user
    const player = userId === game.challenger_id ? challenger : challenged;
    const opponent = userId === game.challenger_id ? challenged : challenger;

    // Render the game page with all necessary details
    res.render('game', {
      gameId,
      fen: game.fen,
      userColor,
      isPlayer,
      isAuthenticated,
      player,
      opponent,
      user: req.user || { id: null }
    });
  } catch (error) {
    console.error('Fehler beim Abrufen der Spiel- oder Benutzerdaten:', error.message || error);
    return res.status(500).send('Interner Serverfehler.');
  }
});




app.post('/api/game/move/:gameId', (req, res) => {
  const { gameId } = req.params;
  const { fen, move } = req.body;

  // Validate input
  if (!fen || !move) {
    console.error('Invalid payload:', req.body);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  console.log('Saving move:', { gameId, fen, move });

  // Update the FEN in the database
  db.query(
    'UPDATE active_games SET fen = ? WHERE game_uuid = ?',
    [fen, gameId],
    (err, results) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (results.affectedRows === 0) {
        console.error('Game not found:', gameId);
        return res.status(404).json({ error: 'Game not found' });
      }

      // Broadcast the move
      io.to(gameId).emit('move', { fen, move });
      console.log('Move saved and broadcasted:', { fen, move });
      res.status(200).json({ success: true });
    }
  );
});

const isPlayerInGame = async (gameId, discordId) => {
  const [gameRows] = await db.promise().query(
    'SELECT white_player_id, black_player_id FROM active_games WHERE game_uuid = ?',
    [gameId]
  );

  if (gameRows.length === 0) return false;

  const { white_player_id, black_player_id } = gameRows[0];
  return discordId === white_player_id || discordId === black_player_id;
};

/**
 * Broadcastet die Anzahl der Zuschauer eines Spiels.
 */
function broadcastSpectatorCount(gameId) {
  io.to(gameId).emit('spectatorCount', {
    gameId,
    count: gameSpectators[gameId].size,
  });
}


io.on('connection', (socket) => {
  const discordId = socket.handshake.auth.discordId;
  const isPlayer = socket.handshake.auth.isPlayer;

  if (!discordId) {
    console.error('No Discord ID provided during connection handshake.');
    return socket.disconnect(true); // Disconnect if no ID is provided
  }
socket.on('joinGame', async (gameId) => {
  try {
    // Spieler dem Spiel beitreten lassen
    socket.join(gameId);

    if (!connectedUsers[socket.id]) {
      connectedUsers[socket.id] = gameId;

      // Spielerstatus initialisieren
      gameSpectators[gameId] = gameSpectators[gameId] || new Set();

      // Spiel aus der Datenbank abrufen
      const [gameRows] = await db.promise().query(
        'SELECT * FROM active_games WHERE game_uuid = ?',
        [gameId]
      );

      if (gameRows.length === 0) {
        console.log(`Spiel ${gameId} nicht gefunden.`);
        return;
      }

      const currentGame = gameRows[0];
      const { challenger_id, challenged_id, game_status } = currentGame;

      // Wenn das Spiel bereits beendet ist
      if (game_status === 'game end') {
        console.log(`Spiel ${gameId} ist bereits beendet.`);

        // Timer stoppen, falls vorhanden
        if (gameTimers[gameId]) {
          clearInterval(gameTimers[gameId].intervalId);
          delete gameTimers[gameId];
          console.log(`Timer für Spiel ${gameId} gestoppt.`);
        }

        // Gewinner- und Verliererdaten aus der Datenbank laden
        const winnerData = await fetchDiscordUser(currentGame.winner_id);
        const loserData = await fetchDiscordUser(currentGame.loser_id);

        // Client mitteilen, dass das Spiel beendet ist
        io.to(socket.id).emit('gameEnd', {
          winnerId: currentGame.winner_id,
          loserId: currentGame.loser_id,
          winnerName: winnerData?.username || 'Unknown',
          loserName: loserData?.username || 'Unknown',
          winnerAvatar: winnerData?.avatar || null,
          loserAvatar: loserData?.avatar || null,
          winnerEloBefore: currentGame.elo_score_winner_before,
          winnerEloAfter: currentGame.elo_score_winner_after,
          loserEloBefore: currentGame.elo_score_loser_before,
          loserEloAfter: currentGame.elo_score_loser_after,
          reason: currentGame.game_result || 'game already ended',
        });

        return; // Ende hier
      }

      // Status prüfen: Ist der Spieler aktiv?
      const isPlayer =
        socket.handshake.auth.discordId === challenger_id ||
        socket.handshake.auth.discordId === challenged_id;
        
        // Überprüfen, ob der Benutzer Admin ist
      const [playerRows] = await db.promise().query(
        'SELECT type FROM players WHERE discord_id = ?',
        [socket.handshake.auth.discordId]
      );

      const isAdmin = playerRows.length > 0 && playerRows[0].type === 'admin';
        
       // Überprüfen, ob anonymous_mode auf "yes" steht
      const [settingsRows] = await db.promise().query(
        'SELECT anonymous_mode FROM settings LIMIT 1'
      );
      const anonymousMode = settingsRows.length > 0 && settingsRows[0].anonymous_mode === 'yes';

     if (isPlayer) {
        console.log(`User ${socket.handshake.auth.discordId} ist Spieler in Spiel ${gameId}.`);
      } else if (isAdmin && !anonymousMode) {
        console.log(`User ${socket.handshake.auth.discordId} ist als Admin in Spiel ${gameId}.`);
        io.to(gameId).emit('showAdminSpectatorButton', {
          gameId,
          isAdmin: true,
        });
      } else {
        gameSpectators[gameId].add(socket.id);
        console.log(
          `User ${socket.handshake.auth.discordId} ist Zuschauer in Spiel ${gameId}.`
        );
      }

      // Prüfen, ob beide Spieler verbunden sind
      const connectedPlayerIds = Array.from(
        io.sockets.adapter.rooms.get(gameId) || []
      )
        .map((id) => io.sockets.sockets.get(id)?.handshake.auth?.discordId)
        .filter(
          (id) => id === challenger_id || id === challenged_id
        );

      const bothPlayersConnected =
        connectedPlayerIds.includes(challenger_id) &&
        connectedPlayerIds.includes(challenged_id);

      if (currentGame.game_status !== 'game ended') {
        // Handle the status of the game
        await handleGameStatus(gameId, bothPlayersConnected);
      }

      const timer = gameTimers[gameId];
      if (bothPlayersConnected && timer && !timer.bothPlayersConnected) {
        timer.bothPlayersConnected = true;
        timer.startTimestamp = Date.now(); // Starte den Timer, wenn beide Spieler verbunden sind
        console.log(`Beide Spieler sind verbunden. Timer gestartet für Spiel ${gameId}.`);
      }

      // Wenn der Timer noch nicht läuft, starte ihn
      if (!gameTimers[gameId]) {
        startGameTimer(gameId, io);
      }

      // Aktualisiere die Zuschaueranzahl
      broadcastSpectatorCount(gameId);
    }
  } catch (error) {
    console.error(`Fehler in joinGame für Spiel ${gameId}:`, error);
  }
});

 socket.on("offerDraw", async (data) => {
  const { gameId } = data;

  if (!isPlayer) {
    console.error(`Player ${discordId} is not authorized to offer a draw.`);
    return;
  }

  try {
    const [gameRows] = await db.promise().query(
      "SELECT * FROM active_games WHERE game_uuid = ?",
      [gameId]
    );

    if (gameRows.length === 0) {
      console.error(`Game ${gameId} not found.`);
      return;
    }

    const game = gameRows[0];
    const opponentId =
      game.white_player_id === discordId
        ? game.black_player_id
        : game.white_player_id;

    // Sende die Nachricht nur an den Gegner
    const opponentSocket = Array.from(io.sockets.sockets.values()).find(
      (s) => s.handshake.auth.discordId === opponentId
    );

    if (opponentSocket) {
      opponentSocket.emit("offerDraw", { gameId, from: discordId });
      console.log(
        `Player ${discordId} offered a draw to opponent ${opponentId} in game ${gameId}`
      );
    }
  } catch (error) {
    console.error(`Error handling offerDraw for game ${gameId}:`, error);
  }
});
    

socket.on("drawResponse", async (data) => {
  const { gameId, accepted } = data;

  try {
    const [gameRows] = await db.promise().query(
      "SELECT * FROM active_games WHERE game_uuid = ?",
      [gameId]
    );

    if (gameRows.length === 0) {
      console.error(`Game ${gameId} not found.`);
      return;
    }

    const game = gameRows[0];
    const offererId =
      game.white_player_id === discordId
        ? game.black_player_id
        : game.white_player_id; // Spieler, der das Remis angeboten hat

    if (accepted) {
      // Remis wurde akzeptiert
      await handleGameEnd(gameId, null, "draw", io);

      const offererSocket = Array.from(io.sockets.sockets.values()).find(
        (s) => s.handshake.auth.discordId === offererId
      );

      const opponentSocket = Array.from(io.sockets.sockets.values()).find(
        (s) => s.handshake.auth.discordId === discordId
      );

      if (offererSocket) {
        offererSocket.emit("drawAccepted", {
          message: "Your draw offer was accepted by your opponent.",
          from: discordId, // Spieler, der akzeptiert hat
          to: offererId,   // Spieler, der das Angebot gemacht hat
        });
      }

      if (opponentSocket) {
        opponentSocket.emit("drawAccepted", {
          message: "You accepted your opponent's draw offer.",
          from: discordId, // Spieler, der akzeptiert hat
          to: offererId,   // Spieler, der das Angebot gemacht hat
        });
      }

      console.log(`Draw accepted in game ${gameId}`);
    } else {
      // Remis wurde abgelehnt
      const offererSocket = Array.from(io.sockets.sockets.values()).find(
        (s) => s.handshake.auth.discordId === offererId
      );

      const opponentSocket = Array.from(io.sockets.sockets.values()).find(
        (s) => s.handshake.auth.discordId === discordId
      );

      if (offererSocket) {
        offererSocket.emit("drawDeclined", {
          message: "Your draw offer was declined by your opponent.",
          from: discordId, // Spieler, der abgelehnt hat
          to: offererId,   // Spieler, der das Angebot gemacht hat
        });
      }

      if (opponentSocket) {
        opponentSocket.emit("drawDeclined", {
          message: "You declined your opponent's draw offer.",
          from: discordId, // Spieler, der abgelehnt hat
          to: offererId,   // Spieler, der das Angebot gemacht hat
        });
      }

      console.log(`Draw declined in game ${gameId}`);
    }
  } catch (error) {
    console.error(`Error handling drawResponse for game ${gameId}:`, error);
  }
});
    

 async function handleGameStatus(gameId, bothPlayersConnected) {
  if (!bothPlayersConnected) {
    // Notify users that the game is waiting for the second player
    io.to(gameId).emit(
      'waitingForOpponent',
      'Waiting for your opponent to join...'
    );
  } else {
    // Prüfe, ob der Status "not started" ist, bevor er aktualisiert wird
    const [rows] = await db.promise().query(
      'SELECT game_status FROM active_games WHERE game_uuid = ?',
      [gameId]
    );

    if (rows.length > 0 && rows[0].game_status === 'not started') {
      // Mark the game as started
      await db.promise().query(
        'UPDATE active_games SET game_status = ? WHERE game_uuid = ?',
        ['started', gameId]
      );
      io.to(gameId).emit('gameStart', 'The game has started!');
      await sendGameStartMessage(gameId);
    } else {
      console.log(`Game ${gameId} is not in "not started" status. No update performed.`);
        io.to(gameId).emit('gameStart', 'The game has started!');
    }
  }
}

    
async function sendGameStartMessage(gameId) {
    try {
        // Hole Spieldaten aus der Tabelle `active_games`
        const [gameRows] = await db.promise().query(
            'SELECT * FROM active_games WHERE game_uuid = ?',
            [gameId]
        );

        if (gameRows.length === 0) {
            console.error(`Spiel ${gameId} nicht gefunden.`);
            return;
        }

        const game = gameRows[0];
        const {
            white_player_id: whitePlayerId,
            black_player_id: blackPlayerId,
            guild_id: guildId,
            message_id: oldMessageId,
            game_uuid: gameUUID
        } = game;

        // Hole Guild-Informationen aus der Tabelle `bot_guilds`
        const [guildRows] = await db.promise().query(
            'SELECT * FROM bot_guilds WHERE guild_id = ? LIMIT 1',
            [guildId]
        );

        if (guildRows.length === 0) {
            console.error(`Guild ${guildId} nicht in der Datenbank gefunden.`);
            return;
        }

        const { challenges_channel: challengesChannelId, active_matches_channel: activeMatchesChannelId } = guildRows[0];

        if (!challengesChannelId || !activeMatchesChannelId) {
            console.error(`Challenges or active matches channel für Guild ${guildId} fehlt.`);
            return;
        }

        // Alte Nachricht löschen, wenn vorhanden
        const guild = await bot.guilds.fetch(guildId);
        const challengesChannel = await guild.channels.fetch(challengesChannelId);

        if (oldMessageId && challengesChannel) {
            try {
                const oldMessage = await challengesChannel.messages.fetch(oldMessageId);
                await oldMessage.delete();

                // Entferne die `message_id` aus der Datenbank
                await db.promise().query(
                    'UPDATE active_games SET message_id = NULL WHERE game_uuid = ?',
                    [gameId]
                );

                console.log(`Alte Nachricht mit ID ${oldMessageId} erfolgreich gelöscht.`);
            } catch (error) {
                console.warn(`Nachricht mit ID ${oldMessageId} konnte nicht gelöscht werden:`, error);
            }
        }

        // Neue Nachricht erstellen
        const activeMatchesChannel = await guild.channels.fetch(activeMatchesChannelId);

        if (!activeMatchesChannel) {
            console.error(`Active matches channel mit ID ${activeMatchesChannelId} nicht gefunden.`);
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('New Chessy.gg Match is live right now! 🔴')
        	.setDescription('Watch this awesome match! Click the button below to join as a Live viewer!')
            .addFields(
                { name: 'White', value: `<@${whitePlayerId}>`, inline: true },
                { name: 'VS', value: '\u200B', inline: true },
                { name: 'Black', value: `<@${blackPlayerId}>`, inline: true }
            )
            .setColor('#FF0000')
        	.setImage('https://i.imgur.com/11tOFvU.jpeg')
        	.setFooter({
    						text: 'Powered by Chessy.gg | Revolutionizing chess on Discord',
    						iconURL: 'https://i.imgur.com/H2AFhcV.jpeg',
						});

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Click to watch it live')
                .setStyle(ButtonStyle.Link)
                .setURL(`http://localhost:3000/game/${gameUUID}`)
        );

        const newMessage = await activeMatchesChannel.send({ embeds: [embed], components: [row] });

        // Speichere die neue Nachricht unter `game_started_message_id`
        await db.promise().query(
            'UPDATE active_games SET game_started_message_id = ? WHERE game_uuid = ?',
            [newMessage.id, gameId]
        );

        console.log(`Neue Nachricht für Spiel ${gameId} erfolgreich erstellt und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Senden der Spielstartnachricht für Spiel ${gameId}:`, error);
    }
}



    
socket.on('move', (data) => {
  const { gameId, fen, move } = data;
  const timer = gameTimers[gameId];

  if (!timer) {
    console.error(`No timer found for game ${gameId}`);
    return;
  }

  // Stoppe den Timer des aktuellen Spielers
  const activeKey = `${timer.activeColor}Time`;
  const currentTime = Date.now();
  const elapsed = currentTime - timer.startTimestamp;
  timer[activeKey] -= elapsed;

  // Wechsel zum nächsten Spieler
  timer.activeColor = timer.activeColor === 'white' ? 'black' : 'white';
  timer.startTimestamp = currentTime;

  // Sende Timer-Updates an beide Spieler
  const playerSockets = Array.from(io.sockets.adapter.rooms.get(gameId) || [])
    .map((id) => io.sockets.sockets.get(id))
    .filter((socket) => socket?.handshake.auth.isPlayer);

  const whitePlayer = playerSockets.find(
    (s) => s.handshake.auth.color === 'white'
  );
  const blackPlayer = playerSockets.find(
    (s) => s.handshake.auth.color === 'black'
  );

  if (whitePlayer) {
    whitePlayer.emit('updateTimers', {
      yourTime: timer.whiteTime,
      opponentTime: timer.blackTime,
      isActive: timer.activeColor === 'white',
    });
  }
  if (blackPlayer) {
    blackPlayer.emit('updateTimers', {
      yourTime: timer.blackTime,
      opponentTime: timer.whiteTime,
      isActive: timer.activeColor === 'black',
    });
  }

  // Speichere den Zug in der Datenbank
  db.query(
    'UPDATE active_games SET fen = ? WHERE game_uuid = ?',
    [fen, gameId],
    (err) => {
      if (err) {
        console.error('Database error:', err);
        return;
      }

      // Broadcast the move to all players in the room
      io.to(gameId).emit('move', { fen, move });
    }
  );
});

  socket.on('gameEnd', async (data) => { 
    const { gameId, winnerColor, reason } = data;

    try {
        await handleGameEnd(gameId, winnerColor, reason, io);
    } catch (error) {
        console.error(`Fehler beim Verarbeiten von gameEnd für Spiel ${gameId}:`, error);
    }
});



socket.on('disconnect', async () => {
  const socketId = socket.id;
  const gameId = connectedUsers[socketId];
  const userDiscordId = socket.handshake.auth.discordId;

  if (!gameId || !userDiscordId) {
    console.log(`Unknown disconnection for socket: ${socketId}`);
    return;
  }

  console.log(`Player ${userDiscordId} disconnected from game ${gameId}`);

  if (gameSpectators[gameId]) {
    gameSpectators[gameId].delete(socketId);
    delete connectedUsers[socketId];

    // Broadcast updated spectator count
    io.to(gameId).emit('spectatorCount', {
      gameId,
      count: gameSpectators[gameId].size,
    });
  }

  const [playerRows] = await db.promise().query(
    'SELECT type FROM players WHERE discord_id = ?',
    [userDiscordId]
  );

  const isAdmin = playerRows.length > 0 && playerRows[0].type === 'admin';

  if (isAdmin) {
    io.to(gameId).emit('showAdminSpectatorButton', {
      gameId,
      isAdmin: false,
    });
    console.log(`Admin ${userDiscordId} hat das Spiel ${gameId} verlassen.`);
  }

  const timer = gameTimers[gameId];
  if (!timer) return;

  try {
    // Fetch game data from the database
    const [rows] = await db.promise().query(
      'SELECT white_player_id, black_player_id, game_status FROM active_games WHERE game_uuid = ?',
      [gameId]
    );

    if (rows.length === 0) {
      console.error(`Game with ID ${gameId} not found in database.`);
      return;
    }

    const { 
      white_player_id: whitePlayerId, 
      black_player_id: blackPlayerId, 
      game_status: gameStatus 
    } = rows[0];

    // Check if the game status is not "started"
    if (gameStatus !== 'started') {
      console.log(`Game ${gameId} is not in progress (status: ${gameStatus}). No action taken.`);
      return;
    }

    let winnerId, reason, winnerColor;

    // Determine winner, reason, and winnerColor
    if (userDiscordId === whitePlayerId) {
      winnerId = blackPlayerId;
      winnerColor = 'black';
      reason = 'disconnect';
    } else if (userDiscordId === blackPlayerId) {
      winnerId = whitePlayerId;
      winnerColor = 'white';
      reason = 'disconnect';
    } else {
      console.error(`Player ${userDiscordId} is not part of game ${gameId}`);
      return;
    }

    console.log(
      `Player ${userDiscordId} disconnected. Winner: ${winnerId}, Color: ${winnerColor}`
    );

    // Handle game end using existing handler
    await handleGameEnd(gameId, winnerColor, reason, io);

    // Cleanup
    delete gameTimers[gameId];
  } catch (err) {
    console.error(`Error handling disconnection for game ${gameId}:`, err);
  }
});


});

app.post('/api/game/move/:gameId', (req, res) => {
  const { gameId } = req.params;
  const { fen, move } = req.body;

  if (!fen || !move) {
    console.error('Invalid payload:', req.body);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  db.query(
    'UPDATE active_games SET fen = ? WHERE game_uuid = ?',
    [fen, gameId],
    (err, results) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (results.affectedRows === 0) {
        console.error('Game not found:', gameId);
        return res.status(404).json({ error: 'Game not found' });
      }

      // Emit the move to all players in the room
      io.to(gameId).emit('move', { fen, move });
      console.log(`Move broadcasted to game ${gameId}:`, { fen, move });

      res.status(200).json({ success: true });
    }
  );
});

app.get('/api/game/state/:gameId', async (req, res) => {
  const { gameId } = req.params;

  try {
    const [rows] = await db.promise().query('SELECT fen FROM active_games WHERE game_uuid = ?', [gameId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Spiel nicht gefunden.' });
    }

    res.status(200).json({ fen: rows[0].fen });
  } catch (error) {
    console.error('Fehler beim Abrufen des Spiels:', error);
    res.status(500).json({ error: 'Interner Serverfehler.' });
  }
});

app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Fehler beim Abmelden:', err);
      return res.redirect('/your-servers');
    }
    req.session.destroy(() => {
      res.redirect('/');
    });
  });
});

app.get('/player', checkAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = 5; // Maximal 5 Spiele pro Seite

    // Aktuelle Seiten aus der URL, Standardwert 1
    const notStartedPage = parseInt(req.query.notStartedPage, 10) || 1;
    const activePage = parseInt(req.query.activePage, 10) || 1;
    const completedPage = parseInt(req.query.completedPage, 10) || 1;

    const offset = (page) => (page - 1) * limit;

    // Fetch user's Discord avatar
    const { data: userDiscordData } = await axios.get(`https://discord.com/api/users/${userId}`, {
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
    });

    const userAvatar = userDiscordData.avatar
      ? `https://cdn.discordapp.com/avatars/${userId}/${userDiscordData.avatar}.png`
      : '/public/img/default_avatar.png';

    // Fetch user's ELO from the database
    const [playerRows] = await db.promise().query(
      'SELECT elo FROM players WHERE discord_id = ?',
      [userId]
    );

    const userElo = playerRows.length > 0 ? playerRows[0].elo : '100';

    // Fetch games by status with pagination
    const [notStartedGames] = await db.promise().query(
      `SELECT * FROM active_games WHERE (challenger_id = ? OR challenged_id = ?) AND game_status = 'not started' ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [userId, userId, limit, offset(notStartedPage)]
    );

    const [activeGames] = await db.promise().query(
      `SELECT * FROM active_games WHERE (challenger_id = ? OR challenged_id = ?) AND game_status = 'started' ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [userId, userId, limit, offset(activePage)]
    );

    const [completedGames] = await db.promise().query(
      `SELECT * FROM active_games WHERE (challenger_id = ? OR challenged_id = ?) AND game_status = 'game end' ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [userId, userId, limit, offset(completedPage)]
    );

    // Total counts for each category
    const [notStartedTotal] = await db.promise().query(
      'SELECT COUNT(*) as total FROM active_games WHERE (challenger_id = ? OR challenged_id = ?) AND game_status = "not started"',
      [userId, userId]
    );

    const [activeTotal] = await db.promise().query(
      'SELECT COUNT(*) as total FROM active_games WHERE (challenger_id = ? OR challenged_id = ?) AND game_status = "started"',
      [userId, userId]
    );

    const [completedTotal] = await db.promise().query(
      'SELECT COUNT(*) as total FROM active_games WHERE (challenger_id = ? OR challenged_id = ?) AND game_status = "game end"',
      [userId, userId]
    );

    const formatGames = async (games) => {
      return await Promise.all(
        games.map(async (game) => {
          const opponentId =
            game.challenger_id === userId ? game.challenged_id : game.challenger_id;

          // Fetch opponent details
          const { data: opponent } = await axios.get(
            `https://discord.com/api/users/${opponentId}`,
            { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } }
          );

          // Fetch server name using guild_id directly from active_games
          const { data: serverData } = await axios.get(
            `https://discord.com/api/guilds/${game.guild_id}`,
            { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } }
          );
            
      let resultBadge = 'Draw';
let badgeClass = 'draw'; // Standardklasse für Unentschieden

if (game.game_status === 'draw' && !game.winner_id) {
  // Kein Gewinner, Spiel endete unentschieden
  resultBadge = 'Draw';
  badgeClass = 'draw';
} else if (game.winner_id === userId) {
  // Benutzer hat gewonnen
  resultBadge = `You won by ${game.game_result}`;
  badgeClass = 'won';
} else if (game.winner_id && game.winner_id !== userId) {
  // Benutzer hat verloren
  resultBadge = `You lost by ${game.game_result}`;
  badgeClass = 'lost';
}

          return {
            ...game,
            opponent: {
              username: opponent.username,
              avatar: opponent.avatar
                ? `https://cdn.discordapp.com/avatars/${opponentId}/${opponent.avatar}.png`
                : '/public/img/default_avatar.png',
            },
            serverName: serverData.name || 'Unknown Server',
            playerColor: game.white_player_id === userId ? 'white' : 'black',
            resultBadge,
  			badgeClass,
          };
        })
      );
    };

    res.render('player', {
      user: req.user,
      userAvatar,
      userElo,
      notStartedGames: {
        items: await formatGames(notStartedGames),
        total: notStartedTotal[0].total,
        currentPage: notStartedPage,
        totalPages: Math.ceil(notStartedTotal[0].total / limit),
      },
      activeGames: {
        items: await formatGames(activeGames),
        total: activeTotal[0].total,
        currentPage: activePage,
        totalPages: Math.ceil(activeTotal[0].total / limit),
      },
      completedGames: {
        items: await formatGames(completedGames),
        total: completedTotal[0].total,
        currentPage: completedPage,
        totalPages: Math.ceil(completedTotal[0].total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching games or user data:', error.message || error);
    res.status(500).send('Internal Server Error');
  }
});



const updateElo = async (winnerId, loserId) => {
  try {
    // Add 9 ELO to the winner
    await db.promise().query(
      'UPDATE players SET elo = elo + 9 WHERE discord_id = ?',
      [winnerId]
    );

    // Subtract 6 ELO from the loser
    await db.promise().query(
      'UPDATE players SET elo = elo - 6 WHERE discord_id = ?',
      [loserId]
    );

    console.log(`ELO updated: Winner (${winnerId}) +9, Loser (${loserId}) -6`);
  } catch (error) {
    console.error('Error updating ELO:', error);
  }
};

async function startGameTimer(gameId, io) {
  try {
    // Fetch the selected_time from the database
    const [gameRows] = await db.promise().query(
      'SELECT selected_time FROM active_games WHERE game_uuid = ?',
      [gameId]
    );

    if (gameRows.length === 0) {
      console.error(`Game with ID ${gameId} not found.`);
      return;
    }

    const initialGameTime = gameRows[0].selected_time; // Time is already in milliseconds

    // Initialize game timers
    gameTimers[gameId] = {
      whiteTime: initialGameTime,
      blackTime: initialGameTime,
      activeColor: 'white',
      startTimestamp: null, // Timer starts only when both players are connected
      bothPlayersConnected: false, // Player connection status
    };

    console.log(`Timer for game ${gameId} initialized with ${initialGameTime} ms.`);

    // Timer tick interval
    gameTimers[gameId].intervalId = setInterval(async () => {
      const timer = gameTimers[gameId];
      if (!timer || !timer.bothPlayersConnected) return; // Wait until both players are connected

      const currentTime = Date.now();
      const elapsed = currentTime - timer.startTimestamp;
      timer.startTimestamp = currentTime;

      // Reduce active player's time
      const activeKey = `${timer.activeColor}Time`;
      timer[activeKey] -= elapsed;

      // Debug output
      console.log(
        `Game ${gameId} | White: ${timer.whiteTime}ms | Black: ${timer.blackTime}ms`
      );

      // Send timer updates to players
      io.to(gameId).emit('updateTimers', {
        whiteTime: timer.whiteTime,
        blackTime: timer.blackTime,
        activeColor: timer.activeColor,
      });

      // Check if timer has run out
      if (timer[activeKey] <= 0) {
        clearInterval(timer.intervalId);
        delete gameTimers[gameId];

        const winnerColor = timer.activeColor === 'white' ? 'black' : 'white';

        // End the game (update the database and notify players)
        try {
          await handleGameEnd(gameId, winnerColor, 'time out', io);
        } catch (error) {
          console.error(`Error ending game ${gameId}:`, error);
        }
      }
    }, 1000); // 1-second interval
  } catch (error) {
    console.error(`Error initializing game timer for game ${gameId}:`, error);
  }
}


async function handleGameEnd(gameId, winnerColor, reason, io) {
    try {
        const [gameRows] = await db.promise().query(
            'SELECT * FROM active_games WHERE game_uuid = ?',
            [gameId]
        );

        if (gameRows.length === 0) {
            console.error(`Spiel ${gameId} nicht gefunden.`);
        } else {
            const game = gameRows[0];

            if (game.game_status === 'game end') {
                console.log(`Spiel ${gameId} ist bereits beendet.`);
            } else {
                if (gameTimers[gameId]) {
                    clearInterval(gameTimers[gameId].intervalId);
                    delete gameTimers[gameId];
                    console.log(`Timer für Spiel ${gameId} gestoppt.`);
                }

                await db.promise().query(
                    'UPDATE active_games SET game_status = ?, game_result = ? WHERE game_uuid = ?',
                    ['game end', reason, gameId]
                );

                if (reason === 'draw' || reason === 'threefold repetition' || reason === 'insufficient material') {
                    io.to(gameId).emit('gameEnd', {
                        winnerId: null,
                        loserId: null,
                        reason,
                        winnerEloBefore: null,
                        winnerEloAfter: null,
                        loserEloBefore: null,
                        loserEloAfter: null,
                    });
                    sendWinnerMessage(gameId);
                } else {
                    const winnerId = winnerColor === 'white' ? game.white_player_id : game.black_player_id;
                    const loserId = winnerColor === 'white' ? game.black_player_id : game.white_player_id;

                    const [eloRows] = await db.promise().query(
                        'SELECT discord_id, elo FROM players WHERE discord_id IN (?, ?)',
                        [winnerId, loserId]
                    );

                    const winnerEloBefore = Number(eloRows.find(row => row.discord_id === winnerId)?.elo || 1000);
                    const loserEloBefore = Number(eloRows.find(row => row.discord_id === loserId)?.elo || 1000);

                    const K = 32; // Standard K-Faktor

                    const winnerExpectation = 1 / (1 + Math.pow(10, (loserEloBefore - winnerEloBefore) / 400));
                    const loserExpectation = 1 / (1 + Math.pow(10, (winnerEloBefore - loserEloBefore) / 400));

                    const winnerScore = 1; // Gewinner erzielt immer 1
                    const loserScore = 0; // Verlierer erzielt immer 0

                    const winnerEloAfter = winnerEloBefore + K * (winnerScore - winnerExpectation);
                    const loserEloAfter = loserEloBefore + K * (loserScore - loserExpectation);

                    await db.promise().query('UPDATE players SET elo = ? WHERE discord_id = ?', [Math.round(winnerEloAfter), winnerId]);
                    await db.promise().query('UPDATE players SET elo = ? WHERE discord_id = ?', [Math.round(loserEloAfter), loserId]);

                    const winnerData = await fetchDiscordUser(winnerId);

                    await db.promise().query(
                        `UPDATE active_games 
                         SET winner_id = ?, loser_id = ?, game_result = ?, 
                             elo_score_winner_before = ?, elo_score_winner_after = ?, 
                             elo_score_loser_before = ?, elo_score_loser_after = ? 
                         WHERE game_uuid = ?`,
                        [
                            winnerId,
                            loserId,
                            reason,
                            winnerEloBefore,
                            Math.round(winnerEloAfter),
                            loserEloBefore,
                            Math.round(loserEloAfter),
                            gameId
                        ]
                    );

                    // Insert the winner into the 'wins' table
                    await db.promise().query(
                        `INSERT INTO wins (discord_id, guild_id, game_uuid, date) VALUES (?, ?, ?, NOW())`,
                        [winnerId, game.guild_id, gameId]
                    );

                    io.to(gameId).emit('gameEnd', {
                        winnerId,
                        loserId,
                        winnerName: winnerData?.username || 'Unknown',
                        winnerAvatar: winnerData?.avatar || null,
                        winnerEloBefore,
                        winnerEloAfter: Math.round(winnerEloAfter),
                        loserEloBefore,
                        loserEloAfter: Math.round(loserEloAfter),
                        reason
                    });

                    sendWinnerMessage(gameId);
                }
            }
        }
    } catch (error) {
        console.error(`Fehler beim Beenden des Spiels ${gameId}:`, error);
    }
}




async function fetchDiscordUser(userId) {
    if (!userId) {
        console.error("fetchDiscordUser: Keine gültige UserID übergeben");
        return { username: 'Unknown', avatar: '/public/img/default_avatar.png' };
    }

    try {
        const response = await axios.get(`https://discord.com/api/users/${userId}`, {
            headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
        });
        const userData = response.data;

        return {
            username: userData.username || 'Unknown',
            avatar: userData.avatar
                ? `https://cdn.discordapp.com/avatars/${userId}/${userData.avatar}.png`
                : '/public/img/default_avatar.png',
        };
    } catch (error) {
        console.error(`Fehler beim Abrufen der Benutzerdaten für ID ${userId}:`, error.message);
        return {
            username: 'Unknown',
            avatar: '/public/img/default_avatar.png',
        };
    }
}

async function sendWinnerMessage(gameId) {
    try {
        // Hole Spieldaten aus der Tabelle `active_games`
        const [gameRows] = await db.promise().query(
            'SELECT * FROM active_games WHERE game_uuid = ?',
            [gameId]
        );

        if (gameRows.length === 0) {
            console.error(`Spiel ${gameId} nicht gefunden.`);
            return;
        }

        const game = gameRows[0];
        const {
            winner_id: winnerId,
            loser_id: loserId,
            challenger_id: challengerId,
            challenged_id: challengedId,
            guild_id: guildId,
            game_uuid: gameUUID,
            game_result: gameResult,
        } = game;

        // Prüfe den Status des Spiels
        if (game.game_status !== 'game end') {
            console.log(`Spiel ${gameId} ist noch nicht beendet.`);
            return;
        }

        // Hole Guild-Informationen aus der Tabelle `bot_guilds`
        const [guildRows] = await db.promise().query(
            'SELECT finished_matches_channel FROM bot_guilds WHERE guild_id = ?',
            [guildId]
        );

        if (guildRows.length === 0) {
            console.error(`Guild ${guildId} nicht in der Datenbank gefunden.`);
            return;
        }

        const finishedMatchesChannelId = guildRows[0].finished_matches_channel;

        if (!finishedMatchesChannelId) {
            console.error(`Kein Channel für beendete Spiele in Guild ${guildId} konfiguriert.`);
            return;
        }

        // Nachricht basierend auf dem Ergebnis erstellen
        let embed;

        if (['draw', 'threefold repetition', 'insufficient material'].includes(gameResult)) {
            embed = new EmbedBuilder()
                .setTitle('🤝 Chessy.gg Game Result')
                .setDescription(
                    `**This game was challenged by:** <@${challengerId}>\n\n` +
                    `**Players:** <@${challengerId}> vs <@${challengedId}>\n\n` +
                    `**Game ended in a draw because of:** **${gameResult.replace(/_/g, ' ')}**.`
                )
                .addFields({
                    name: 'Rewatch the Game',
                    value: `[Click here](http://localhost:3000/game/${gameUUID}) to replay the match.`,
                })
                .setColor('#0366fc')
            	.setImage('https://i.imgur.com/ridydOZ.jpeg')
            	.setFooter({
    						text: 'Powered by Chessy.gg | Revolutionizing chess on Discord',
    						iconURL: 'https://i.imgur.com/H2AFhcV.jpeg',
						})
                .setTimestamp();
        } else {
            embed = new EmbedBuilder()
                .setTitle('🏆 Chessy.gg Game Result')
                .setDescription(
                    `**This game was challenged by:** <@${challengerId}>\n\n` +
                    `**Winner:** <@${winnerId}>\n` +
                    `**Loser:** <@${loserId}>\n\n` +
                    `**Game ended in:** **${gameResult.replace(/_/g, ' ')}**.`
                )
                .addFields({
                    name: 'Rewatch the Game',
                    value: `[Click here](http://localhost:3000/game/${gameUUID}) to replay the match.`,
                })
                .setColor('#0366fc')
            	.setImage('https://i.imgur.com/ridydOZ.jpeg')
            	.setFooter({
    						text: 'Powered by Chessy.gg | Revolutionizing chess on Discord',
    						iconURL: 'https://i.imgur.com/H2AFhcV.jpeg',
						})
                .setTimestamp();
        }

        // Sende die Nachricht in den konfigurierten Channel
        const guild = await bot.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(finishedMatchesChannelId);

        if (!channel) {
            console.error(
                `Channel ${finishedMatchesChannelId} existiert nicht in Guild ${guildId}.`
            );
            return;
        }

        await channel.send({ embeds: [embed] });
        console.log(`Winner message für Spiel ${gameId} erfolgreich gesendet.`);
        await deleteLiveMessage(gameId);
        
    } catch (error) {
        console.error(`Fehler beim Senden der Winner Message für Spiel ${gameId}:`, error);
    }
}

async function deleteLiveMessage(gameId) {
    try {
        // Hole Spieldaten aus der Tabelle `active_games`
        const [gameRows] = await db.promise().query(
            'SELECT guild_id, game_started_message_id FROM active_games WHERE game_uuid = ?',
            [gameId]
        );

        if (gameRows.length === 0) {
            console.error(`Spiel ${gameId} nicht gefunden.`);
            return;
        }

        const { guild_id: guildId, game_started_message_id: messageId } = gameRows[0];

        if (!messageId) {
            console.log(`Keine Live-Nachricht für Spiel ${gameId} vorhanden.`);
            return;
        }

        // Hole Guild-Informationen aus der Tabelle `bot_guilds`
        const [guildRows] = await db.promise().query(
            'SELECT active_matches_channel FROM bot_guilds WHERE guild_id = ?',
            [guildId]
        );

        if (guildRows.length === 0) {
            console.error(`Guild ${guildId} nicht in der Datenbank gefunden.`);
            return;
        }

        const activeMatchesChannelId = guildRows[0].active_matches_channel;

        if (!activeMatchesChannelId) {
            console.error(`Kein aktiver Channel für Spiele in Guild ${guildId} konfiguriert.`);
            return;
        }

        // Lösche die Nachricht im Channel
        const guild = await bot.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(activeMatchesChannelId);

        if (!channel) {
            console.error(`Channel ${activeMatchesChannelId} existiert nicht in Guild ${guildId}.`);
            return;
        }

        try {
            const message = await channel.messages.fetch(messageId);
            await message.delete();
            console.log(`Live-Nachricht für Spiel ${gameId} erfolgreich gelöscht.`);
        } catch (error) {
            console.error(`Nachricht mit ID ${messageId} konnte nicht gelöscht werden:`, error);
        }

        // Lösche die `game_started_message_id` aus der Datenbank
        await db.promise().query(
            'UPDATE active_games SET game_started_message_id = NULL WHERE game_uuid = ?',
            [gameId]
        );

        console.log(`game_started_message_id für Spiel ${gameId} erfolgreich aus der Datenbank gelöscht.`);
    } catch (error) {
        console.error(`Fehler beim Löschen der Live-Nachricht für Spiel ${gameId}:`, error);
    }
}



app.post('/send-leaderboard', async (req, res) => {
  const { channelId, guildId, replace } = req.body;

  if (!guildId || !channelId) {
    return res.status(400).json({ status: 'error', message: 'Guild ID or Channel ID is missing' });
  }

  try {
    const [serverRows] = await db.promise().query('SELECT * FROM bot_guilds WHERE guild_id = ?', [guildId]);
    if (serverRows.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Guild not found' });
    }

    const server = serverRows[0];

    const guild = await bot.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);

    // Überprüfe, ob ein Leaderboard bereits gesendet wurde
    if (server.leaderboard_message_id && !replace) {
      try {
        const existingMessage = await channel.messages.fetch(server.leaderboard_message_id);

        if (existingMessage) {
          return res.status(400).json({
            status: 'error',
            message: 'A leaderboard has already been sent. Would you like to replace it?',
          });
        }
      } catch (fetchError) {
        console.log(`Message with ID ${server.leaderboard_message_id} does not exist. Sending a new one.`);
      }
    }

    let messageId = server.leaderboard_message_id;

    if (replace && messageId) {
      try {
        const existingMessage = await channel.messages.fetch(messageId);
        if (existingMessage) {
          await existingMessage.delete();
          console.log(`Old leaderboard message deleted.`);
          messageId = null;
        }
      } catch (error) {
        console.log(`Failed to delete old leaderboard message: ${error.message}`);
      }
    }

    const newMessageId = await sendOrUpdateLeaderboard(guildId, channelId, messageId);

    if (!messageId && newMessageId) {
      // Update the database with the new message ID
      await db.promise().query('UPDATE bot_guilds SET leaderboard_message_id = ? WHERE guild_id = ?', [newMessageId, guildId]);
    }

    res.json({ status: 'success', message: 'Leaderboard sent or updated successfully!' });
  } catch (error) {
    console.error(`Error in /send-leaderboard endpoint:`, error);
    res.status(500).json({ status: 'error', message: 'Failed to send or update leaderboard.' });
  }
});

const sendOrUpdateLeaderboard = async (guildId, channelId, messageId) => {
  try {
    // Fetch players and their wins based on the guild ID
    const [rows] = await db.promise().query(
      `SELECT discord_id, COUNT(*) AS wins
       FROM wins
       WHERE guild_id = ?
       GROUP BY discord_id
       ORDER BY wins DESC
       LIMIT 30`,
      [guildId]
    );

    let leaderboard;
    if (rows.length === 0) {
      console.log(`No players found for guild ID ${guildId}.`);
      leaderboard = "No data available right now! Come back in 24 hours!";
    } else {
      // Generate the leaderboard
      leaderboard = rows
        .map((row, index) => {
          const winLabel = row.wins === 1 ? "Win" : "Wins";
          return `**#${index + 1}** <@${row.discord_id}> - **${row.wins} ${winLabel}**`;
        })
        .join("\n");
    }

    // Add the current date and time
    const lastUpdated = new Date().toLocaleString();

    // Create the embed
    const embed = new EmbedBuilder()
      .setTitle("🏆 Chess Leaderboard")
      .setDescription(`${leaderboard}\n\nWant to play chess with your community on your own server? [Join chessy.gg](http://localhost:3000)`)
      .setColor("#7289DA")
      .setImage("https://i.imgur.com/CVC9H2F.jpeg")
      .setFooter({ text: `Powered by Chessy.gg | Revolutionizing chess on Discord | This leaderboard updates automatically! | Last updated: ${lastUpdated}` });

    const guild = await bot.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);

    if (messageId) {
      // Update the existing message
      const message = await channel.messages.fetch(messageId);
      await message.edit({ embeds: [embed] });
      console.log(`Leaderboard updated for guild ID ${guildId}.`);
    } else {
      // Send a new message
      const sentMessage = await channel.send({ embeds: [embed] });
      console.log(`Leaderboard created for guild ID ${guildId}.`);
      return sentMessage.id; // Return the ID of the new message
    }
  } catch (error) {
    console.error(`Failed to send or update leaderboard for guild ID ${guildId}:`, error);
    throw error;
  }
};


const sendAutomaticLeaderboards = async () => {
  try {
    // Fetch all guilds with a stored message_id
    const [guildRows] = await db.promise().query(
      'SELECT guild_id, leaderboard_channel, leaderboard_message_id FROM bot_guilds WHERE leaderboard_message_id IS NOT NULL'
    );

    for (const guild of guildRows) {
      const guildId = guild.guild_id;
      const channelId = guild.leaderboard_channel;
      const messageId = guild.leaderboard_message_id;

      if (!channelId || !messageId) {
        console.warn(`Missing channel or message ID for guild ID ${guildId}.`);
        continue;
      }

      try {
        // Fetch players and their wins based on the guild ID
        const [rows] = await db.promise().query(
          `SELECT discord_id, COUNT(*) AS wins
           FROM wins
           WHERE guild_id = ?
           GROUP BY discord_id
           ORDER BY wins DESC
           LIMIT 30`,
          [guildId]
        );

        let leaderboard;
        if (rows.length === 0) {
          console.log(`No players found for guild ID ${guildId}.`);
          leaderboard = "No data available right now! Come back in 24 hours!";
        } else {
          // Generate the leaderboard
          leaderboard = rows
            .map((row, index) => {
              const winLabel = row.wins === 1 ? "Win" : "Wins";
              return `**#${index + 1}** <@${row.discord_id}> - **${row.wins} ${winLabel}**`;
            })
            .join("\n");
        }

        // Add the current date and time
        const lastUpdated = new Date().toLocaleString();

        // Create the embed
        const embed = new EmbedBuilder()
          .setTitle("🏆 Chess Leaderboard")
          .setDescription(`${leaderboard}\n\nWant to play chess with your community on your own server? [Join chessy.gg](http://localhost:3000)`)
          .setColor("#7289DA")
          .setImage("https://i.imgur.com/CVC9H2F.jpeg")
          .setFooter({ text: `Powered by Chessy.gg | Revolutionizing chess on Discord | This leaderboard updates automatically! | Last updated: ${lastUpdated}` });

        const guildInstance = await bot.guilds.fetch(guildId);
        const channel = await guildInstance.channels.fetch(channelId);

        // Update the existing message
        const message = await channel.messages.fetch(messageId);
        await message.edit({ embeds: [embed] });

        console.log(`Leaderboard updated for guild ID ${guildId}.`);
      } catch (error) {
        console.error(`Failed to update leaderboard for guild ID ${guildId}:`, error);
      }
    }

    console.log('Leaderboards updated for all guilds successfully.');
  } catch (error) {
    console.error('Failed to update leaderboards for all guilds:', error);
  }
};


app.use((req, res) => {
  res.status(404).render('404', {
    message: "Oops! Looks like this move wasn't valid.",
    suggestion: "Check your path and try again!",
  });
});

const scheduleDailyLeaderboardUpdate = () => {
  schedule.scheduleJob('0 0 * * *', async () => {
    console.log('Executing daily leaderboard update...');
    try {
      await sendAutomaticLeaderboards();
      console.log('Daily leaderboard update completed successfully.');
    } catch (error) {
      console.error('Error during daily leaderboard update:', error);
    }
  });
};

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});



server.listen(process.env.PORT, () => console.log(`Chessyo.gg is running!`));
module.exports = app;