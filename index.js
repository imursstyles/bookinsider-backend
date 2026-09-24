require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ytpl = require('ytpl');
const ytSearch = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Book Insider YouTube Importer Backend is Live! 🚀');
});

app.post('/api/import-youtube', async (req, res) => {
    const { url, category, author } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    res.json({ message: 'Import started successfully in background!', status: 'processing' });

    console.log(`[BACKGROUND] Starting import for: ${url}`);

    try {
        let videoList = [];

        if (url.includes('list=')) {
            const playlistId = new URL(url).searchParams.get('list');
            const playlist = await ytpl(playlistId, { limit: Infinity });
            videoList = playlist.items;
        } else {
            let channelName = url;
            if(url.includes('@')) {
               channelName = url.split('@')[1].split('/')[0];
            }

            console.log(`[BACKGROUND] Searching for channel: ${channelName}`);
            const searchResults = await ytSearch({ query: channelName });

            if(searchResults.channels.length > 0) {
               const targetChannelUrl = searchResults.channels[0].url;
               videoList = searchResults.videos.filter(v => v.author.url === targetChannelUrl);
            }
        }

        console.log(`[BACKGROUND] Found ${videoList.length} videos. Processing...`);

        const CHUNK_SIZE = 5;
        for (let i = 0; i < videoList.length; i += CHUNK_SIZE) {
            const chunk = videoList.slice(i, i + CHUNK_SIZE);

            await Promise.all(chunk.main ? chunk.map(async (video) => {}) : chunk.map(async (video) => {
                try {
                    const videoId = video.id || video.videoId;
                    const title = video.title;
                    console.log(`[BACKGROUND] Processing: ${title}`);
                    // Add your processing / upload logic here
                } catch (e) {
                    console.error(`[BACKGROUND] Failed to process video ${video.title}:`, e.message);
                }
            }));
        }

        console.log('[BACKGROUND] ALL DONE! ✅');

    } catch (e) {
        console.error('[BACKGROUND] Fatal Error in import job:', e);
    }
});

const DragAndDrop = {};
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fast Importer Server running on port ${PORT}`);
});
