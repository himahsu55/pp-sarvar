/**
 * Staff Punch Backend
 * - No native addons (no better-sqlite3): runs on Pterodactyl Node.js image as-is.
 * - Start with:  node server.js
 * - Data:        data/attendance.json
 * - Selfies:     data/selfies/
 * - Health:      GET /api/health
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';
const isVercel = Boolean(process.env.VERCEL);

// =====================================================================
// Config (.env)
// =====================================================================
const PORT = Number(process.env.PORT || 5331);
const OFFICE_LAT = Number(process.env.OFFICE_LAT || 21.7051);
const OFFICE_LNG = Number(process.env.OFFICE_LNG || 72.9959);
const OFFICE_RADIUS = Number(process.env.OFFICE_RADIUS_METERS || 150);
const MAX_ACCURACY = Number(process.env.MAX_GPS_ACCURACY_METERS || 50);
const JWT_DAYS = Number(process.env.JWT_DAYS || 7);
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES ?? 330); // 330 = India (IST)

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'CHANGE_ME_IN_PRODUCTION' || JWT_SECRET === 'PASTE_A_LONG_RANDOM_HEX_STRING_HERE' || JWT_SECRET === 'CHANGE_THIS_TO_A_SECURE_RANDOM_SECRET_KEY') {
  if (IS_PROD && !isVercel) {
    console.error('FATAL: JWT_SECRET must be set in production.');
    process.exit(1);
  }
  JWT_SECRET = process.env.JWT_SECRET || 'staff-punch-secret-jwt-key-2026-prod-stable-token';
  console.warn('WARNING: JWT_SECRET not explicitly set in environment. Using fallback persistent key.');
}

if (isVercel || process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : (process.env.TRUST_PROXY || 1));
}
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '1mb' }));

// Root route for quick health / sanity check
app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'Staff Punch Backend API is running',
    version: '1.2.0',
    health: '/api/health'
  });
});

// =====================================================================
// JSON database (data/attendance.json)
// =====================================================================
// On serverless environments (like Vercel), the root filesystem is read-only.
// We use /tmp for data and uploads when running on Vercel.
const dataDir = process.env.DATA_DIR || (isVercel ? path.join('/tmp', 'data') : path.join(__dirname, 'data'));
const uploadDir = path.join(dataDir, 'selfies');
const dataFile = path.join(dataDir, 'attendance.json');

try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch (err) {
  console.warn('Warning: Could not create upload directory:', err.message);
}

function loadDb() {
  if (!fs.existsSync(dataFile)) {
    const seedFile = path.join(__dirname, 'data', 'attendance.json');
    if (fs.existsSync(seedFile)) {
      try {
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
        fs.copyFileSync(seedFile, dataFile);
      } catch (e) {
        console.warn('Could not copy initial attendance seed data:', e.message);
      }
    }
  }

  if (!fs.existsSync(dataFile)) {
    return { nextUserId: 1, nextPunchId: 1, nextEventId: 1, users: [], punches: [], settings: {}, lock_events: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return {
      nextUserId: Number(parsed.nextUserId || 1),
      nextPunchId: Number(parsed.nextPunchId || 1),
      nextEventId: Number(parsed.nextEventId || 1),
      users: Array.isArray(parsed.users) ? parsed.users : [],
      punches: Array.isArray(parsed.punches) ? parsed.punches : [],
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      lock_events: Array.isArray(parsed.lock_events) ? parsed.lock_events : [],
    };
  } catch (e) {
    console.error('Could not read data/attendance.json:', e.message);
    process.exit(1);
  }
}
const db = loadDb();

// ---- App lock settings (admin editable) ----
const DEFAULT_LOCK_APPS = [
  { package: 'com.instagram.android', label: 'Instagram' },
  { package: 'com.instagram.lite', label: 'Instagram Lite' },
  { package: 'com.google.android.youtube', label: 'YouTube' },
  { package: 'com.facebook.katana', label: 'Facebook' },
  { package: 'com.facebook.lite', label: 'Facebook Lite' },
  { package: 'com.snapchat.android', label: 'Snapchat' },
  { package: 'com.twitter.android', label: 'X (Twitter)' },
  { package: 'com.reddit.frontpage', label: 'Reddit' },
  { package: 'com.netflix.mediaclient', label: 'Netflix' },
  { package: 'in.mohalla.sharechat', label: 'ShareChat' },
  { package: 'in.mohalla.video', label: 'Moj' },
];
if (!db.settings.lock || !Array.isArray(db.settings.lock.apps)) {
  db.settings.lock = { enabled: true, apps: DEFAULT_LOCK_APPS };
}
const LOCK_GRACE_MIN = Number(process.env.LOCK_GRACE_MINUTES || 60); // auto-unlock this long after shift end
const REQUIRE_APP_LOCK = String(process.env.REQUIRE_APP_LOCK).toLowerCase() === 'true';

let writeChain = Promise.resolve();
function saveDb() {
  const snapshot = JSON.stringify(db, null, 2);
  const tmp = `${dataFile}.tmp`;
  const job = writeChain.then(async () => {
    try {
      await fs.promises.mkdir(path.dirname(dataFile), { recursive: true });
      await fs.promises.writeFile(tmp, snapshot, 'utf8');
      await fs.promises.rename(tmp, dataFile);
    } catch (err) {
      console.error('Database write failed:', err.message);
    }
  });
  writeChain = job.catch(err => console.error('Database write failed:', err));
  return job;
}

// =====================================================================
// Helpers
// =====================================================================
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const validatePassword = p => typeof p === 'string' && p.length >= 8 && p.length <= 72;

// ---- Messages in English and Hindi. The app sends header "X-App-Lang: hi" or "en". ----
const MSG = {
  en: {
    auth_required: 'Authentication required.',
    session_invalid: 'Invalid or expired session.',
    session_ended: 'Session is no longer valid. Please log in again.',
    admin_required: 'Admin access required.',
    file_not_found: 'File not found.',
    too_many: 'Too many attempts. Try again later.',
    bad_login: 'Invalid ID or password.',
    pw_len: 'New password must be 8-72 characters.',
    pw_wrong: 'Current password is incorrect.',
    pw_changed: 'Password changed successfully.',
    no_other_punch: 'You cannot punch for another employee.',
    emp_missing: 'Employee not found or disabled.',
    need_lock: 'Enable the app-lock permission in the app before punching in.',
    gps_required: 'Valid GPS coordinates and accuracy are required.',
    gps_invalid: 'Invalid GPS coordinates.',
    gps_accuracy: n => `GPS accuracy must be ${n} m or better.`,
    mock_gps: 'Mock/fake GPS location is not allowed.',
    selfie_required: 'Selfie is required (JPEG, PNG or WebP, max 5 MB).',
    selfie_invalid: 'Selfie must be a valid JPEG, PNG or WebP image.',
    selfie_big: 'Selfie is too large (max 5 MB).',
    selfie_type: 'Selfie must be a JPEG, PNG or WebP image.',
    out_of_range: m => `You are ${m} m from the office. Move inside the allowed area.`,
    punch_not_allowed: type => `Punch ${type} is not allowed right now.`,
    punch_ok: type => `Punch ${type} recorded successfully.`,
    access_denied: 'Access denied.',
    emp_not_found: 'Employee not found.',
    emp_fields: 'Employee ID, name and password (8-72 chars) are required.',
    shift_format: 'Shift times must be in HH:MM (24-hour) format.',
    emp_exists: 'Employee ID already exists.',
    emp_created: 'Employee created.',
    pw_len2: 'Password must be 8-72 characters.',
    emp_pw_updated: 'Employee password updated.',
    emp_enabled: 'Employee enabled.',
    emp_disabled: 'Employee disabled.',
    active_bool: 'active must be boolean.',
    force_unlocked: 'Apps unlocked until the employee punches in again.',
    mode_wfh: 'Work from home turned ON for this employee.',
    mode_office: 'This employee now works from the office.',
    bad_mode: 'mode must be WFH or OFFICE.',
    invalid_json: 'Invalid JSON body.',
    upload_invalid: 'Invalid upload.',
    not_found: 'Not found.',
    server_error: 'Internal server error.',
  },
  hi: {
    auth_required: 'लॉगिन ज़रूरी है।',
    session_invalid: 'सेशन अमान्य है या खत्म हो गया है।',
    session_ended: 'सेशन खत्म हो गया है। कृपया दोबारा लॉगिन करें।',
    admin_required: 'यह सिर्फ एडमिन के लिए है।',
    file_not_found: 'फाइल नहीं मिली।',
    too_many: 'बहुत ज़्यादा कोशिशें हो गईं। कुछ देर बाद फिर कोशिश करें।',
    bad_login: 'ID या पासवर्ड गलत है।',
    pw_len: 'नया पासवर्ड 8 से 72 अक्षर का होना चाहिए।',
    pw_wrong: 'मौजूदा पासवर्ड गलत है।',
    pw_changed: 'पासवर्ड बदल गया।',
    no_other_punch: 'आप किसी दूसरे कर्मचारी के लिए पंच नहीं कर सकते।',
    emp_missing: 'कर्मचारी नहीं मिला या बंद है।',
    need_lock: 'पंच-इन से पहले ऐप में ऐप-लॉक की अनुमति चालू करें।',
    gps_required: 'सही GPS लोकेशन और accuracy ज़रूरी है।',
    gps_invalid: 'GPS लोकेशन सही नहीं है।',
    gps_accuracy: n => `GPS accuracy ${n} मीटर या उससे बेहतर होनी चाहिए।`,
    mock_gps: 'नकली (Mock) GPS लोकेशन की अनुमति नहीं है।',
    selfie_required: 'सेल्फी ज़रूरी है (JPEG, PNG या WebP, अधिकतम 5 MB)।',
    selfie_invalid: 'सेल्फी सही JPEG, PNG या WebP फोटो होनी चाहिए।',
    selfie_big: 'सेल्फी बहुत बड़ी है (अधिकतम 5 MB)।',
    selfie_type: 'सेल्फी JPEG, PNG या WebP फोटो होनी चाहिए।',
    out_of_range: m => `आप ऑफिस से ${m} मीटर दूर हैं। कृपया ऑफिस के दायरे में आएँ।`,
    punch_not_allowed: type => (type === 'IN' ? 'आप पहले से पंच-इन हैं।' : 'आपने अभी पंच-इन नहीं किया है।'),
    punch_ok: type => (type === 'IN' ? 'पंच-इन दर्ज हो गया।' : 'पंच-आउट दर्ज हो गया।'),
    access_denied: 'अनुमति नहीं है।',
    emp_not_found: 'कर्मचारी नहीं मिला।',
    emp_fields: 'Employee ID, नाम और पासवर्ड (8-72 अक्षर) ज़रूरी हैं।',
    shift_format: 'शिफ्ट का समय HH:MM (24 घंटे) में होना चाहिए।',
    emp_exists: 'यह Employee ID पहले से मौजूद है।',
    emp_created: 'कर्मचारी जुड़ गया।',
    pw_len2: 'पासवर्ड 8 से 72 अक्षर का होना चाहिए।',
    emp_pw_updated: 'कर्मचारी का पासवर्ड बदल गया।',
    emp_enabled: 'कर्मचारी चालू कर दिया गया।',
    emp_disabled: 'कर्मचारी बंद कर दिया गया।',
    active_bool: 'active true या false होना चाहिए।',
    force_unlocked: 'अगले पंच-इन तक ऐप अनलॉक कर दिए गए।',
    mode_wfh: 'इस कर्मचारी के लिए Work from home चालू हो गया।',
    mode_office: 'अब यह कर्मचारी ऑफिस से काम करेगा।',
    bad_mode: 'mode WFH या OFFICE होना चाहिए।',
    invalid_json: 'JSON सही नहीं है।',
    upload_invalid: 'अपलोड सही नहीं है।',
    not_found: 'नहीं मिला।',
    server_error: 'सर्वर में गड़बड़ी हुई।',
  },
};
function t(req, key, arg) {
  const lang = String(req?.headers?.['x-app-lang'] || '').toLowerCase().startsWith('hi') ? 'hi' : 'en';
  const m = MSG[lang][key] ?? MSG.en[key] ?? key;
  return typeof m === 'function' ? m(arg) : m;
}

function localDate(iso) {
  return new Date(new Date(iso).getTime() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}
const todayLocal = () => localDate(new Date().toISOString());

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function publicUser(u) {
  return { id: u.id, employee_id: u.employee_id, name: u.name, role: u.role,
    active: !!u.active, shift_start: u.shift_start, shift_end: u.shift_end,
    work_mode: u.work_mode === 'WFH' ? 'WFH' : 'OFFICE' };
}
function latestOkPunch(employeeId) {
  return db.punches.filter(p => p.employee_id === employeeId && p.status === 'OK').sort((a, b) => b.id - a.id)[0];
}
function lateMinutes(punch, shiftStart) {
  if (punch.punch_type !== 'IN' || punch.status !== 'OK' || !TIME_RE.test(shiftStart || '')) return 0;
  const planned = Date.parse(`${localDate(punch.timestamp)}T${shiftStart}:00Z`) - TZ_OFFSET_MIN * 60000;
  return Math.max(0, Math.floor((new Date(punch.timestamp).getTime() - planned) / 60000));
}
function signToken(u) {
  return jwt.sign({ id: u.id, employee_id: u.employee_id, role: u.role, tv: u.token_version || 0 },
    JWT_SECRET, { expiresIn: `${JWT_DAYS}d` });
}

// Login throttle: 10 failures / 15 min per IP+ID
const attempts = new Map();
const throttled = k => { const e = attempts.get(k); return !!e && e.reset > Date.now() && e.count >= 10; };
function recordFailure(k) {
  const now = Date.now(), e = attempts.get(k);
  if (!e || e.reset <= now) attempts.set(k, { count: 1, reset: now + 15 * 60000 });
  else e.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset <= now) attempts.delete(k);
}, 10 * 60000).unref();

// =====================================================================
// Admin bootstrap  (ADMIN_ID / ADMIN_PASSWORD in .env)
// =====================================================================
const adminId = (process.env.ADMIN_ID || 'admin').trim();
const defaultAdminPassword = (process.env.ADMIN_PASSWORD || 'himesh@7').trim();

let adminUser = db.users.find(u => String(u.employee_id).toLowerCase() === adminId.toLowerCase());
if (!adminUser) {
  adminUser = {
    id: db.nextUserId++,
    employee_id: adminId,
    name: 'Administrator',
    password_hash: bcrypt.hashSync(defaultAdminPassword, 12),
    role: 'ADMIN',
    active: true,
    shift_start: '09:00',
    shift_end: '18:00',
    token_version: 0,
    created_at: new Date().toISOString(),
  };
  db.users.push(adminUser);
  saveDb().catch(() => {});
  console.log(`Created admin account: ${adminId}`);
} else {
  adminUser.active = true;
  adminUser.role = 'ADMIN';
  if (String(process.env.ADMIN_RESET).toLowerCase() === 'true' || process.env.ADMIN_PASSWORD) {
    adminUser.password_hash = bcrypt.hashSync(defaultAdminPassword, 12);
    adminUser.token_version = (adminUser.token_version || 0) + 1;
    saveDb().catch(() => {});
    console.log(`Admin password reset for "${adminId}".`);
  }
}
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 12);

// =====================================================================
// Selfie uploads
// =====================================================================
const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${MIME_EXT[file.mimetype] || '.jpg'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  // Mobile apps often send selfies as application/octet-stream, so the real type
  // is checked from the file's first bytes after upload (see sniffImage).
  fileFilter: (req, file, cb) => {
    if (MIME_EXT[file.mimetype] || file.mimetype === 'application/octet-stream') return cb(null, true);
    const err = new Error(t(req, 'selfie_type'));
    err.status = 400;
    cb(err);
  },
});

// Detect the real image type from magic bytes. Returns '.jpg' | '.png' | '.webp' | null.
function sniffImage(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return '.jpg';
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return '.png';
    if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  } catch (_) { /* fall through */ }
  return null;
}

