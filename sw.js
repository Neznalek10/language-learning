importScripts('./version.js');

const CACHE = `vocab-${self.APP_VERSION}`;
const CORE = [
  './',
  './index.html',
  './version.js',
  './manifest.json',
  './conjugations/fr.json',
  './css/app.css',
  './js/app.js',
  './js/ai.js',
  './js/backup.js',
  './js/check.js',
  './js/conj.js',
  './js/data.js',
  './js/folder.js',
  './js/explain.js',
  './js/i18n.js',
  './js/i18n-cs.js',
  './js/learn/answers.js',
  './js/learn/blocks.js',
  './js/learn/course.js',
  './js/learn/grammar.js',
  './js/learn/askai.js',
  './js/learn/drills.js',
  './js/learn/freechat.js',
  './js/learn/mistakes.js',
  './js/learn/resume.js',
  './js/learn/speakprompt.js',
  './js/learn/topicgen.js',
  './js/learn/writestats.js',
  './js/learn/writing.js',
  './js/learn/exercises/build.js',
  './js/learn/exercises/cloze.js',
  './js/learn/exercises/form.js',
  './js/learn/exercises/index.js',
  './js/learn/exercises/order.js',
  './js/learn/exercises/transform.js',
  './js/learn/exercises/word.js',
  './js/srs.js',
  './js/units.js',
  './js/store.js',
  './js/ui.js',
  './js/views/accounts.js',
  './js/views/add.js',
  './js/views/decks.js',
  './js/views/drill.js',
  './js/views/grammar.js',
  './js/views/home.js',
  './js/views/import.js',
  './js/views/learn.js',
  './js/views/lesson.js',
  './js/views/practice.js',
  './js/views/settings.js',
  './js/views/stats.js',
  './js/views/tenses.js',
  './js/views/words.js',
  './js/views/backup-ui.js',
  './js/views/drills.js',
  './js/views/free.js',
  './js/views/mistakes.js',
  './js/views/resume.js',
  './js/views/generate.js',
  './js/views/speak.js',
  './js/views/write-tab.js',
  './js/views/write.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];
const PROMPTS = ['check-answer', 'check-write', 'free-chat', 'make-topic'];
// On a slow connection, fall back to the cached copy after this long instead of waiting.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const add = url => cache.add(new Request(url, { cache: 'reload' }));
    await Promise.allSettled(CORE.map(add));
    // Both learner languages, so switching works offline too.
    for (const manifest of ['words.json', 'en/words.json']) try {
      await add(`./${manifest}`);
      const index = await (await fetch(`./${manifest}`, { cache: 'reload' })).json();
      await Promise.allSettled(PROMPTS.map(name => add(`./${index.prompts || 'prompts/'}${name}.md`)));
      await Promise.allSettled(index.decks.map(path => add(`./${path}`)));
      for (const path of Object.values(index.courses || {})) {
        const course = await (await fetch(`./${path}`, { cache: 'reload' })).json();
        const dir = path.replace(/[^/]*$/, '');
        const files = [...course.units.flatMap(u => (u.parts?.length ? u.parts : [u])), ...Object.values(course.levels || {})]
          .filter(x => x.file).map(x => `${dir}${x.file}`);
        await Promise.allSettled([path, ...files].map(p => add(`./${p}`)));
      }
      for (const path of Object.values(index.grammar || {})) {
        const grammar = await (await fetch(`./${path}`, { cache: 'reload' })).json();
        const dir = path.replace(/[^/]*$/, '');
        await Promise.allSettled([path, ...grammar.chapters.map(c => `${dir}${c.file}`)].map(p => add(`./${p}`)));
      }
      for (const path of [...Object.values(index.writing || {}), ...Object.values(index.speaking || {}), ...Object.values(index.translate || {})]) await add(`./${path}`);
      for (const path of Object.values(index.drills || {})) {
        const drills = await (await fetch(`./${path}`, { cache: 'reload' })).json();
        const dir = path.replace(/[^/]*$/, '');
        await Promise.allSettled([path, ...drills.sets.map(s => `${dir}${s.file}`)].map(p => add(`./${p}`)));
      }
    } catch { /* decks get cached on first use instead */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => /^vocab-\d/.test(key) && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

// Network first: always try for the newest file, so a push to GitHub shows up on the next open.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const url = new URL(request.url);
  url.search = '';
  const key = request.mode === 'navigate' ? './index.html' : url.href;

  const network = fetch(request.url, { cache: 'no-cache' }).then(response => {
    if (response.ok) cache.put(key, response.clone());
    return response;
  });
  const cached = await cache.match(key);
  if (!cached) return network;

  const timeout = new Promise(resolve => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
