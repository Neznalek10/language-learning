import { store } from './store.js';
import { buildBackup, parseBackup, profileFileName, restoredName } from './backup.js';

// Mirrors every profile into a folder the user picks once, so progress survives clearing browser data.
// Folder handles can't live in localStorage, so the chosen folder is kept in IndexedDB.
const DB = 'vocab-folder';
const SAVE_DELAY = 1500;

let handle = null;
let state = 'off';
let lastSaved = null;
let timer = null;
const dirty = new Set();

export const folderSupported = () => typeof window.showDirectoryPicker === 'function';
export const folderStatus = () => ({ state, name: handle?.name || '', lastSaved });
export const folderActive = () => state === 'ready';

function kv(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

function queue(id) {
  dirty.add(id);
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DELAY);
}

const queueAll = () => store.accounts.forEach(a => queue(a.id));

async function writeProfile(id) {
  const account = store.accounts.find(a => a.id === id);
  if (!account) return;
  const file = buildBackup(store.dataOf(id), { name: account.name, version: self.APP_VERSION || 'dev' });
  file.account.id = id;
  const writable = await (await handle.getFileHandle(profileFileName(account.name, id), { create: true })).createWritable();
  await writable.write(JSON.stringify(file));
  await writable.close();
}

async function flush() {
  clearTimeout(timer);
  if (state !== 'ready') return;
  const ids = [...dirty];
  dirty.clear();
  try {
    for (const id of ids) await writeProfile(id);
    lastSaved = Date.now();
  } catch {
    ids.forEach(id => dirty.add(id));
    state = 'locked';
  }
}

// Profiles in the folder that this browser doesn't have, e.g. after site data was cleared.
async function importMissing() {
  let count = 0;
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !/^vocab-.+\.json$/.test(entry.name)) continue;
    let backup;
    try {
      backup = parseBackup(await (await entry.getFile()).text());
    } catch {
      continue;
    }
    if (!backup.id || store.accounts.some(a => a.id === backup.id)) continue;
    store.restoreAccount(restoredName(backup.name, n => store.nameTaken(n)), backup.data, backup.id);
    count++;
  }
  return count;
}

async function becomeReady() {
  state = 'ready';
  const found = await importMissing().catch(() => 0);
  queueAll();
  return found;
}

export async function initFolder() {
  store.onSave = queue;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  if (!folderSupported()) return 0;
  handle = await kv('readonly', s => s.get('dir')).catch(() => null);
  if (!handle) return 0;
  const permission = await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
  if (permission === 'granted') return becomeReady();
  state = 'locked';
  return 0;
}

// The three below need a click: browsers only show folder prompts in response to one.
export async function chooseFolder() {
  let picked;
  try {
    picked = await window.showDirectoryPicker({ id: 'vocab', mode: 'readwrite', startIn: 'documents' });
  } catch {
    return null;
  }
  handle = picked;
  await kv('readwrite', s => s.put(picked, 'dir'));
  return becomeReady();
}

export async function reconnectFolder() {
  const permission = await handle?.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
  return permission === 'granted' ? becomeReady() : null;
}

// The files stay where they are; the app just stops writing to them.
export async function stopFolder() {
  await kv('readwrite', s => s.delete('dir'));
  handle = null;
  state = 'off';
  dirty.clear();
}