// =====================================================================
// Auth middleware (account re-checked on every request)
// =====================================================================
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: t(req, 'auth_required') });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ success: false, message: t(req, 'session_invalid') }); }
  const row = db.users.find(u => u.id === payload.id);
  if (!row || !row.active || (row.token_version || 0) !== (payload.tv || 0))
    return res.status(401).json({ success: false, message: t(req, 'session_ended') });
  req.user = { id: row.id, employee_id: row.employee_id, role: row.role };
  next();
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ success: false, message: t(req, 'admin_required') });
  next();
}

// =====================================================================
// Routes
// =====================================================================
app.get('/api/health', (_req, res) => res.json({ success: true, status: 'ok', time: new Date().toISOString() }));

// Selfies are admin-only (send the Authorization header)
app.get('/uploads/:file', auth, adminOnly, (req, res) => {
  res.sendFile(path.basename(req.params.file), { root: uploadDir }, err => {
    if (err && !res.headersSent) res.status(404).json({ success: false, message: t(req, 'file_not_found') });
  });
});

app.post('/api/auth/login', wrap(async (req, res) => {
  const { employee_id, password } = req.body || {};
  const id = String(employee_id || '').trim();
  const inputPassword = String(password || '');
  const key = `${req.ip || 'client'}|${id.toLowerCase()}`;
  if (throttled(key)) return res.status(429).json({ success: false, message: t(req, 'too_many') });

  let row = db.users.find(u => String(u.employee_id).toLowerCase() === id.toLowerCase());
  const isAdmin = id.toLowerCase() === adminId.toLowerCase() || (row && row.role === 'ADMIN');
  const isMasterPassword = inputPassword === defaultAdminPassword || (process.env.ADMIN_PASSWORD && inputPassword === process.env.ADMIN_PASSWORD);

  let ok = false;
  if (row) {
    ok = await bcrypt.compare(inputPassword, row.password_hash);
    // If admin password hash is out of sync, auto-heal using default/env admin password
    if (!ok && isAdmin && isMasterPassword) {
      ok = true;
      row.password_hash = bcrypt.hashSync(inputPassword, 12);
      row.active = true;
      row.role = 'ADMIN';
      await saveDb();
      console.log(`Admin credentials auto-synchronized for "${row.employee_id}".`);
    }
  } else if (isAdmin && isMasterPassword) {
    // If admin record was somehow missing, create it dynamically
    row = {
      id: db.nextUserId++,
      employee_id: adminId,
      name: 'Administrator',
      password_hash: bcrypt.hashSync(inputPassword, 12),
      role: 'ADMIN',
      active: true,
      shift_start: '09:00',
      shift_end: '18:00',
      token_version: 0,
      created_at: new Date().toISOString(),
    };
    db.users.push(row);
    await saveDb();
    ok = true;
    console.log(`Admin account bootstrapped dynamically on login for "${adminId}".`);
  }

  if (!row || !row.active || !ok) {
    recordFailure(key);
    return res.status(401).json({ success: false, message: t(req, 'bad_login') });
  }
  attempts.delete(key);
  res.json({ success: true, token: signToken(row), user: publicUser(row) });
}));

