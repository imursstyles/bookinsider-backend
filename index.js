require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const yts = require('yt-search');
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

app.post('/api/import-youtube', async (req, res) => {
    const { url, category, author } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    res.json({ message: 'Bulk import started on cloud server!', status: 'processing' });

    console.log(`[BACKGROUND] Starting import for playlist/podcast: ${url}`);
    
    try {
        let videoList = [];

        // Correctly extract the Playlist ID
        let playlistId = url;
        if (url.includes('list=')) {
            const urlObj = new URL(url.includes('http') ? url : `https://www.youtube.com/${url}`);
            playlistId = urlObj.searchParams.get('list');
        }

        console.log(`[BACKGROUND] Fetching all episodes using yt-search for playlist ID: ${playlistId}`);
        
        // Use yt-search properly for playlist
        const playlistResult = await yts({ listId: playlistId });
        videoList = playlistResult.videos || [];

        console.log(`[BACKGROUND] Found total ${videoList.length} episodes. Starting fast cloud upload...`);

        const CHUNK_SIZE = 5;
        for (let i = 0; i < videoList.length; i += CHUNK_SIZE) {
            const chunk = videoList.slice(i, i + CHUNK_SIZE);
            
            await Promise.all(chunk.map(async (video) => {
                try {
                    const videoId = video.videoId; // In yts, id is stored in videoId
                    const title = video.title;
                    const channelAuthor = author || (video.author ? video.author.name : null) || 'Book Insider';

                    console.log(`[BACKGROUND] Processing: ${title} (ID: ${videoId})`);

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
                            description: '', // yt-search playlist objects don't have descriptions, keeping empty to save space
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

        console.log('[BACKGROUND] ALL EPISODES IMPORTED SUCCESSFULLY! ✅');

    } catch (e) {
        console.error('[BACKGROUND] Fatal Error in import job:', e);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Fast Importer Server running on port ${PORT}`);
});
