import { normalize, stripAccents } from '../check.js';

export const LEVELS = ['A1', 'A2', 'B1'];

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// words.json "grammar": {"fr": "courses/fr/grammar.json"}; the index lists chapters, one file each.
export async function loadGrammar(paths) {
  const grammar = {};
  const errors = [];
  await Promise.all(Object.entries(paths).map(async ([lang, path]) => {
    const dir = path.replace(/[^/]*$/, '');
    try {
      const index = await fetchJson(`./${path}`);
      const chapters = await Promise.all(index.chapters.map(async (meta, i) => {
        try {
          return { ...meta, ...(await fetchJson(`./${dir}${meta.file}`)), id: meta.id, number: i + 1 };
        } catch (e) {
          errors.push(`${dir}${meta.file}: ${e.message}`);
          return { ...meta, number: i + 1, articles: [] };
        }
      }));
      grammar[lang] = buildGrammar({ ...index, chapters });
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
  }));
  return { grammar, errors };
}

// Chapters keep their order; every article knows its chapter and its neighbours in reading order.
export function buildGrammar(index) {
  const articles = [];
  const chapters = index.chapters.map(ch => {
    const own = (ch.articles || []).map(a => ({ ...a, chapter: ch.id }));
    articles.push(...own);
    return { ...ch, articles: own };
  });
  articles.forEach((a, i) => {
    a.index = i;
    a.search = searchKey([a.title, a.fr, ...(a.keywords || [])].join(' '));
    a.searchWords = new Set(a.search.split(' '));
  });
  return { ...index, chapters, articles, byId: new Map(articles.map(a => [a.id, a])) };
}

export const searchKey = text => stripAccents(normalize(text)).replace(/[^\p{L}\p{N}-]+/gu, ' ').trim();

// "y", "en" or "à" would match inside every other word, so short terms must be whole words.
const hits = (a, term) => (term.length <= 2 ? a.searchWords.has(term) : a.search.includes(term));

const rank = LEVELS.reduce((m, l, i) => ({ ...m, [l]: i }), {});
export const levelLabel = a => (a.levelTo && a.levelTo !== a.level ? `${a.level}–${a.levelTo}` : a.level);

// "A2" shows A1 and A2 articles; "all" shows everything.
export const withinLevel = (article, level) => level === 'all' || !level || rank[article.level] <= rank[level];

// Every word of the query has to appear; a hit in the title ranks first.
export function searchArticles(g, query, level = 'all') {
  const terms = searchKey(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  const title = a => ` ${searchKey(`${a.title} ${a.fr || ''}`)} `;
  return g.articles
    .filter(a => withinLevel(a, level) && terms.every(t => hits(a, t)))
    .map(a => ({ a, score: terms.filter(t => title(a).includes(` ${t} `)).length * 2 + terms.filter(t => title(a).includes(t)).length }))
    .sort((x, y) => y.score - x.score || x.a.index - y.a.index)
    .map(x => x.a);
}

// Articles that explain any of these Learn topics.
export function articlesForTopics(g, topics) {
  if (!g || !topics?.length) return [];
  const set = new Set(topics);
  return g.articles.filter(a => (a.topics || []).some(t => set.has(t)));
}