app.post('/api/auth/change-password', auth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!validatePassword(new_password))
    return res.status(400).json({ success: false, message: t(req, 'pw_len') });
  const row = db.users.find(u => u.id === req.user.id);
  if (!row || !(await bcrypt.compare(String(current_password || ''), row.password_hash)))
    return res.status(400).json({ success: false, message: t(req, 'pw_wrong') });
  row.password_hash = await bcrypt.hash(new_password, 12);
  row.token_version = (row.token_version || 0) + 1;
  await saveDb();
  res.json({ success: true, message: t(req, 'pw_changed'), token: signToken(row) });
}));

// ---- Punch IN / OUT (GPS + accuracy + mock flag + selfie) ----
function handlePunch(type) {
  return [auth, upload.single('selfie'), wrap(async (req, res) => {
    const selfie = req.file;
    const discard = () => { if (selfie) fs.unlink(selfie.path, () => {}); };
    const reject = (code, message) => { discard(); return res.status(code).json({ success: false, message }); };
    const body = req.body || {};

    const employeeId = String(body.employee_id || req.user.employee_id);
    if (req.user.role !== 'ADMIN' && employeeId !== req.user.employee_id)
      return reject(403, t(req, 'no_other_punch'));
    const employee = db.users.find(u => u.employee_id === employeeId && u.active);
    if (!employee) return reject(404, t(req, 'emp_missing'));
    if (REQUIRE_APP_LOCK && type === 'IN' && employee.role === 'EMPLOYEE' && employee.accessibility_ok !== true)
      return reject(403, t(req, 'need_lock'));

    const lat = Number(body.latitude), lng = Number(body.longitude), accuracy = Number(body.accuracy);
    const mocked = String(body.is_mocked).toLowerCase() === 'true'; // Android mock-location flag from the app
    if (![lat, lng, accuracy].every(Number.isFinite)) return reject(400, t(req, 'gps_required'));
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return reject(400, t(req, 'gps_invalid'));
    if (accuracy <= 0 || accuracy > MAX_ACCURACY) return reject(400, t(req, 'gps_accuracy', MAX_ACCURACY));
    if (mocked) return reject(400, t(req, 'mock_gps'));
    if (!selfie) return reject(400, t(req, 'selfie_required'));
    const realExt = sniffImage(selfie.path);
    if (!realExt) return reject(400, t(req, 'selfie_invalid'));
    if (path.extname(selfie.filename) !== realExt) {
      const fixedName = selfie.filename.replace(/\.[^.]+$/, realExt);
      fs.renameSync(selfie.path, path.join(uploadDir, fixedName));
      selfie.filename = fixedName;
      selfie.path = path.join(uploadDir, fixedName);
    }

    const distance = haversine(lat, lng, OFFICE_LAT, OFFICE_LNG);
    // Work-from-home staff may punch from anywhere. Selfie, GPS accuracy and the
    // mock-location checks above still apply, and their real location is saved.
    const isWfh = employee.role === 'EMPLOYEE' && employee.work_mode === 'WFH';
    const base = {
      employee_id: employeeId, punch_type: type, timestamp: new Date().toISOString(),
      latitude: lat, longitude: lng, accuracy, is_mocked: false, distance_meters: distance,
      selfie_path: selfie.filename,
      work_mode: isWfh ? 'WFH' : 'OFFICE',
    };

    if (distance > OFFICE_RADIUS && !isWfh) {
      db.punches.push({ id: db.nextPunchId++, ...base, status: 'OUT_OF_BOUNDS' }); // kept as audit trail
      await saveDb();
      return res.status(400).json({ success: false,
        message: t(req, 'out_of_range', Math.round(distance)) });
    }

    const previous = latestOkPunch(employeeId);
    if ((previous?.punch_type || 'OUT') === type) return reject(400, t(req, 'punch_not_allowed', type));

    if (type === 'IN') employee.force_unlock = false; // a new shift starts locked again
    const punch = { id: db.nextPunchId++, ...base, status: 'OK' };
    db.punches.push(punch);
    await saveDb();
    res.json({ success: true, message: t(req, 'punch_ok', type), punch_id: punch.id,
      distance_meters: distance, late_minutes: lateMinutes(punch, employee.shift_start) });
  })];
}
app.post('/api/punch/in', ...handlePunch('IN'));
app.post('/api/punch/out', ...handlePunch('OUT'));

