require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { DisTube, RepeatMode } = require('distube');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const ffmpegStatic = require('ffmpeg-static');
const Anthropic = require('@anthropic-ai/sdk');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

if (!YOUTUBE_API_KEY) {
    console.error('ERROR: Set YOUTUBE_API_KEY in your .env file.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

const distube = new DisTube(client, {
    emitNewSongOnly: true,
    ffmpeg: { path: ffmpegStatic },
    plugins: [new SoundCloudPlugin(), new YtDlpPlugin({
        update: false,
        ytdlpArgs: [
            '--cookies', '/home/ubuntu/zyn-bot/cookies.txt',
            '--extractor-args', 'youtube:player_client=web',
        ],
    })],
});

// ── YouTube search ────────────────────────────────────────────────────────────

async function searchYouTube(query) {
    const params = new URLSearchParams({
        part: 'snippet',
        q: query,
        type: 'video',
        maxResults: '1',
        key: YOUTUBE_API_KEY,
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `YouTube API error ${res.status}`);
    }
    const data = await res.json();
    const videoId = data.items?.[0]?.id?.videoId;
    if (!videoId) return null;
    return `https://www.youtube.com/watch?v=${videoId}`;
}

// ── Claude / Zyn brain ────────────────────────────────────────────────────────

async function askZyn(userPrompt) {
    const systemPrompt = `You are Zyn, a music bot with genuine taste and a sharp, fun personality. You recommend real songs that perfectly match what the user is feeling.

Always respond with:
1. One short, witty reaction (1-2 sentences max) — no fluff, just personality
2. A song list in this exact XML block:

<songs>
[
  { "title": "Song Title", "artist": "Artist Name" },
  { "title": "Song Title", "artist": "Artist Name" }
]
</songs>

Rules:
- Only recommend songs that actually exist
- For general vibes: 3-5 songs
- For mood queue requests: 6-8 songs
- Match energy precisely — a late-night study vibe gets lo-fi/ambient, not club bangers`;

    const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
    });

    return message.content[0].text;
}

function parseSongs(response) {
    const match = response.match(/<songs>([\s\S]*?)<\/songs>/);
    if (!match) return [];
    try {
        return JSON.parse(match[1].trim());
    } catch {
        return [];
    }
}

function extractMessage(response) {
    return response.replace(/<songs>[\s\S]*?<\/songs>/, '').trim();
}

