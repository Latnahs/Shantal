const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Admin password (change this!) ──────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'very_sec_7138';

// ── Paths ──────────────────────────────────────────────────────────────────
const DB_PATH      = path.join(__dirname, 'db.json');
const UPLOADS_DIR  = path.join(__dirname, 'public', 'uploads');
const PUBLIC_DIR   = path.join(__dirname, 'public');

// ── Ensure uploads dir exists ──────────────────────────────────────────────
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
  db.activity.unshift({
    id:    uuidv4(),
    type,           // 'photo' | 'video' | 'file' | 'post'
    label,
    tag:   tag || null,
    date:  new Date().toISOString()
  });
  // keep last 50
  if (db.activity.length > 50) db.activity = db.activity.slice(0, 50);
}

// ── Multer storage (preserves extension) ──────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = uuidv4() + ext;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|mov|webm|pdf/i;
    const ok = allowed.test(path.extname(file.originalname));
    cb(ok ? null : new Error('File type not allowed'), ok);
  }
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── API: verify password ───────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Wrong password' });
  }
});

// ── API: get all content ───────────────────────────────────────────────────
app.get('/api/content', (req, res) => {
  res.json(readDB());
});

// ── API: upload a file (photo / video / pdf) ──────────────────────────────
app.post('/api/upload', requireAdmin, upload.single('file'), (req, res) => {
  const { type, title, caption, tag } = req.body;
  const db   = readDB();
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'No file received' });

  const item = {
    id:      uuidv4(),
    title:   title || file.originalname,
    caption: caption || '',
    tag:     tag || '',
    url:     '/uploads/' + file.filename,
    size:    file.size,
    date:    new Date().toISOString()
  };

  if (type === 'photo')  db.photos.push(item);
  if (type === 'video')  db.videos.push(item);
  if (type === 'file')   db.files.push(item);

  logActivity(db, type, item.title, tag || null);
  writeDB(db);
  res.json({ ok: true, item });
});

// ── API: add a blog post (no file) ────────────────────────────────────────
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
    date:    new Date().toISOString()
  };

  db.posts.unshift(post);
  logActivity(db, 'post', title, tag);
  writeDB(db);
  res.json({ ok: true, post });
});

// ── API: delete any item ──────────────────────────────────────────────────
app.delete('/api/item/:type/:id', requireAdmin, (req, res) => {
  const { type, id } = req.params;
  const db  = readDB();
  const key = type === 'post' ? 'posts' : type + 's';

  if (!db[key]) return res.status(404).json({ error: 'Unknown type' });

  const idx  = db[key].findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [item] = db[key].splice(idx, 1);

  // Delete the physical file if it's not a post
  if (item.url) {
    const filePath = path.join(PUBLIC_DIR, item.url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  writeDB(db);
  res.json({ ok: true });
});

// ── API: dashboard stats ──────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const db = readDB();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  function countThisMonth(arr) {
    return arr.filter(i => i.date >= monthStart).length;
  }

  // Activity by week for heatmap (last 16 weeks)
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const weeks  = Array(16).fill(0);
  const cutoff = new Date(Date.now() - 16 * weekMs);

  [...db.photos, ...db.videos, ...db.files, ...db.posts].forEach(item => {
    const d = new Date(item.date);
    if (d < cutoff) return;
    const weeksAgo = Math.floor((Date.now() - d.getTime()) / weekMs);
    const idx = 15 - weeksAgo;
    if (idx >= 0) weeks[idx]++;
  });

  res.json({
    counts: {
      photos: db.photos.length,
      videos: db.videos.length,
      files:  db.files.length,
      posts:  db.posts.length,
      total:  db.photos.length + db.videos.length + db.files.length + db.posts.length
    },
    thisMonth: {
      photos: countThisMonth(db.photos),
      videos: countThisMonth(db.videos),
      files:  countThisMonth(db.files),
      posts:  countThisMonth(db.posts)
    },
    weeklyActivity: weeks,
    tagBreakdown: ['personal','tech','creative','life'].map(t => ({
      tag:   t,
      count: db.posts.filter(p => p.tag === t).length
    })),
    activity: db.activity.slice(0, 10)
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✓ Site running at  http://localhost:${PORT}`);
  console.log(`  ✓ Admin panel at   http://localhost:${PORT}/admin.html`);
  console.log(`  ✓ Admin password:  ${ADMIN_PASSWORD}\n`);
});