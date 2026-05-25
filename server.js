const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Admin password (set via environment variable — NEVER hardcode here) ───
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_PASSWORD environment variable is not set.');
  console.error('Set it in Railway → Variables, or run: ADMIN_PASSWORD=yourpassword node server.js');
  process.exit(1); // crash early rather than run with no auth
}

// ── Cloudinary config (all values from environment variables) ─────────────
cloudinary.config({
  cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
  api_key:     process.env.CLOUDINARY_API_KEY,
  api_secret:  process.env.CLOUDINARY_API_SECRET,
});

const cloudinaryReady =
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY    &&
  process.env.CLOUDINARY_API_SECRET;

if (!cloudinaryReady) {
  console.warn('WARNING: Cloudinary env vars not set. Uploads will fall back to local disk.');
}

// ── Paths ──────────────────────────────────────────────────────────────────
const DB_PATH     = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const PUBLIC_DIR  = path.join(__dirname, 'public');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── DB helpers ─────────────────────────────────────────────────────────────
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const empty = { photos: [], videos: [], files: [], posts: [], activity: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function logActivity(db, type, label, tag) {
  db.activity.unshift({ id: uuidv4(), type, label, tag: tag || null, date: new Date().toISOString() });
  if (db.activity.length > 50) db.activity = db.activity.slice(0, 50);
}

// ── Multer: temp storage before Cloudinary ────────────────────────────────
const tmpStorage = multer.memoryStorage(); // hold file in RAM, then send to Cloudinary

const upload = multer({
  storage: tmpStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp|mp4|mov|webm|pdf/i.test(path.extname(file.originalname));
    cb(ok ? null : new Error('File type not allowed'), ok);
  }
});

// ── Upload to Cloudinary (or fallback to disk) ────────────────────────────
async function storeFile(buffer, originalname, type) {
  if (cloudinaryReady) {
    // Determine Cloudinary resource type
    const isVideo = /mp4|mov|webm/i.test(path.extname(originalname));
    const isPDF   = /pdf/i.test(path.extname(originalname));
    const resource_type = isVideo ? 'video' : isPDF ? 'raw' : 'image';

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `personal-site/${type}s`,
          resource_type,
          public_id: uuidv4(),
        },
        (error, result) => {
          if (error) return reject(error);
          resolve({
            url:        result.secure_url,
            public_id:  result.public_id,
            storage:    'cloudinary',
            resource_type,
          });
        }
      );
      uploadStream.end(buffer);
    });
  } else {
    // Fallback: save to disk
    const ext      = path.extname(originalname);
    const filename = uuidv4() + ext;
    const dest     = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(dest, buffer);
    return { url: '/uploads/' + filename, storage: 'local' };
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
  } else if (item.url && item.url.startsWith('/uploads/')) {
    const filePath = path.join(PUBLIC_DIR, item.url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.post('/api/auth', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ ok: false });
});

app.get('/api/content', (req, res) => res.json(readDB()));

app.post('/api/upload', requireAdmin, upload.single('file'), async (req, res) => {
  const { type, title, caption, tag } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  try {
    const stored = await storeFile(req.file.buffer, req.file.originalname, type);

    const item = {
      id:       uuidv4(),
      title:    title || req.file.originalname,
      caption:  caption || '',
      tag:      tag || '',
      url:      stored.url,
      public_id: stored.public_id || null,
      resource_type: stored.resource_type || null,
      storage:  stored.storage,
      size:     req.file.size,
      date:     new Date().toISOString(),
    };

    const db = readDB();
    if (type === 'photo') db.photos.push(item);
    if (type === 'video') db.videos.push(item);
    if (type === 'file')  db.files.push(item);

    logActivity(db, type, item.title, tag || null);
    writeDB(db);
    res.json({ ok: true, item });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

app.post('/api/posts', requireAdmin, (req, res) => {
  const { title, excerpt, content, tag } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const db   = readDB();
  const post = {
    id:      uuidv4(),
    title,
    excerpt: excerpt || '',
    content: content || '',
    tag:     tag || 'personal',
    date:    new Date().toISOString(),
  };

  db.posts.unshift(post);
  logActivity(db, 'post', title, tag);
  writeDB(db);
  res.json({ ok: true, post });
});

app.delete('/api/item/:type/:id', requireAdmin, async (req, res) => {
  const { type, id } = req.params;
  const db  = readDB();
  const key = type === 'post' ? 'posts' : type + 's';
  if (!db[key]) return res.status(404).json({ error: 'Unknown type' });

  const idx = db[key].findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [item] = db[key].splice(idx, 1);
  await deleteFile(item);
  writeDB(db);
  res.json({ ok: true });
});

app.get('/api/stats', (req, res) => {
  const db  = readDB();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const countThisMonth = arr => arr.filter(i => i.date >= monthStart).length;

  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const weeks  = Array(16).fill(0);
  const cutoff = new Date(Date.now() - 16 * weekMs);

  [...db.photos, ...db.videos, ...db.files, ...db.posts].forEach(item => {
    const d = new Date(item.date);
    if (d < cutoff) return;
    const idx = 15 - Math.floor((Date.now() - d.getTime()) / weekMs);
    if (idx >= 0) weeks[idx]++;
  });

  res.json({
    counts:      { photos: db.photos.length, videos: db.videos.length, files: db.files.length, posts: db.posts.length, total: db.photos.length + db.videos.length + db.files.length + db.posts.length },
    thisMonth:   { photos: countThisMonth(db.photos), videos: countThisMonth(db.videos), files: countThisMonth(db.files), posts: countThisMonth(db.posts) },
    weeklyActivity: weeks,
    tagBreakdown: ['personal','tech','creative','life'].map(t => ({ tag: t, count: db.posts.filter(p => p.tag === t).length })),
    activity:    db.activity.slice(0, 10),
  });
});

app.listen(PORT, () => {
  // Only log the URL — never the password
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Admin panel:   http://localhost:${PORT}/admin.html`);
  console.log(`Cloudinary:    ${cloudinaryReady ? 'connected' : 'not configured (using local disk)'}`);
});