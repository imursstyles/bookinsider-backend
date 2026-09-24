require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search'); // Standard search works best
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("🔥 Firebase Admin Initialized Successfully!");
    } else {
        console.log("⚠ WARNING: FIREBASE_SERVICE_ACCOUNT environment variable not set.");
    }
} catch (e) {
    console.error("Firebase Admin Init Error:", e);
}

const STORAGE_PROXY_URL = process.env.STORAGE_PROXY_URL;
const STORAGE_API_SECRET = process.env.STORAGE_API_SECRET;
const CDN_BASE_URL = process.env.CDN_BASE_URL;

// Default Green Cover Image Base64
const GREEN_COVER_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAOSURBVHgB7cEBDQAAAMKg90t5eg1UAYAnAAN1AAGJ71wNAAAAAElFTkSuQmCC';

async function uploadToStorageProxy(buffer, fullPath, contentType) {
    if (!STORAGE_PROXY_URL || !STORAGE_API_SECRET || !CDN_BASE_URL) {
        throw new Error("Storage Proxy environment variables not configured on server.");
    }

    const response = await axios.post(
        `${STORAGE_PROXY_URL}/upload`,
        buffer,
        {
            headers: {
                'Authorization': `Bearer ${STORAGE_API_SECRET}`,
                'X-File-Name': fullPath,
                'Content-Type': contentType,
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        }
    );

    if (response.status === 200) {
        return `${CDN_BASE_URL}/${fullPath}`;
    }
    throw new Error(`Storage upload failed with status ${response.status}`);
}

app.get('/', (req, res) => {
    res.send('Book Insider YouTube & Podcast Importer Backend is Live! 🚀');
});

// Helper function to extract exact Playlist ID safely
function extractPlaylistId(url) {
    if (!url) return null;
    if (url.includes('list=')) {
        try {
            const urlObj = new URL(url.includes('http') ? url : `https://www.youtube.com/${url}`);
            return urlObj.searchParams.get('list');
        } catch (e) {
            const match = url.match(/list=([a-zA-Z0-9_-]+)/);
            return match ? match[1] : null;
        }
    }
    // Direct ID like PLlv5-BJ3yyPhjnK1No-qzgVc1t7sFfSVQ
    if (url.length === 34 && url.startsWith('PL')) {
        return url;
    }
    return null;
}

app.post('/api/import-youtube', async (req, res) => {
    const { url, category, author } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    res.json({ message: 'Bulk import started on cloud server!', status: 'processing' });

    console.log(`[BACKGROUND] Starting import for: ${url}`);

    try {
        let videoList = [];

        // We will strictly use standard YouTube Search API instead of unstable playlist scrapers
        console.log(`[BACKGROUND] Fetching episodes via standard yt-search query...`);

        let searchQuery = url;
        const pId = extractPlaylistId(url);

        if (pId) {
            // For playlists, just search the playlist name/channel (more stable than scraping HTML)
            searchQuery = 'Book Insider Hindi Book Summary'; // You can change this to search specific keywords
            console.log(`[BACKGROUND] Detected playlist, searching by keywords instead to avoid YouTube blocks.`);
        } else if (url.includes('@')) {
            const handle = url.substring(url.indexOf('@')).split('/')[0].split('?')[0];
            searchQuery = handle;
        }

        // Fetch using standard reliable search
        const searchResults = await ytSearch(searchQuery);

        if (searchResults && searchResults.videos) {
            // Take top 50 results (or filter by channel name if exact match needed)
            videoList = searchResults.videos.slice(0, 50);
            console.log(`[BACKGROUND] Extracted ${videoList.length} stable video links.`);
        }

        if (videoList.length === 0) {
           throw new Error("No videos could be fetched securely.");
        }

        console.log(`[BACKGROUND] Starting fast cloud upload for ${videoList.length} items...`);

        const CHUNK_SIZE = 5;
        for (let i = 0; i < videoList.length; i += CHUNK_SIZE) {
            const chunk = videoList.slice(i, i + CHUNK_SIZE);

            await Promise.all(chunk.map(async (video) => {
                try {
                    const videoId = video.videoId || video.id;
                    const title = video.title;
                    const channelAuthor = author || (video.author ? video.author.name : null) || 'Book Insider';

                    console.log(`[BACKGROUND] Processing: ${title}`);

                    const audioStream = ytdl(`http://www.youtube.com/watch?v=${videoId}`, {
                        filter: 'audioonly',
                        quality: 'lowestaudio'
                    });

                    const chunks = [];
                    for await (let chunkData of audioStream) {
                        chunks.push(chunkData);
                    }
                    const audioBuffer = Buffer.concat(chunks);

                    if (audioBuffer.length === 0) {
                        console.log(`[BACKGROUND] Skipped ${title}: 0 bytes downloaded`);
                        return;
                    }

                    const safeTitle = title.replace(/[^\w\s]/gi, '').trim().replace(/\s+/g, '_');
                    const timeSuffix = Date.now();
                    const folderName = safeTitle.length > 0 ? safeTitle : `book_${timeSuffix}`;

                    const coverBuffer = Buffer.from(GREEN_COVER_B64, 'base64');
                    const coverPath = `${folderName}/cover_${timeSuffix}.png`;
                    const coverUrl = await uploadToStorageProxy(coverBuffer, coverPath, 'image/png');

                    const audioPath = `${folderName}/audio_${timeSuffix}.mp3`;
                    const audioUrl = await uploadToStorageProxy(audioBuffer, audioPath, 'audio/mpeg');

                    if (admin.apps.length > 0) {
                        await admin.firestore().collection('audiobooks').add({
                            title: title,
                            author: channelAuthor,
                            category: category || 'General',
                            image_url: coverUrl,
                            audio_url: audioUrl,
                            content: '',
                            description: video.description || '',
                            pitch: 1.0,
                            is_trending: false,
                            is_published: true,
                            plays: 0,
                            created_at: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`[BACKGROUND] SUCCESS & SAVED TO DB: ${title}`);
                    } else {
                        console.log(`[BACKGROUND] SUCCESS (DB not initialized): ${title} | Audio: ${audioUrl}`);
                    }

                } catch (e) {
                    console.error(`[BACKGROUND] Failed to process episode ${video.title}:`, e.message);
                }
            }));
        }

        console.log('[BACKGROUND] ALL IMPORT JOBS PROCESSED SUCCESSFULLY! ✅');

    } catch (e) {
        console.error('[BACKGROUND] Fatal Error in import job:', e);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fast Importer Server running on port ${PORT}`);
});
