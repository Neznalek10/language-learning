export const BACKUP_FORMAT = 1;
export const BACKUP_KEYS = ['progress', 'conj', 'learn', 'write', 'activity', 'imports', 'additions', 'settings', 'lang'];
const OBJECT_KEYS = ['progress', 'conj', 'learn', 'write', 'activity', 'additions', 'settings'];
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);

// Everything a profile owns, as a plain object. The AI key stays out so a shared file can't leak it.
export function buildBackup(source, { name, version, now = new Date() }) {
  const data = {};
  for (const key of BACKUP_KEYS) {
    if (source[key] !== undefined) data[key] = JSON.parse(JSON.stringify(source[key] ?? null));
  }
  if (data.settings?.ai) data.settings.ai = { ...data.settings.ai, key: '' };
  delete data.settings?.lastBackup;
  return { app: 'vocab', format: BACKUP_FORMAT, appVersion: version, exported: now.toISOString(), account: { name }, data };
}

export function backupFileName(name, now = new Date()) {
  const safe = String(name).normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'profile';
  return `vocab-backup-${safe}-${now.toISOString().slice(0, 10)}.json`;
}

export function parseBackup(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('This file is not a backup (it is not valid JSON).');
  }
  if (!isObject(file) || file.app !== 'vocab' || !isObject(file.data)) throw new Error('This file is not a Vocab backup.');
  if (!Number.isInteger(file.format) || file.format > BACKUP_FORMAT) throw new Error('This backup was made by a newer version of the app. Update the app first.');
  const data = {};
  for (const key of OBJECT_KEYS) {
    if (file.data[key] === undefined) continue;
    if (!isObject(file.data[key])) throw new Error(`The backup is damaged (${key} has the wrong shape).`);
    data[key] = file.data[key];
  }
  if (file.data.imports !== undefined) {
    if (!Array.isArray(file.data.imports)) throw new Error('The backup is damaged (imports has the wrong shape).');
    data.imports = file.data.imports;
  }
  if (typeof file.data.lang === 'string') data.lang = file.data.lang;
  const name = String(file.account?.name || 'Restored').trim().slice(0, 24) || 'Restored';
  return { name, exported: file.exported || null, data };
}

export function backupSummary(data) {
  const progress = Object.values(data.progress || {});
  const topics = Object.values(data.write?.topics || {});
  return {
    words: progress.length,
    answers: progress.reduce((n, p) => n + (p.right || 0) + (p.wrong || 0), 0),
    lessons: Object.values(data.learn?.lessons || {}).filter(l => l.practiced).length,
    texts: topics.reduce((n, t) => n + (t.attempts?.length || 0), 0),
    mistakes: (data.write?.mistakes || []).length,
  };
}

// "User" -> "User (restored)" -> "User (restored 2)" when a profile with that name exists.
export function restoredName(base, taken) {
  if (!taken(base)) return base;
  const first = `${base} (restored)`.slice(0, 40);
  if (!taken(first)) return first;
  for (let n = 2; ; n++) {
    const next = `${base} (restored ${n})`.slice(0, 40);
    if (!taken(next)) return next;
  }
}
