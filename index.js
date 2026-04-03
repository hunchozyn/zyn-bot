require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const Anthropic = require('@anthropic-ai/sdk');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Discord client ────────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// ── Lavalink client ───────────────────────────────────────────────────────────

const lavalinkClient = new LavalinkManager({
    nodes: [{
        authorization: 'zynbot',
        host: 'localhost',
        port: 2333,
        id: 'main',
    }],
    sendToShard: (guildId, payload) =>
        client.guilds.cache.get(guildId)?.shard.send(payload),
    autoSkipOnResolveError: true,
    playerOptions: {
        defaultSearchPlatform: 'scsearch',
        volumeDecrementer: 0.75,
    },
    queueOptions: {
        maxPreviousTracks: 10,
    },
});

lavalinkClient.on('nodeConnect', node =>
    console.log(`Lavalink node "${node.id}" connected.`));
lavalinkClient.on('nodeDisconnect', (node, reason) =>
    console.warn(`Lavalink node "${node.id}" disconnected:`, reason));
lavalinkClient.on('nodeError', (node, error) =>
    console.error(`Lavalink node "${node.id}" error:`, error));

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

// ── Lavalink helpers ──────────────────────────────────────────────────────────

async function getOrCreatePlayer(message) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
        message.reply('You need to be in a voice channel!');
        return null;
    }

    const player = lavalinkClient.createPlayer({
        guildId: message.guild.id,
        voiceChannelId: voiceChannel.id,
        textChannelId: message.channel.id,
        selfDeaf: true,
        selfMute: false,
        volume: 100,
        node: 'main',
    });

    if (!player.connected) await player.connect();
    return player;
}

// ── Search ranking ────────────────────────────────────────────────────────────

const DEGRADED_TERMS = [
    'cover', 'covers', 'covered',
    'live', 'live version', 'live at', 'live from', 'live performance',
    'acoustic', 'acoustic version',
    'remix', 'remixed',
    'slowed', 'slowed down', 'slowed + reverb',
    'reverb', 'reverbed',
    'sped up', 'nightcore',
    'karaoke', 'instrumental',
    'tribute', 'demo',
];