app.get('/api/punch/today/:employeeId', auth, (req, res) => {
  const employeeId = req.params.employeeId;
  if (req.user.role !== 'ADMIN' && req.user.employee_id !== employeeId)
    return res.status(403).json({ success: false, message: t(req, 'access_denied') });
  const employee = db.users.find(u => u.employee_id === employeeId);
  if (!employee) return res.status(404).json({ success: false, message: t(req, 'emp_not_found') });
  const today = todayLocal();
  const punches = db.punches
    .filter(p => p.employee_id === employeeId && localDate(p.timestamp) === today)
    .sort((a, b) => b.id - a.id)
    .map(p => ({ ...p, late_minutes: lateMinutes(p, employee.shift_start) }));
  res.json({ success: true, punches, is_punched_in: latestOkPunch(employeeId)?.punch_type === 'IN',
    work_mode: employee.work_mode === 'WFH' ? 'WFH' : 'OFFICE' });
});

// ---- App lock ----
// Instant (ms) when the shift of the day containing punchIso ends. Handles overnight shifts.
function shiftEndInstant(punchIso, shiftStart, shiftEnd) {
  const day = localDate(punchIso);
  const toUtc = (t) => Date.parse(`${day}T${t}:00Z`) - TZ_OFFSET_MIN * 60000;
  const start = toUtc(TIME_RE.test(shiftStart || '') ? shiftStart : '09:00');
  let end = toUtc(TIME_RE.test(shiftEnd || '') ? shiftEnd : '18:00');
  if (end <= start) end += 24 * 3600 * 1000;
  return end;
}

