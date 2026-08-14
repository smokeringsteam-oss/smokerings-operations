import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({ storage });

const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/post-reddit', upload.array('images'), async (req, res) => {
  try {
    const { title = '', text = '', subreddits = '[]', profilePath } = req.body;
    const subs = Array.isArray(subreddits) ? subreddits : JSON.parse(subreddits || '[]');
    const normalizedSubs = Array.isArray(subs) ? subs.filter(Boolean) : [];
    if (!normalizedSubs.length) {
      return res.status(400).json({ error: 'No subreddits provided. Select at least one subreddit.' });
    }
    const files = (req.files || []).map((f) => f.path);
    // Allow specifying an images folder path (e.g., C:\Users\you\Downloads\Reddit)
    if (req.body.imagesFolder) {
      files.push(req.body.imagesFolder);
    }
    console.log('Received Reddit post request:', {
      title: title.slice(0, 60),
      subreddits: normalizedSubs,
      files,
      profilePath,
    });

    // start posting in background
    import('./redditPoster.js').then(({ postToSubreddits }) => {
      postToSubreddits({ subreddits: normalizedSubs, title, text, files, profilePath }).catch((err) =>
        console.error('Error posting to reddit:', err),
      );
    });

    res.status(202).json({ status: 'queued', queuedFor: normalizedSubs.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Reddit poster server listening on http://localhost:${port}`));