function pickBestTrack(tracks, query) {
    const lq = query.toLowerCase();

    // Terms the user explicitly requested — do not penalize these
    const userWants = DEGRADED_TERMS.filter(t => lq.includes(t));
    const penalize  = DEGRADED_TERMS.filter(t => !userWants.includes(t));

    // Query words longer than 2 chars used for reward matching
    const queryWords = lq.split(/\s+/).filter(w => w.length > 2);

    // Median duration for sanity check (-8 if track deviates >25%)
    const durations = tracks.map(t => t.info.duration).filter(d => d > 0).sort((a, b) => a - b);
    const median = durations.length
        ? durations[Math.floor(durations.length / 2)]
        : 0;

    const scored = tracks.map((track, index) => {
        const title  = track.info.title.toLowerCase();
        const author = track.info.author.toLowerCase();
        let score = 0;

        // Penalize degraded-version indicators not requested by user (-10 each)
        for (const term of penalize) {
            if (title.includes(term)) score -= 10;
        }

        // Reward query words present in title (+3) or author (+5)
        for (const word of queryWords) {
            if (title.includes(word))  score += 3;
            if (author.includes(word)) score += 5;
        }

        // Exact match bonus: all query words appear somewhere in title + author (+10)
        const combined = `${title} ${author}`;
        if (queryWords.length > 0 && queryWords.every(w => combined.includes(w))) score += 10;

        // Reward clean title — no parentheses or brackets (+2)
        if (!/[(\[]/.test(track.info.title)) score += 2;

        // Duration sanity check: penalize tracks >25% away from median (-8)
        if (median > 0 && track.info.duration > 0) {
            const deviation = Math.abs(track.info.duration - median) / median;
            if (deviation > 0.25) score -= 8;
        }

        // VEVO / exact artist match bonus (+4)
        if (author.includes('vevo') || (queryWords.length > 0 && queryWords.every(w => author.includes(w)))) {
            score += 4;
        }

        // Small positional decay so SC's own ranking breaks ties (-0.5 per position)
        score -= index * 0.5;

        return { track, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const gap = scored.length > 1 ? scored[0].score - scored[1].score : scored[0].score;
    return { track: scored[0].track, gap };
}

async function searchAndQueue(player, query, requestedBy, { confidenceCheck = false } = {}) {
    const isUrl = query.startsWith('http://') || query.startsWith('https://');
    const searchQuery = isUrl ? query : `scsearch:${query}`;

    const result = await player.search({ query: searchQuery }, requestedBy);

    if (!result?.tracks?.length || result.loadType === 'error' || result.loadType === 'empty') {
        return null;
    }

    let track;
    if (isUrl) {
        track = result.tracks[0];
    } else {
        const { track: best, gap } = pickBestTrack(result.tracks, query);
        if (confidenceCheck && gap < 8) {
            return {
                weakMatch: true,
                hint: `Couldn't find a confident match for **${query}**.\nTry adding the artist name — for example: \`!play ${query} <artist>\``,
            };
        }
        track = best;
    }

    await player.queue.add(track);
    if (!player.playing && !player.paused) await player.play({ paused: false });
    return track;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtMs(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ── Bot ready ─────────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    await lavalinkClient.init(client.user.id);
});

// ── Forward raw gateway packets to Lavalink ───────────────────────────────────

client.on('raw', d => lavalinkClient.sendRawData(d));

// ── Commands ──────────────────────────────────────────────────────────────────

client.on('messageCreate', async message => {
    if (!message.content.startsWith('!') || message.author.bot) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ── !ping ─────────────────────────────────────────────────────────────────

    if (command === 'ping') {
        message.reply('Pong!');
    }

    // ── !play ─────────────────────────────────────────────────────────────────

    if (command === 'play') {
        const query = args.join(' ');
        if (!query) return message.reply('Please provide a song name or URL!');

        const player = await getOrCreatePlayer(message);
        if (!player) return;

        try {
            const result = await searchAndQueue(player, query, message.member, { confidenceCheck: true });
            if (!result) return message.reply(`No results found for **${query}**.`);
            if (result.weakMatch) return message.reply(result.hint);
            message.reply(`Queued **${result.info.title}** by ${result.info.author}.`);
        } catch (e) {
            console.error(e);
            message.reply(`Error: ${e.message}`);
        }
    }

    // ── !stop ─────────────────────────────────────────────────────────────────

    if (command === 'stop') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player) return message.reply('Nothing is playing!');
        await player.destroy();
        message.reply('Stopped the music!');
    }

    // ── !skip ─────────────────────────────────────────────────────────────────

    if (command === 'skip') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player) return message.reply('Nothing is playing!');
        await player.skip();
        message.reply('Skipped!');
    }

    // ── !pause ────────────────────────────────────────────────────────────────

    if (command === 'pause') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player) return message.reply('Nothing is playing!');
        if (player.paused) return message.reply('Already paused.');
        await player.pause();
        message.reply('Paused.');
    }

    // ── !resume ───────────────────────────────────────────────────────────────

    if (command === 'resume') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player) return message.reply('Nothing is playing!');
        if (!player.paused) return message.reply('Not paused.');
        await player.resume();
        message.reply('Resumed.');
    }

    // ── !volume ───────────────────────────────────────────────────────────────

    if (command === 'volume') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player) return message.reply('Nothing is playing!');
        const vol = parseInt(args[0]);
        if (isNaN(vol) || vol < 1 || vol > 100) return message.reply('Usage: `!volume 1-100`');
        await player.setVolume(vol);
        message.reply(`Volume set to **${vol}%**.`);
    }

    // ── !loop ─────────────────────────────────────────────────────────────────

    if (command === 'loop') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player) return message.reply('Nothing is playing!');
        const next = player.repeatMode === 'track' ? 'off' : 'track';
        await player.setRepeatMode(next);
        message.reply(next === 'track' ? 'Loop **on** for current song.' : 'Loop **off**.');
    }

    // ── !remove ───────────────────────────────────────────────────────────────

    if (command === 'remove') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player) return message.reply('Nothing is playing!');
        const pos = parseInt(args[0]);
        const upcoming = player.queue.tracks;
        if (isNaN(pos) || pos < 2) return message.reply('Usage: `!remove <number>` — position must be 2 or higher (1 is the current song).');
        if (pos - 1 > upcoming.length) return message.reply(`Only ${upcoming.length + 1} song(s) in the queue.`);
        const removed = upcoming[pos - 2];
        player.queue.splice(pos - 2, 1);
        message.reply(`Removed **${removed.info.title}** from the queue.`);
    }

    // ── !shuffle ──────────────────────────────────────────────────────────────

    if (command === 'shuffle') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player) return message.reply('Nothing is playing!');
        await player.queue.shuffle();
        message.reply('Queue shuffled!');
    }

    // ── !queue ────────────────────────────────────────────────────────────────

    if (command === 'queue') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player?.queue?.current) return message.reply('Nothing is playing!');

        const current = player.queue.current;
        const upcoming = player.queue.tracks.slice(0, 10);
        const total = player.queue.tracks.length;

        const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('Queue')
            .setDescription(
                `**Now playing:** ${current.info.title} — ${current.info.author} [${fmtMs(current.info.duration)}]` +
                (upcoming.length
                    ? '\n\n**Up next:**\n' + upcoming.map((t, i) =>
                        `${i + 2}. ${t.info.title} — ${t.info.author} [${fmtMs(t.info.duration)}]`
                    ).join('\n')
                    : '\n\nNo upcoming songs.') +
                (total > 10 ? `\n\n*…and ${total - 10} more*` : '')
            );

        message.reply({ embeds: [embed] });
    }

    // ── !nowplaying ───────────────────────────────────────────────────────────

    if (command === 'nowplaying') {
        const player = lavalinkClient.getPlayer(message.guild.id);
        if (!player?.queue?.current) return message.reply('Nothing is playing!');

        const track = player.queue.current;
        const pos = player.position ?? 0;
        const dur = track.info.duration ?? 0;
        const barLen = 20;
        const filled = dur > 0 ? Math.round((pos / dur) * barLen) : 0;
        const bar = '▬'.repeat(filled) + '🔘' + '▬'.repeat(barLen - filled);

        const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle(track.info.title)
            .setDescription(`${bar}\n${fmtMs(pos)} / ${fmtMs(dur)}`)
            .setAuthor({ name: track.info.author });

        if (track.info.artworkUrl) embed.setThumbnail(track.info.artworkUrl);

        message.reply({ embeds: [embed] });
    }

    // ── !zyn ──────────────────────────────────────────────────────────────────

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
            const player = lavalinkClient.getPlayer(message.guild.id);
            if (!player?.queue?.current) return message.reply('Nothing is playing! Start a queue first.');

            const voiceChannel = message.member?.voice?.channel;
            if (!voiceChannel) return message.reply('🔇 You need to be in a voice channel first!');

            const limited = isRateLimited(message.author.id);
            if (limited) return message.reply(`⏳ Slow down! Try again in **${limited}s**.`);

            const queueNames = [player.queue.current, ...player.queue.tracks.slice(0, 9)]
                .map(t => t.info.title);
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
                        const track = await searchAndQueue(player, query, message.member);
                        if (!track) continue;
                        queued.push(`**${song.title}** — ${song.artist}`);
                    } catch (e) {
                        console.error(`Failed to queue: ${query}`, e.message);
                    }
                }

                if (!queued.length) {
                    return thinkingMsg.edit("😬 Found suggestions but couldn't load any tracks. Spotify might be acting up.");
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

            const player = await getOrCreatePlayer(message);
            if (!player) return thinkingMsg.edit('🔇 You need to be in a voice channel first!');

            const queued = [];
            for (const song of dedupedSongs) {
                const query = `${song.title} ${song.artist}`;
                try {
                    const track = await searchAndQueue(player, query, message.member);
                    if (!track) continue;
                    queued.push(`**${song.title}** — ${song.artist}`);
                } catch (e) {
                    console.error(`Failed to queue: ${query}`, e.message);
                }
            }

            if (!queued.length) {
                return thinkingMsg.edit("😬 Found the vibe but couldn't load any tracks. Spotify might be acting up.");
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

// ── Lavalink player events ────────────────────────────────────────────────────

lavalinkClient.on('trackStart', (player, track) => {
    const channel = client.channels.cache.get(player.textChannelId);
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('Now Playing')
        .setDescription(`**[${track.info.title}](${track.info.uri})**\n${track.info.author}`)
        .addFields({ name: 'Duration', value: fmtMs(track.info.duration), inline: true });

    if (track.info.artworkUrl) embed.setThumbnail(track.info.artworkUrl);

    channel.send({ embeds: [embed] });
});

lavalinkClient.on('queueEnd', async player => {
    const channel = client.channels.cache.get(player.textChannelId);
    channel?.send('Queue ended. Disconnecting.');
    setTimeout(() => player.destroy().catch(() => {}), 1000);
});

lavalinkClient.on('playerException', (player, track, error) => {
    console.error('Player exception:', error);
    const channel = client.channels.cache.get(player.textChannelId);
    channel?.send(`Something went wrong${track ? ` playing **${track.info.title}**` : ''}: ${error?.message ?? error}`);
});

lavalinkClient.on('playerSocketClosed', (player, payload) => {
    console.warn(`Player socket closed for guild ${player.guildId}:`, payload);
});

// ── Login ─────────────────────────────────────────────────────────────────────

client.login(DISCORD_TOKEN);
