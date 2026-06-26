const express  = require('express');
const Datastore = require('@seald-io/nedb');
const multer    = require('multer');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const path      = require('path');
const fs        = require('fs');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'qishloq-bozor-2026-xavfsiz-kalit';

// Papkalar
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const dataDir    = path.join(__dirname, 'data');
[uploadsDir, dataDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Bazalar
const usersDb    = new Datastore({ filename: path.join(dataDir, 'users.db'),    autoload: true });
const listingsDb = new Datastore({ filename: path.join(dataDir, 'listings.db'), autoload: true });
usersDb.ensureIndex({ fieldName: 'phone', unique: true }, () => {});

// Multer — rasm yuklash
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Faqat rasm fayllari'))
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── NeDB yordamchi funksiyalar ────────────────────────────────────────────────
const dbFind = (db, q, sort, lim) => new Promise((ok, fail) => {
  let c = db.find(q);
  if (sort) c = c.sort(sort);
  if (lim)  c = c.limit(lim);
  c.exec((e, d) => e ? fail(e) : ok(d));
});
const dbOne    = (db, q)           => new Promise((ok, fail) => db.findOne(q,        (e,d) => e ? fail(e) : ok(d)));
const dbInsert = (db, doc)         => new Promise((ok, fail) => db.insert(doc,        (e,d) => e ? fail(e) : ok(d)));
const dbUpdate = (db, q, upd, opt) => new Promise((ok, fail) => db.update(q, upd, opt||{}, (e,n) => e ? fail(e) : ok(n)));
const dbCount  = (db, q)           => new Promise((ok, fail) => db.count(q,           (e,n) => e ? fail(e) : ok(n)));

// Listing hujjatini frontend formatiga o'tkazish
function norm(l, sellerName, sellerVillage) {
  return {
    id: l._id, user_id: l.userId,
    title: l.title, description: l.description || '',
    price: l.price, price_unit: l.priceUnit || "so'm",
    category: l.category, type: l.type,
    image: l.image || '', phone: l.phone,
    location: l.location || '',
    is_active: l.isActive ? 1 : 0,
    views: l.views || 0,
    created_at: l.createdAt,
    seller_name: sellerName || '',
    seller_village: sellerVillage || '',
  };
}

async function listingsWithSellers(q) {
  const docs = await dbFind(listingsDb, { ...q, isActive: true }, { createdAt: -1 }, 300);
  const uids = [...new Set(docs.map(d => d.userId))];
  const usrs = uids.length ? await dbFind(usersDb, { _id: { $in: uids } }) : [];
  const umap = Object.fromEntries(usrs.map(u => [u._id, u]));
  return docs.map(d => norm(d, umap[d.userId]?.name, umap[d.userId]?.location));
}

// ── Auth middleware ───────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Kirish talab qilinadi' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Sessiya muddati tugagan, qayta kiring' }); }
};

// ── REGISTER ──────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, password, location } = req.body;
    if (!name?.trim() || !phone?.trim() || !password)
      return res.status(400).json({ error: 'Ism, telefon va parol majburiy' });
    if (password.length < 6)
      return res.status(400).json({ error: "Parol kamida 6 ta belgi bo'lsin" });

    const hash = await bcrypt.hash(password, 12);
    const user = await dbInsert(usersDb, {
      name: name.trim(), phone: phone.trim(), password: hash,
      location: location?.trim() || '', createdAt: new Date().toISOString()
    });
    const u = { id: user._id, name: user.name, phone: user.phone, location: user.location };
    const token = jwt.sign({ id: user._id, name: user.name, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: u });
  } catch (e) {
    if (e.errorType === 'uniqueViolated')
      return res.status(400).json({ error: "Bu raqam allaqachon ro'yxatdan o'tgan" });
    console.error(e);
    res.status(500).json({ error: 'Server xatosi' });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await dbOne(usersDb, { phone: phone?.trim() });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(400).json({ error: "Telefon yoki parol noto'g'ri" });
    const token = jwt.sign({ id: user._id, name: user.name, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, name: user.name, phone: user.phone, location: user.location } });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

// ── GET LISTINGS ──────────────────────────────────────────────────────────────
app.get('/api/listings', async (req, res) => {
  try {
    const { category, type, q, userId } = req.query;
    const dbQ = {};
    if (category && category !== 'barcha') dbQ.category = category;
    if (type     && type     !== 'barcha') dbQ.type     = type;
    if (userId) dbQ.userId = userId;

    let docs = await listingsWithSellers(dbQ);

    if (q) {
      const lq = q.toLowerCase();
      docs = docs.filter(d =>
        d.title.toLowerCase().includes(lq) ||
        (d.description||'').toLowerCase().includes(lq) ||
        (d.location||'').toLowerCase().includes(lq) ||
        (d.seller_name||'').toLowerCase().includes(lq)
      );
    }
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET SINGLE LISTING ────────────────────────────────────────────────────────
app.get('/api/listings/:id', async (req, res) => {
  try {
    const doc = await dbOne(listingsDb, { _id: req.params.id, isActive: true });
    if (!doc) return res.status(404).json({ error: 'Topilmadi' });
    const u = await dbOne(usersDb, { _id: doc.userId });
    await dbUpdate(listingsDb, { _id: doc._id }, { $inc: { views: 1 } });
    res.json(norm(doc, u?.name, u?.location));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADD LISTING ───────────────────────────────────────────────────────────────
app.post('/api/listings', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { title, description, price, price_unit, category, type, phone, location } = req.body;
    if (!title?.trim() || !price?.trim() || !category || !phone?.trim()) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Sarlavha, narx, kategoriya va telefon kerak' });
    }
    const image = req.file ? `/uploads/${req.file.filename}` : '';
    const doc = await dbInsert(listingsDb, {
      userId: req.user.id,
      title: title.trim(), description: description?.trim() || '',
      price: price.trim(), priceUnit: price_unit || "so'm",
      category, type: type || 'product',
      image, phone: phone.trim(), location: location?.trim() || '',
      isActive: true, views: 0, createdAt: new Date().toISOString()
    });
    res.json({ id: doc._id, message: "E'lon qo'shildi!" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE LISTING ────────────────────────────────────────────────────────────
app.delete('/api/listings/:id', requireAuth, async (req, res) => {
  try {
    const doc = await dbOne(listingsDb, { _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'Topilmadi' });
    if (doc.userId !== req.user.id) return res.status(403).json({ error: "Ruxsat yo'q" });
    await dbUpdate(listingsDb, { _id: doc._id }, { $set: { isActive: false } });
    res.json({ message: "O'chirildi" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [listings, users, services] = await Promise.all([
      dbCount(listingsDb, { isActive: true }),
      dbCount(usersDb,    {}),
      dbCount(listingsDb, { isActive: true, type: 'service' }),
    ]);
    res.json({ listings, users, services });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('  Qishloq Bozor ishga tushdi!');
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================\n');
});
