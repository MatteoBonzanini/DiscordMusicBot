
import ffmpegPath from 'ffmpeg-static';

process.env.FFMPEG_PATH = ffmpegPath;

import dotenv from 'dotenv';
import { decrypt } from './cypher.js';

dotenv.config();

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST, 
  Routes, 
  EmbedBuilder
 } from "discord.js";

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";

import { spawn, execSync } from "child_process";
import * as path from 'path';
const ytDlpPath = path.join(import.meta.dirname, "yt-dlp.exe");

// ─── Configuration ───────────────────────────────────────────────
const TOKEN = decrypt(process.env.CYPHER_DISCORD_TOKEN, process.env.CYPHER_IV, process.env.CYPHER_KEY) || "Insert your bot token here";
const CLIENT_ID = process.env.CLIENT_ID || "Insert your client ID here";

// ─── Bot Setup ───────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const queues = new Map();

// ─── Slash Commands ──────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Riproduci una canzone da YouTube")
    .addStringOption((opt) =>
      opt.setName("url").setDescription("URL di YouTube o termine di ricerca").setRequired(true)
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Salta la canzone corrente"),
  new SlashCommandBuilder().setName("stop").setDescription("Ferma la musica e svuota la coda"),
  new SlashCommandBuilder().setName("queue").setDescription("Mostra la coda di riproduzione"),
  new SlashCommandBuilder().setName("pause").setDescription("Metti in pausa la canzone corrente"),
  new SlashCommandBuilder().setName("resume").setDescription("Riprendi la riproduzione"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Mostra la canzone in riproduzione"),
].map((cmd) => cmd.toJSON());

async function deployCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("[INFO] Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("[OK] Slash commands registered!");
  } catch (err) {
    console.error("[ERROR] Failed to register commands:", err);
  }
}

// ─── Queue Helpers ───────────────────────────────────────────────

function getQueue(guildId) {
  return queues.get(guildId);
}

function createQueue(guildId, textChannel) {
  const player = createAudioPlayer();
  const queue = {
    songs: [],
    player,
    connection: null,
    textChannel,
    destroyed: false,
    currentProcess: null,
  };
  queues.set(guildId, queue);
  return queue;
}

function destroyQueue(guildId) {
  const queue = getQueue(guildId);
  if (!queue || queue.destroyed) return;
  queue.destroyed = true;
  queue.player.stop(true);
  if (queue.currentProcess) {
    try { queue.currentProcess.kill(); } catch (e) {}
  }
  try {
    if (queue.connection) queue.connection.destroy();
  } catch (e) {}
  queues.delete(guildId);
}

// ─── Stream audio: yt-dlp → ffmpeg → Discord ────────────────────

function createYTStream(url) {
  // Step 1: yt-dlp downloads and outputs raw audio to stdout
  const ytdlp = spawn(ytDlpPath, [
    url,
    "-f", "bestaudio",
    "--ffmpeg-location", ffmpegPath,
    "--no-playlist",
    "--no-warnings",
    "-o", "-",
  ]);

  // Step 2: ffmpeg converts to Opus in OGG container (what Discord wants)
  const ffmpeg = spawn(ffmpegPath, [
    "-i", "pipe:0",
    "-analyzeduration", "0",
    "-loglevel", "0",
    "-f", "opus",
    "-ar", "48000",
    "-ac", "2",
    "-acodec", "libopus",
    "-b:a", "96k",
    "pipe:1",
  ]);

  // Pipe yt-dlp stdout → ffmpeg stdin
  ytdlp.stdout.pipe(ffmpeg.stdin);

  // Handle errors silently to prevent crashes
  ytdlp.stderr.on("data", () => {});
  ffmpeg.stderr.on("data", () => {});
  ytdlp.on("error", () => {});
  ffmpeg.on("error", () => {});
  ytdlp.stdin?.on("error", () => {});
  ffmpeg.stdin.on("error", () => {});
  ffmpeg.stdout.on("error", () => {});

  ytdlp.on("close", () => {
    try { ffmpeg.stdin.end(); } catch (e) {}
  });

  return { stream: ffmpeg.stdout, process: ytdlp, ffmpegProcess: ffmpeg };
}

// ─── Play Song ───────────────────────────────────────────────────