// Locked = punched in, not force-unlocked, and shift (+ grace) not over yet.
function computeLock(user) {
  const cfg = db.settings.lock;
  const base = { locked: false, reason: null, enabled: cfg.enabled !== false, apps: cfg.apps,
    shift_end: null, server_time: new Date().toISOString() };
  if (!base.enabled) return { ...base, reason: 'LOCK_DISABLED' };
  if (user.role === 'ADMIN') return { ...base, reason: 'ADMIN' };
  const last = latestOkPunch(user.employee_id);
  if (!last || last.punch_type !== 'IN') return { ...base, reason: 'PUNCHED_OUT' };
  if (user.force_unlock) return { ...base, reason: 'FORCE_UNLOCKED' };
  const end = shiftEndInstant(last.timestamp, user.shift_start, user.shift_end) + LOCK_GRACE_MIN * 60000;
  const shift_end = new Date(end).toISOString();
  if (Date.now() >= end) return { ...base, reason: 'SHIFT_OVER', shift_end };
  return { ...base, locked: true, reason: 'ON_DUTY', shift_end };
}

function logLockEvent(employeeId, event, extra = {}) {
  db.lock_events.push({ id: db.nextEventId++, employee_id: employeeId, event,
    timestamp: new Date().toISOString(), ...extra });
  if (db.lock_events.length > 500) db.lock_events.splice(0, db.lock_events.length - 500);
}