async function askZynSuggest(queueNames) {
    const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are Zyn, a music bot with genuine taste. Analyze a list of songs currently in a queue and recommend new songs that fit the same vibe.

Always respond with:
1. One short, witty reaction (1-2 sentences max)
2. A song list in this exact XML block:

<songs>
[
  { "title": "Song Title", "artist": "Artist Name" }
]
</songs>

Rules:
- Recommend 3-5 songs that match the energy/vibe of the provided queue
- Only recommend songs that actually exist
- Do not repeat any songs already in the queue`,
        messages: [{ role: 'user', content: `Here are the songs currently in the queue:\n${queueNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nSuggest more songs that fit this vibe.` }],
    });
    return message.content[0].text;
}

async function askZynWhy(prompt, songs) {
    const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
            role: 'user',
            content: `A user asked for: "${prompt}"\n\nYou queued these songs:\n${songs.join('\n')}\n\nIn 3-4 natural sentences, explain why these songs fit what they asked for. Be specific and show genuine music knowledge. No lists, just flowing text.`,
        }],
    });
    return message.content[0].text;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const rateLimitMap = new Map(); // userId -> [timestamp, ...]

function isRateLimited(userId) {
    const now = Date.now();
    const window = 60 * 1000;
    const max = 3;
    const timestamps = (rateLimitMap.get(userId) || []).filter(t => now - t < window);
    if (timestamps.length >= max) {
        const secsLeft = Math.ceil((window - (now - timestamps[0])) / 1000);
        return secsLeft;
    }
    timestamps.push(now);
    rateLimitMap.set(userId, timestamps);
    return false;
}

// ── Session tracking ──────────────────────────────────────────────────────────

const lastZynSession = new Map(); // guildId -> { prompt, songs }

// ── Bot ready ─────────────────────────────────────────────────────────────────

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

// ── Commands ──────────────────────────────────────────────────────────────────

client.on('messageCreate', async message => {
    if (!message.content.startsWith('!') || message.author.bot) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'ping') {
        message.reply('Pong!');
    }

    if (command === 'play') {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) return message.reply('You need to be in a voice channel!');

        const query = args.join(' ');
        if (!query) return message.reply('Please provide a song name or URL!');

        try {
            let url = query;
            if (!query.startsWith('http://') && !query.startsWith('https://')) {
                url = await searchYouTube(query);
                if (!url) return message.reply(`No results found for **${query}**.`);
            }
            await distube.play(voiceChannel, url, {
                message,
                textChannel: message.channel,
            });
        } catch (e) {
            console.error(e);
            message.reply(`Error: ${e.message}`);
        }
    }

    if (command === 'stop') {
        distube.stop(message.guild);
        message.reply('Stopped the music!');
    }

    if (command === 'skip') {
        distube.skip(message.guild);
        message.reply('Skipped!');
    }

    if (command === 'pause') {
        const queue = distube.getQueue(message.guild);
        if (!queue) return message.reply('Nothing is playing!');
        if (queue.paused) return message.reply('Already paused.');
        queue.pause();
        message.reply('Paused.');
    }

    if (command === 'resume') {
        const queue = distube.getQueue(message.guild);
        if (!queue) return message.reply('Nothing is playing!');
        if (!queue.paused) return message.reply('Not paused.');
        queue.resume();
        message.reply('Resumed.');
    }

    if (command === 'volume') {
        const queue = distube.getQueue(message.guild);
        if (!queue) return message.reply('Nothing is playing!');
        const vol = parseInt(args[0]);
        if (isNaN(vol) || vol < 1 || vol > 100) return message.reply('Usage: `!volume 1-100`');
        queue.setVolume(vol);
        message.reply(`Volume set to **${vol}%**.`);
    }

    if (command === 'loop') {
        const queue = distube.getQueue(message.guild);
        if (!queue) return message.reply('Nothing is playing!');
        const next = queue.repeatMode === RepeatMode.SONG ? RepeatMode.DISABLED : RepeatMode.SONG;
        queue.setRepeatMode(next);
        message.reply(next === RepeatMode.SONG ? 'Loop **on** for current song.' : 'Loop **off**.');
    }

    if (command === 'remove') {
        const queue = distube.getQueue(message.guild);
        if (!queue) return message.reply('Nothing is playing!');
        const pos = parseInt(args[0]);
        if (isNaN(pos) || pos < 2) return message.reply('Usage: `!remove <number>` — position must be 2 or higher (1 is the current song).');
        if (pos > queue.songs.length) return message.reply(`Only ${queue.songs.length} song(s) in the queue.`);
        const removed = queue.songs.splice(pos - 1, 1)[0];
        message.reply(`Removed **${removed.name}** from the queue.`);
    }

    if (command === 'shuffle') {
        const queue = distube.getQueue(message.guild);
        if (!queue) return message.reply('Nothing is playing!');
        await queue.shuffle();
        message.reply('Queue shuffled!');
    }

    if (command === 'queue') {
        const queue = distube.getQueue(message.guild);
        if (!queue || !queue.songs.length) return message.reply('Nothing is playing!');
        const fmt = s => {
            const t = Math.round(s.duration);
            const m = Math.floor(t / 60);
            const sec = String(t % 60).padStart(2, '0');
            return `${m}:${sec}`;
        };
        const current = `**Now playing:** ${queue.songs[0].name} [${fmt(queue.songs[0])}]`;
        const upcoming = queue.songs.slice(1)
            .map((s, i) => `${i + 2}. ${s.name} [${fmt(s)}]`)
            .join('\n') || 'No upcoming songs.';
        message.reply(`${current}\n\n**Up next:**\n${upcoming}`);
    }

    if (command === 'nowplaying') {
        const queue = distube.getQueue(message.guild);
        if (!queue) return message.reply('Nothing is playing!');
        const song = queue.songs[0];
        const elapsed = Math.round(queue.currentTime);
        const total = Math.round(song.duration);
        const fmt = t => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
        const barLen = 20;
        const filled = total > 0 ? Math.round((elapsed / total) * barLen) : 0;
        const bar = '▬'.repeat(filled) + '🔘' + '▬'.repeat(barLen - filled);
        message.reply(`**${song.name}**\n${bar}\n${fmt(elapsed)} / ${fmt(total)}`);
    }

    // ── !zyn — AI-powered natural language commands ───────────────────────────

    if (command === 'zyn') {
        const subcommand = args[0]?.toLowerCase();

        // ── !zyn help ─────────────────────────────────────────────────────────
        if (subcommand === 'help') {
            return message.reply(
                '**Zyn AI Commands**\n' +
                '`!zyn <vibe>` — recommend and queue songs matching your vibe\n' +
                '`!zyn mood <mood>` — build a full 6-8 song mood queue\n' +
                '`!zyn suggest` — analyze current queue and add similar songs\n' +
                '`!zyn why` — explain why the last queued songs fit your request\n' +
                '`!zyn help` — show this message'
            );
        }

        // ── !zyn why ──────────────────────────────────────────────────────────
        if (subcommand === 'why') {
            const session = lastZynSession.get(message.guild.id);
            if (!session) return message.reply("No recent `!zyn` session found for this server.");
            try {
                const explanation = await askZynWhy(session.prompt, session.songs);
                return message.reply(explanation);
            } catch (err) {
                console.error('Zyn why error:', err);
                return message.reply('⚠️ Something went wrong. Try again in a sec!');
            }
        }

        // ── !zyn suggest ──────────────────────────────────────────────────────
        if (subcommand === 'suggest') {
            const queue = distube.getQueue(message.guild);
            if (!queue) return message.reply('Nothing is playing! Start a queue first.');

            const voiceChannel = message.member?.voice?.channel;
            if (!voiceChannel) return message.reply('🔇 You need to be in a voice channel first!');

            const limited = isRateLimited(message.author.id);
            if (limited) return message.reply(`⏳ Slow down! Try again in **${limited}s**.`);

            const queueNames = queue.songs.slice(0, 10).map(s => s.name);
            const thinkingMsg = await message.reply('🔍 Analyzing your queue...');

            try {
                const response = await askZynSuggest(queueNames);
                const songs = parseSongs(response);
                const personality = extractMessage(response);

                if (!songs.length) {
                    return thinkingMsg.edit("😵 My brain glitched — couldn't parse suggestions. Try again!");
                }

                const queued = [];
                for (const song of songs) {
                    const query = `${song.title} ${song.artist}`;
                    try {
                        const url = await searchYouTube(query);
                        if (!url) continue;
                        await distube.play(voiceChannel, url, {
                            member: message.member,
                            textChannel: message.channel,
                        });
                        queued.push(`**${song.title}** — ${song.artist}`);
                    } catch (e) {
                        console.error(`Failed to queue: ${query}`, e.message);
                    }
                }

                if (!queued.length) {
                    return thinkingMsg.edit("😬 Found suggestions but couldn't load any tracks. YouTube might be acting up.");
                }

                const list = queued.map((s, i) => `${i + 1}. ${s}`).join('\n');
                await thinkingMsg.edit(`${personality}\n\n🎶 **Added ${queued.length} songs:**\n${list}`);

            } catch (err) {
                console.error('Zyn suggest error:', err);
                await thinkingMsg.edit('⚠️ Something went wrong on my end. Try again in a sec!');
            }
            return;
        }

        // ── !zyn <vibe/mood> ──────────────────────────────────────────────────
        const userRequest = args.join(' ');
        if (!userRequest) {
            return message.reply("🎵 Tell me what you're feeling! Try `!zyn something chill` or `!zyn mood hype`\nNeed help? Use `!zyn help`");
        }

        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) {
            return message.reply('🔇 You need to be in a voice channel first!');
        }

        const limited = isRateLimited(message.author.id);
        if (limited) return message.reply(`⏳ Slow down! Try again in **${limited}s**.`);

        const thinkingMsg = await message.reply('🎧 Zyn is cooking up your playlist...');

        try {
            const isMood = userRequest.toLowerCase().startsWith('mood ');
            const prompt = isMood
                ? `Build a full queue for this mood: "${userRequest.replace(/^mood /i, '')}". Give 6-8 songs.`
                : `The user wants: "${userRequest}". Recommend songs that perfectly match.`;

            const response = await askZyn(prompt);
            const songs = parseSongs(response);
            const personality = extractMessage(response);

            if (!songs.length) {
                return thinkingMsg.edit("😵 My brain glitched — couldn't parse any songs. Try again!");
            }

            const seen = new Set();
            const dedupedSongs = songs.filter(s => {
                const key = `${s.title.toLowerCase()}|${s.artist.toLowerCase()}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            const queued = [];
            for (const song of dedupedSongs) {
                const query = `${song.title} ${song.artist}`;
                try {
                    const url = await searchYouTube(query);
                    if (!url) continue;
                    await distube.play(voiceChannel, url, {
                        member: message.member,
                        textChannel: message.channel,
                    });
                    queued.push(`**${song.title}** — ${song.artist}`);
                } catch (e) {
                    console.error(`Failed to queue: ${query}`, e.message);
                }
            }

            if (!queued.length) {
                return thinkingMsg.edit("😬 Found the vibe but couldn't load any tracks. YouTube might be acting up.");
            }

            lastZynSession.set(message.guild.id, { prompt: userRequest, songs: queued });

            const list = queued.map((s, i) => `${i + 1}. ${s}`).join('\n');
            await thinkingMsg.edit(`${personality}\n\n🎶 **Queued ${queued.length} songs:**\n${list}`);

        } catch (err) {
            console.error('Zyn Claude error:', err);
            await thinkingMsg.edit('⚠️ Something went wrong on my end. Try again in a sec!');
        }
    }
});

// ── DisTube events ────────────────────────────────────────────────────────────

distube.on('initQueue', queue => {
    queue.voice.setSelfDeaf(false);
});

distube.on('playSong', (queue, song) => {
});

distube.on('error', (error, queue, song) => {
    console.error(error);
    queue.textChannel?.send(`Something went wrong${song ? ` playing **${song.name}**` : ''}: ${error.message}`);
});

client.login(DISCORD_TOKEN);