async function playSong(guildId) {
  const queue = getQueue(guildId);
  if (!queue || queue.destroyed || queue.songs.length === 0) {
    destroyQueue(guildId);
    return;
  }

  const song = queue.songs[0];

  try {
    const { stream, process: ytProc, ffmpegProcess } = createYTStream(song.url);

    queue.currentProcess = ytProc;

    const resource = createAudioResource(stream, {
      inputType: StreamType.OggOpus,
      inlineVolume: false,
    });

    queue.player.play(resource);

    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("🎶 In riproduzione")
      .setDescription(`[${song.title}](${song.url})`)
      .addFields({ name: "Durata", value: song.duration, inline: true })
      .setThumbnail(song.thumbnail);

    queue.textChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Error playing song:", err.message);
    queue.textChannel.send(`❌ Errore nella riproduzione: ${err.message}`);
    queue.songs.shift();
    if (!queue.destroyed) playSong(guildId);
  }
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "N/A";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getVideoInfo(input) {
  const result = execSync(
    `"${ytDlpPath}" --dump-json --no-playlist --no-warnings --ffmpeg-location "${ffmpegPath}" "${input}"`,
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
  );
  return JSON.parse(result);
}

// ─── Events ──────────────────────────────────────────────────────

client.once("clientReady", () => {
  console.log(`[OK] Bot online as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, member, channel } = interaction;

  if (commandName === "play") {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: "❌ Devi essere in un canale vocale!", ephemeral: true });
    }

    await interaction.deferReply();

    const input = interaction.options.getString("url");
    let songInfo;

    try {
      const info = getVideoInfo(input);
      songInfo = {
        title: info.title,
        url: info.webpage_url || info.original_url,
        duration: formatDuration(info.duration),
        thumbnail: info.thumbnail || "",
      };
    } catch (err) {
      console.error("Error fetching video info:", err.message);
      return interaction.editReply("❌ Errore nel recupero delle informazioni del video.");
    }

    let queue = getQueue(guildId);

    if (!queue) {
      queue = createQueue(guildId, channel);

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      queue.connection = connection;
      connection.subscribe(queue.player);

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          destroyQueue(guildId);
        }
      });

      queue.player.on(AudioPlayerStatus.Idle, () => {
        const q = getQueue(guildId);
        if (q && !q.destroyed) {
          q.songs.shift();
          playSong(guildId);
        }
      });

      queue.player.on("error", (err) => {
        console.error("Player error:", err.message);
        const q = getQueue(guildId);
        if (q && !q.destroyed) {
          q.songs.shift();
          playSong(guildId);
        }
      });
    }

    queue.songs.push(songInfo);

    if (queue.songs.length === 1) {
      await interaction.editReply(`🔎 Caricamento: **${songInfo.title}**`);
      playSong(guildId);
    } else {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("➕ Aggiunta alla coda")
        .setDescription(`[${songInfo.title}](${songInfo.url})`)
        .addFields(
          { name: "Durata", value: songInfo.duration, inline: true },
          { name: "Posizione", value: `#${queue.songs.length}`, inline: true }
        );
      await interaction.editReply({ embeds: [embed] });
    }
  }

  else if (commandName === "skip") {
    const queue = getQueue(guildId);
    if (!queue || queue.songs.length === 0) {
      return interaction.reply({ content: "❌ Non c'è nulla da saltare.", flags: MessageFlags.Ephemeral });
    }
    if (queue.currentProcess) {
      try { queue.currentProcess.kill(); } catch (e) {}
    }
    queue.player.stop();
    interaction.reply("⏭️ Canzone saltata!");
  }

  else if (commandName === "stop") {
    destroyQueue(guildId);
    interaction.reply("⏹️ Musica fermata e coda svuotata.");
  }

  else if (commandName === "pause") {
    const queue = getQueue(guildId);
    if (!queue) return interaction.reply({ content: "❌ Non c'è nulla in riproduzione.", ephemeral: true });
    queue.player.pause();
    interaction.reply("⏸️ Musica in pausa.");
  }

  else if (commandName === "resume") {
    const queue = getQueue(guildId);
    if (!queue) return interaction.reply({ content: "❌ Non c'è nulla in pausa.", ephemeral: true });
    queue.player.unpause();
    interaction.reply("▶️ Riproduzione ripresa!");
  }

  else if (commandName === "queue") {
    const queue = getQueue(guildId);
    if (!queue || queue.songs.length === 0) {
      return interaction.reply({ content: "📭 La coda è vuota.", ephemeral: true });
    }

    const list = queue.songs
      .map((s, i) => `${i === 0 ? "🎶" : `**${i}.**`} [${s.title}](${s.url}) — ${s.duration}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📋 Coda di riproduzione")
      .setDescription(list)
      .setFooter({ text: `${queue.songs.length} brani in coda` });

    interaction.reply({ embeds: [embed] });
  }

  else if (commandName === "nowplaying") {
    const queue = getQueue(guildId);
    if (!queue || queue.songs.length === 0) {
      return interaction.reply({ content: "❌ Non c'è nulla in riproduzione.", ephemeral: true });
    }

    const song = queue.songs[0];
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("🎶 In riproduzione adesso")
      .setDescription(`[${song.title}](${song.url})`)
      .addFields({ name: "Durata", value: song.duration, inline: true })
      .setThumbnail(song.thumbnail);

    interaction.reply({ embeds: [embed] });
  }
});

deployCommands().then(() => client.login(TOKEN));
