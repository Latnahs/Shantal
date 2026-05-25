const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Guards ─────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_PASSWORD environment variable is not set.');
  process.exit(1);
}

if (!process.env.MONGODB_URI) {
  console.error('ERROR: MONGODB_URI environment variable is not set.');
  process.exit(1);
}

// ── Cloudinary ─────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const cloudinaryReady =
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY    &&
  process.env.CLOUDINARY_API_SECRET;

// ── MongoDB ────────────────────────────────────────────────────────────────
let db;

async function connectDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('personal-site');
  // Create indexes for faster queries
  await db.collection('activity').createIndex({ date: -1 });
  console.log('MongoDB: connected');
}

// Helper: get a collection
const col = name => db.collection(name);

// ── Multer: memory storage → Cloudinary ───────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp|mp4|mov|webm|pdf/i.test(
      path.extname(file.originalname)
    );
    cb(ok ? null : new Error('File type not allowed'), ok);
  }
});

// ── Upload to Cloudinary ───────────────────────────────────────────────────
async function storeFile(buffer, originalname, type) {
  if (cloudinaryReady) {
    const isVideo = /mp4|mov|webm/i.test(path.extname(originalname));
    const isPDF   = /pdf/i.test(path.extname(originalname));
    const resource_type = isVideo ? 'video' : isPDF ? 'raw' : 'image';

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: `personal-site/${type}s`, resource_type, public_id: uuidv4() },
        (error, result) => {
          if (error) return reject(error);
          resolve({
            url:           result.secure_url,
            public_id:     result.public_id,
            resource_type,
            storage:       'cloudinary',
          });
        }
      );
      stream.end(buffer);
    });
  } else {
    throw new Error('Cloudinary not configured — uploads require Cloudinary env vars.');
  }
}

// ── Delete from Cloudinary ────────────────────────────────────────────────
async function deleteFile(item) {
  if (item.storage === 'cloudinary' && item.public_id) {
    try {
      await cloudinary.uploader.destroy(item.public_id, {
        resource_type: item.resource_type || 'image'
      });
    } catch (e) {
      console.error('Cloudinary delete error:', e.message);
    }
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Auth
app.post('/api/auth', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ ok: false });
});

// Get all content
app.get('/api/content', async (req, res) => {
  try {
    const [photos, videos, files, posts, activity] = await Promise.all([
      col('photos').find().sort({ date: -1 }).toArray(),
      col('videos').find().sort({ date: -1 }).toArray(),
      col('files').find().sort({ date: -1 }).toArray(),
      col('posts').find().sort({ date: -1 }).toArray(),
      col('activity').find().sort({ date: -1 }).limit(50).toArray(),
    ]);
    res.json({ photos, videos, files, posts, activity });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload a file
app.post('/api/upload', requireAdmin, upload.single('file'), async (req, res) => {
  const { type, title, caption, tag } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  try {
    const stored = await storeFile(req.file.buffer, req.file.originalname, type);

    const item = {
      id:            uuidv4(),
      title:         title || req.file.originalname,
      caption:       caption || '',
      tag:           tag || '',
      url:           stored.url,
      public_id:     stored.public_id || null,
      resource_type: stored.resource_type || null,
      storage:       stored.storage,
      size:          req.file.size,
      date:          new Date().toISOString(),
    };

    const collectionName = type === 'photo' ? 'photos' : type === 'video' ? 'videos' : 'files';
    await col(collectionName).insertOne(item);
    await col('activity').insertOne({
      id: uuidv4(), type, label: item.title,
      tag: tag || null, date: new Date().toISOString()
    });

    res.json({ ok: true, item });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// Publish a blog post
app.post('/api/posts', requireAdmin, async (req, res) => {
  const { title, excerpt, content, tag } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const post = {
    id:      uuidv4(),
    title,
    excerpt: excerpt || '',
    content: content || '',
    tag:     tag || 'personal',
    date:    new Date().toISOString(),
  };

  await col('posts').insertOne(post);
  await col('activity').insertOne({
    id: uuidv4(), type: 'post', label: title,
    tag: tag || null, date: new Date().toISOString()
  });

  res.json({ ok: true, post });
});

// Delete an item
app.delete('/api/item/:type/:id', requireAdmin, async (req, res) => {
  const { type, id } = req.params;
  const collectionName = type === 'post' ? 'posts' : type + 's';

  const item = await col(collectionName).findOne({ id });
  if (!item) return res.status(404).json({ error: 'Not found' });

  await deleteFile(item);
  await col(collectionName).deleteOne({ id });

  res.json({ ok: true });
});

// Dashboard stats
app.get('/api/stats', async (req, res) => {
  try {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const weekMs     = 7 * 24 * 60 * 60 * 1000;
    const cutoff     = new Date(Date.now() - 16 * weekMs).toISOString();

    const [photos, videos, files, posts, activity] = await Promise.all([
      col('photos').find().toArray(),
      col('videos').find().toArray(),
      col('files').find().toArray(),
      col('posts').find().toArray(),
      col('activity').find().sort({ date: -1 }).limit(10).toArray(),
    ]);

    const countMonth = arr => arr.filter(i => i.date >= monthStart).length;

    // Weekly activity heatmap (last 16 weeks)
    const weeks = Array(16).fill(0);
    [...photos, ...videos, ...files, ...posts].forEach(item => {
      if (item.date < cutoff) return;
      const idx = 15 - Math.floor((Date.now() - new Date(item.date).getTime()) / weekMs);
      if (idx >= 0 && idx < 16) weeks[idx]++;
    });

    res.json({
      counts: {
        photos: photos.length, videos: videos.length,
        files:  files.length,  posts:  posts.length,
        total:  photos.length + videos.length + files.length + posts.length,
      },
      thisMonth: {
        photos: countMonth(photos), videos: countMonth(videos),
        files:  countMonth(files),  posts:  countMonth(posts),
      },
      weeklyActivity: weeks,
      tagBreakdown: ['personal','tech','creative','life'].map(t => ({
        tag: t, count: posts.filter(p => p.tag === t).length
      })),
      activity,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Admin panel:   http://localhost:${PORT}/admin.html`);
    console.log(`Cloudinary:    ${cloudinaryReady ? 'connected' : 'not configured'}`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  process.exit(1);
});