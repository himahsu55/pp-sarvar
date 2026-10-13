/**
 * Backup helper (Node built-ins only).
 * Copies data/ (attendance.json + selfies/) into backups/<timestamp>/ and keeps the newest BACKUP_KEEP copies.
 * Run:  npm run backup      (or: node backup.js)
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'data');
if (!fs.existsSync(src)) {
  console.error('No data/ folder yet - nothing to back up.');
  process.exit(1);
}

const root = path.join(__dirname, 'backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(root, stamp);
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

const keep = Number(process.env.BACKUP_KEEP || 14);
const all = fs.readdirSync(root).sort();
for (const old of all.slice(0, Math.max(0, all.length - keep))) {
  fs.rmSync(path.join(root, old), { recursive: true, force: true });
}
console.log(`Backup saved: ${dest}`);