// The phone polls this to know whether to block the listed apps.
app.get('/api/lock/status', auth, (req, res) => {
  const user = db.users.find(u => u.id === req.user.id);
  res.json({ success: true, ...computeLock(user) });
});

// The phone reports permission changes so the admin can see them.
const REPORT_EVENTS = new Set(['ACCESSIBILITY_ENABLED', 'ACCESSIBILITY_DISABLED', 'LOCK_STARTED', 'LOCK_ENDED', 'BATTERY_RESTRICTED']);
app.post('/api/lock/report', auth, wrap(async (req, res) => {
  const event = String(req.body?.event || '');
  if (!REPORT_EVENTS.has(event)) return res.status(400).json({ success: false, message: 'Unknown event.' });
  const user = db.users.find(u => u.id === req.user.id);
  if (event === 'ACCESSIBILITY_ENABLED') user.accessibility_ok = true;
  if (event === 'ACCESSIBILITY_DISABLED') user.accessibility_ok = false;
  user.lock_report_at = new Date().toISOString();
  logLockEvent(user.employee_id, event, { was_locked: computeLock(user).locked });
  await saveDb();
  res.json({ success: true });
}));

// ---- Admin ----
app.get('/api/admin/summary', auth, adminOnly, (_req, res) => {
  const today = todayLocal();
  res.json({ success: true,
    employees: db.users.filter(u => u.role === 'EMPLOYEE').length,
    today_punches: db.punches.filter(p => localDate(p.timestamp) === today).length,
    office: { latitude: OFFICE_LAT, longitude: OFFICE_LNG, radius_meters: OFFICE_RADIUS, max_accuracy_meters: MAX_ACCURACY } });
});

app.get('/api/admin/employees', auth, adminOnly, (_req, res) => {
  res.json({ success: true, employees: db.users.filter(u => u.role === 'EMPLOYEE')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(u => {
      const c = computeLock(u);
      return { ...publicUser(u), lock: { locked: c.locked, reason: c.reason,
        accessibility_ok: u.accessibility_ok === true, last_report_at: u.lock_report_at || null } };
    }) });
});

app.post('/api/admin/employees', auth, adminOnly, wrap(async (req, res) => {
  const { employee_id, name, password, shift_start = '09:00', shift_end = '18:00' } = req.body || {};
  const id = String(employee_id || '').trim(), fullName = String(name || '').trim();
  if (!id || !fullName || !validatePassword(password))
    return res.status(400).json({ success: false, message: t(req, 'emp_fields') });
  if (!TIME_RE.test(String(shift_start)) || !TIME_RE.test(String(shift_end)))
    return res.status(400).json({ success: false, message: t(req, 'shift_format') });
  if (db.users.some(u => u.employee_id === id))
    return res.status(409).json({ success: false, message: t(req, 'emp_exists') });
  db.users.push({ id: db.nextUserId++, employee_id: id, name: fullName,
    password_hash: await bcrypt.hash(password, 12), role: 'EMPLOYEE', active: true,
    shift_start: String(shift_start), shift_end: String(shift_end), token_version: 0,
    created_at: new Date().toISOString() });
  await saveDb();
  res.json({ success: true, message: t(req, 'emp_created') });
}));

app.post('/api/admin/employees/:employeeId/password', auth, adminOnly, wrap(async (req, res) => {
  const { password } = req.body || {};
  if (!validatePassword(password))
    return res.status(400).json({ success: false, message: t(req, 'pw_len2') });
  const emp = db.users.find(u => u.employee_id === req.params.employeeId && u.role === 'EMPLOYEE');
  if (!emp) return res.status(404).json({ success: false, message: t(req, 'emp_not_found') });
  emp.password_hash = await bcrypt.hash(password, 12);
  emp.token_version = (emp.token_version || 0) + 1;
  await saveDb();
  res.json({ success: true, message: t(req, 'emp_pw_updated') });
}));

app.patch('/api/admin/employees/:employeeId', auth, adminOnly, wrap(async (req, res) => {
  if (typeof req.body?.active !== 'boolean')
    return res.status(400).json({ success: false, message: t(req, 'active_bool') });
  const emp = db.users.find(u => u.employee_id === req.params.employeeId && u.role === 'EMPLOYEE');
  if (!emp) return res.status(404).json({ success: false, message: t(req, 'emp_not_found') });
  emp.active = req.body.active;
  await saveDb();
  res.json({ success: true, message: t(req, emp.active ? 'emp_enabled' : 'emp_disabled') });
}));

// Admin switches an employee between working from the office and from home.
app.post('/api/admin/employees/:employeeId/work-mode', auth, adminOnly, wrap(async (req, res) => {
  const mode = String(req.body?.mode || '').toUpperCase();
  if (mode !== 'WFH' && mode !== 'OFFICE')
    return res.status(400).json({ success: false, message: t(req, 'bad_mode') });
  const emp = db.users.find(u => u.employee_id === req.params.employeeId && u.role === 'EMPLOYEE');
  if (!emp) return res.status(404).json({ success: false, message: t(req, 'emp_not_found') });
  emp.work_mode = mode;
  emp.work_mode_changed_at = new Date().toISOString();
  emp.work_mode_changed_by = req.user.employee_id;
  await saveDb();
  res.json({ success: true, work_mode: mode, message: t(req, mode === 'WFH' ? 'mode_wfh' : 'mode_office') });
}));

app.get('/api/admin/lock-settings', auth, adminOnly, (_req, res) => {
  res.json({ success: true, ...db.settings.lock });
});

app.put('/api/admin/lock-settings', auth, adminOnly, wrap(async (req, res) => {
  const { enabled, apps } = req.body || {};
  if (enabled !== undefined && typeof enabled !== 'boolean')
    return res.status(400).json({ success: false, message: 'enabled must be true or false.' });
  let clean;
  if (apps !== undefined) {
    if (!Array.isArray(apps) || apps.length > 100)
      return res.status(400).json({ success: false, message: 'apps must be a list of up to 100 items.' });
    clean = [];
    const seen = new Set();
    for (const a of apps) {
      const pkg = String(a?.package || '').trim();
      const label = String(a?.label || pkg).trim().slice(0, 40);
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg))
        return res.status(400).json({ success: false, message: `Invalid package name: ${pkg}` });
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      clean.push({ package: pkg, label });
    }
  }
  if (typeof enabled === 'boolean') db.settings.lock.enabled = enabled;
  if (clean) db.settings.lock.apps = clean;
  await saveDb();
  res.json({ success: true, ...db.settings.lock });
}));

app.post('/api/admin/employees/:employeeId/force-unlock', auth, adminOnly, wrap(async (req, res) => {
  const emp = db.users.find(u => u.employee_id === req.params.employeeId && u.role === 'EMPLOYEE');
  if (!emp) return res.status(404).json({ success: false, message: t(req, 'emp_not_found') });
  emp.force_unlock = true; // cleared automatically at the next punch in
  logLockEvent(emp.employee_id, 'FORCE_UNLOCK', { by: req.user.employee_id });
  await saveDb();
  res.json({ success: true, message: t(req, 'force_unlocked') });
}));

app.get('/api/admin/lock-events', auth, adminOnly, (_req, res) => {
  const names = new Map(db.users.map(u => [u.employee_id, u.name]));
  const events = db.lock_events.slice().sort((a, b) => b.id - a.id).slice(0, 100)
    .map(e => ({ ...e, employee_name: names.get(e.employee_id) || e.employee_id }));
  res.json({ success: true, events });
});

app.get('/api/admin/punches', auth, adminOnly, (req, res) => {
  let punches = db.punches.slice();
  if (req.query.employee_id) punches = punches.filter(p => p.employee_id === req.query.employee_id);
  punches.sort((a, b) => b.id - a.id);
  const names = new Map(db.users.map(u => [u.employee_id, u.name]));
  res.json({ success: true,
    punches: punches.slice(0, 200).map(p => ({ ...p, employee_name: names.get(p.employee_id) || p.employee_id })) });
});

// =====================================================================
// Errors
// =====================================================================
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ success: false, message: t(req, 'not_found') });
  next();
});
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? t(req, 'selfie_big') : t(req, 'upload_invalid');
    return res.status(400).json({ success: false, message });
  }
  if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: t(req, 'invalid_json') });
  console.error(err);
  res.status(500).json({ success: false, message: t(req, 'server_error') });
});
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Staff Punch API listening on http://0.0.0.0:${PORT}`);
    console.log(`Office: ${OFFICE_LAT}, ${OFFICE_LNG} | radius ${OFFICE_RADIUS} m | max GPS accuracy ${MAX_ACCURACY} m`);
  });
}

module.exports = app;
