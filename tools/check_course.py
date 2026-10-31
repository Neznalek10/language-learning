"""Checks every course file before it reaches the app.

    python3 tools/check_course.py              # structure only, offline
    python3 tools/check_course.py --proofread  # also sends every French sentence to LanguageTool
    python3 tools/check_course.py --proofread --grammar  # proofreads only the grammar articles
    python3 tools/check_course.py --proofread --drills   # proofreads only the drills and the translation bank

Structure: unique ids, known types, one gap per cloze, word refs that exist,
verbs and tenses that exist in conjugations/fr.json, and gap answers that match
a real form of the hinted verb. Grammar articles (words.json "grammar") also need
an "In short" section first, 4+ examples, 3+ checks, and links that resolve. Proofreading catches grammar and spelling, not a
wrong translation, so the Czech side still needs a human look.
"""
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAP = "___"
ITEM_FIELDS = {
    "word": ["ref"],
    "cloze": ["fr", "a"],
    "build": ["cs", "a"],
    "transform": ["task_cs", "fr", "a"],
    "order": ["cs", "a"],
    "form": ["verb", "tense"],
}
BLOCKS = {"text", "table", "examples", "tip", "vocab", "check", "pattern", "compare", "tree", "see"}
SLOTS = {"S", "V", "aux", "part", "inf", "neg", "pron", "obj", "noun", "art", "adj", "adv", "time", "place", "prep", "q", "conj", "x"}
LEVELS = ["A1", "A2", "B1"]
# Grammar writes explanations in English: "en" and "task_en" stand in for "cs" and "task_cs".
ALT = {"cs": "en", "task_cs": "task_en"}
REFLEXIVE = re.compile(r"^(?:m'|t'|s'|me |te |se |nous |vous )")
LANGUAGETOOL = "https://api.languagetool.org/v2/check"
# The free API allows about 20 requests a minute.
CHUNK = 50
PAUSE_S = 4


def normalize(text):
    text = unicodedata.normalize("NFC", str(text)).lower()
    text = re.sub(r"[’‘`´]", "'", text)
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"[.!?…]+$", "", text).strip()


def expand(pattern):
    out = [""]
    for part in re.split(r"(\{[^{}]*\})", pattern):
        options = part[1:-1].split("|") if part.startswith("{") and part.endswith("}") else [part]
        out = [prefix + o for prefix in out for o in options][:200]
    return [re.sub(r"\s+", " ", s).strip() for s in out]


def load_words(index):
    ids = set()
    for path in index["decks"]:
        deck = json.loads((ROOT / path).read_text(encoding="utf-8"))
        deck_id = re.sub(r"^words/|\.json$", "", path)
        ids.update(f"{deck_id}#{normalize(w['q'])}" for w in deck["words"])
    return ids


class Checker:
    def __init__(self, lang, words, conj):
        self.lang, self.words, self.conj = lang, words, conj
        self.errors, self.ids, self.sentences = [], set(), []

    def error(self, where, message):
        self.errors.append(f"{where}: {message}")

    def verb_forms(self, verb):
        data = self.conj["verbs"].get(verb, {})
        forms = {f for cells in data.get("t", {}).values() for cell in cells if cell for f in cell}
        # A gap can also hold just the participle of a compound tense ("J'ai ___ mes devoirs." -> fait).
        participles = {f.split()[-1] for f in forms if " " in f}
        return forms | participles | {REFLEXIVE.sub("", f) for f in forms}

    def answers(self, where, item):
        answers = item.get("a")
        if not isinstance(answers, list) or not answers or not all(isinstance(a, str) and a.strip() for a in answers):
            self.error(where, '"a" must be a non-empty list of strings')
            return []
        for a in answers:
            if a.count("{") != a.count("}"):
                self.error(where, f"unbalanced braces in {a!r}")
        return [s for a in answers for s in expand(a)]

    def item(self, where, item, need_id=True):
        kind = item.get("type")
        if kind not in ITEM_FIELDS:
            return self.error(where, f"unknown type {kind!r}")
        if need_id:
            if not item.get("id"):
                self.error(where, "missing id")
            elif item["id"] in self.ids:
                self.error(where, f"duplicate id {item['id']}")
            self.ids.add(item.get("id"))
        for field in ITEM_FIELDS[kind]:
            if field not in item and ALT.get(field) not in item:
                self.error(where, f"{kind} needs {field!r}")
        if kind == "form":
            data = self.conj["verbs"].get(item.get("verb"))
            if not data:
                return self.error(where, f"no conjugation table for {item.get('verb')!r}")
            cells = data["t"].get(item.get("tense"))
            if not cells:
                return self.error(where, f"{item['verb']} has no tense {item.get('tense')!r}")
            if "person" in item and not (0 <= item["person"] < len(cells) and cells[item["person"]]):
                self.error(where, f"person {item['person']} doesn't exist for {item['verb']}")
            return
        if kind == "word":
            if f"{self.lang}/{item['ref'].split('#')[0]}#{normalize(item['ref'].split('#', 1)[1])}" not in self.words:
                self.error(where, f"unknown word {item['ref']!r}")
            return
        expanded = self.answers(where, item)
        if kind == "cloze":
            if item["fr"].count(GAP) != 1:
                self.error(where, f"cloze needs exactly one {GAP}")
            hint = item.get("hint")
            if hint in self.conj["verbs"] and not any(normalize(a) in {normalize(f) for f in self.verb_forms(hint)} for a in expanded):
                self.error(where, f"{expanded[0]!r} isn't a form of {hint}")
            self.sentences += [(where, item["fr"].replace(GAP, a)) for a in expanded[:3]]
        else:
            self.sentences += [(where, s) for s in expanded[:6]]
            if kind == "transform":
                self.sentences.append((where, re.sub(r"[\[\]]", "", item["fr"])))

    def test(self, name, test, sections):
        for item in test.get("pool", []):
            self.item(item.get("id", f"{name} test"), item)
            if item.get("lesson") not in sections:
                self.error(item.get("id", name), f"test item points to unknown lesson or part {item.get('lesson')!r}")
        if not 0 < test.get("pass", 0.7) <= 1:
            self.error(name, '"pass" must be between 0 and 1')

    def unit(self, name, unit, topics):
        lessons = {}
        for lesson in unit.get("lessons", []):
            lid = lesson.get("id", "?")
            if lid in lessons:
                self.error(name, f"duplicate lesson id {lid}")
            lessons[lid] = lesson
            for topic in lesson.get("topics", []):
                if topic not in topics:
                    self.error(lid, f"unknown topic {topic!r}")
            for ref in lesson.get("words", []):
                deck, _, prompt = ref.partition("#")
                if f"{self.lang}/{deck}#{normalize(prompt)}" not in self.words:
                    self.error(lid, f"unknown word {ref!r}")
            for c, card in enumerate(lesson.get("learn", [])):
                for block in card.get("blocks", []):
                    where = f"{lid} card {c + 1}"
                    if block.get("type") not in BLOCKS:
                        self.error(where, f"unknown block {block.get('type')!r}")
                    if block.get("type") == "table" and "verb" in block and block["verb"] not in self.conj["verbs"]:
                        self.error(where, f"no conjugation table for {block['verb']!r}")
                    if block.get("type") == "check":
                        self.item(where, block.get("item", {}), need_id=False)
                    if block.get("type") == "examples":
                        self.sentences += [(where, ex["fr"]) for ex in block["items"]]
            for item in lesson.get("practice", []):
                self.item(item.get("id", lid), item)
        if unit.get("test"):
            self.test(name, unit["test"], lessons)


def joined(parts):
    out = ""
    for _, text, *_ in parts:
        out += text if not out or out.endswith("'") or text.startswith("-") else " " + text
    return out


class GrammarChecker:
    """Grammar articles share the course checker, so ids stay unique across Learn and Grammar."""

    def __init__(self, checker, topics):
        self.c, self.topics = checker, topics
        self.articles, self.links, self.checks = {}, [], 0

    def block(self, where, block):
        c = self.c
        kind = block.get("type")
        if kind not in BLOCKS - {"vocab"}:
            return c.error(where, f"unknown block {kind!r}")
        if kind == "table":
            if "verb" in block:
                if block["verb"] not in c.conj["verbs"]:
                    c.error(where, f"no conjugation table for {block['verb']!r}")
                elif block.get("tense") not in c.conj["verbs"][block["verb"]]["t"]:
                    c.error(where, f"{block['verb']} has no tense {block.get('tense')!r}")
            elif not block.get("rows"):
                c.error(where, "table needs rows or a verb")
        elif kind == "examples":
            for ex in block.get("items", []):
                if not ex.get("fr") or not (ex.get("cs") or ex.get("en")):
                    c.error(where, "example needs fr and cs or en")
                else:
                    c.sentences.append((where, ex["fr"]))
            return len(block.get("items", []))
        elif kind == "check":
            c.item(where, block.get("item", {}), need_id=False)
        elif kind == "pattern":
            for f in block.get("formula", []):
                key = (f[0] if isinstance(f, list) else f).rstrip("?")
                if key not in SLOTS:
                    c.error(where, f"unknown slot {key!r} in formula")
            for row in block.get("rows", []):
                for part in row.get("parts", []):
                    if part[0] not in SLOTS or len(part) < 2:
                        c.error(where, f"bad slot {part!r}")
                c.sentences.append((where, joined(row.get("parts", []))))
        elif kind == "compare":
            for item in block.get("items", []):
                if not (item.get("cs") or item.get("en")) or not item.get("fr"):
                    c.error(where, "compare needs cs or en, and fr")
                elif item["fr"].count("[[") != item["fr"].count("]]"):
                    c.error(where, f"unbalanced [[ ]] in {item['fr']!r}")
                else:
                    c.sentences.append((where, item["fr"].replace("[[", "").replace("]]", "")))
        elif kind == "tree":
            stack = list(block.get("items", []))
            while stack:
                node = stack.pop()
                if not node.get("label"):
                    c.error(where, "tree node needs a label")
                if node.get("see"):
                    self.links.append((where, node["see"]))
                stack += node.get("children", [])
        elif kind == "see":
            self.links += [(where, r) for r in block.get("rules", [])]
            for v in block.get("verbs", []):
                if v not in c.conj["verbs"]:
                    c.error(where, f"no conjugation table for {v!r}")
        elif not (block.get("cs") or block.get("en")):
            c.error(where, f"{kind} needs cs or en")
        return 0

    def article(self, chapter, a):
        c = self.c
        aid = a.get("id") or "?"
        where = f"{chapter}/{aid}"
        if aid in self.articles:
            c.error(where, "duplicate article id")
        self.articles[aid] = a
        for field in ("title", "level", "sections", "checks", "keywords"):
            if not a.get(field):
                c.error(where, f"missing {field}")
        if a.get("level") not in LEVELS or (a.get("levelTo") and (a["levelTo"] not in LEVELS or LEVELS.index(a["levelTo"]) <= LEVELS.index(a.get("level", "A1")))):
            c.error(where, f"bad level {a.get('level')!r} / {a.get('levelTo')!r}")
        sections = a.get("sections", [])
        if sections and sections[0].get("title") != "In short":
            c.error(where, 'the first section must be "In short"')
        examples = 0
        for s in sections:
            if s.get("level") and s["level"] not in LEVELS:
                c.error(where, f"bad section level {s['level']!r}")
            for block in s.get("blocks", []):
                examples += self.block(f"{where} · {s.get('title')}", block) or 0
        if examples < 4:
            c.error(where, f"only {examples} examples, needs 4")
        checks = a.get("checks", [])
        if len(checks) < 3:
            c.error(where, f"only {len(checks)} checks, needs 3")
        for item in checks:
            if not str(item.get("id", "")).startswith(f"g-{aid}-"):
                c.error(where, f"check id {item.get('id')!r} should start with g-{aid}-")
            c.item(item.get("id", where), item)
        self.checks += len(checks)
        for t in a.get("topics", []):
            if t not in self.topics:
                c.error(where, f"unknown Learn topic {t!r}")
        for v in a.get("verbs", []):
            if v not in c.conj["verbs"]:
                c.error(where, f"no conjugation table for {v!r}")
        if a.get("tense") and a["tense"] not in {x["key"] for x in c.conj["tenses"]}:
            c.error(where, f"unknown tense {a['tense']!r}")
        self.links += [(where, r) for r in a.get("see", [])]

    def finish(self):
        for where, target in self.links:
            if target not in self.articles:
                self.c.error(where, f"link to unknown article {target!r}")


def check_grammar(lang, path, checker, topics):
    index = json.loads((ROOT / path).read_text(encoding="utf-8"))
    g = GrammarChecker(checker, topics)
    for chapter in index["chapters"]:
        data = json.loads(((ROOT / path).parent / chapter["file"]).read_text(encoding="utf-8"))
        for a in data.get("articles", []):
            g.article(chapter["id"], a)
    g.finish()
    levels = {l: sum(1 for a in g.articles.values() if a.get("level") == l) for l in LEVELS}
    print(f"{path}: {len(index['chapters'])} chapters, {len(g.articles)} articles ({', '.join(f'{k} {v}' for k, v in levels.items())}), {g.checks} checks")
    return g


def check_writing(path, checker, part_ids, article_ids, speaking=False):
    data = json.loads((ROOT / path).read_text(encoding="utf-8"))
    seen = set()
    for t in data["topics"]:
        where = f"{path} {t.get('id')}"
        if t.get("id") in seen:
            checker.error(where, "duplicate topic id")
        seen.add(t.get("id"))
        for field in ("title", "task", "level", "kind", "must", "phrases", "grammar"):
            if not t.get(field):
                checker.error(where, f"missing {field}")
        if t.get("level") not in LEVELS:
            checker.error(where, f"unknown level {t.get('level')!r}")
        if t.get("kind") not in data.get("kinds", {}):
            checker.error(where, f"unknown kind {t.get('kind')!r}")
        if t.get("unit") and str(t["unit"]) not in part_ids:
            checker.error(where, f"unknown unit {t['unit']!r}")
        for rule in t.get("grammar", []):
            if rule not in article_ids:
                checker.error(where, f"unknown grammar article {rule!r}")
        if speaking:
            for field in ("partner", "starter"):
                if not t.get(field):
                    checker.error(where, f"missing {field}")
        if len(t.get("must", [])) < 2:
            checker.error(where, "needs at least 2 requirements")
        if "\u2014" in json.dumps(t, ensure_ascii=False):
            checker.error(where, "contains an em dash")
    by_level = {l: sum(1 for t in data["topics"] if t.get("level") == l) for l in LEVELS}
    print(f"{path}: {len(data['topics'])} {'speaking' if speaking else 'writing'} topics ({', '.join(f'{k} {v}' for k, v in by_level.items())})")


def check_text(body, tries=3):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(LANGUAGETOOL, data=body), timeout=60) as res:
                return json.loads(res.read())["matches"]
        except urllib.error.HTTPError:
            if attempt == tries - 1:
                raise
            time.sleep(PAUSE_S * (attempt + 2))


def proofread(sentences, lang):
    seen, unique = set(), []
    for where, s in sentences:
        if s not in seen:
            seen.add(s)
            unique.append((where, s))
    problems = []
    for start in range(0, len(unique), CHUNK):
        if start:
            time.sleep(PAUSE_S)
        chunk = unique[start:start + CHUNK]
        text = "\n\n".join(s for _, s in chunk)
        body = urllib.parse.urlencode({"text": text, "language": lang}).encode()
        matches = check_text(body)
        offsets, pos = [], 0
        for where, s in chunk:
            offsets.append((pos, pos + len(s), where, s))
            pos += len(s) + 2
        for m in matches:
            for a, b, where, s in offsets:
                if a <= m["offset"] < b:
                    bad = s[m["offset"] - a:m["offset"] - a + m["length"]]
                    fix = ", ".join(r["value"] for r in m["replacements"][:3])
                    problems.append(f"{where}: {s!r}\n    {m['rule']['id']}: {m['message']} [{bad!r} -> {fix}]")
    return problems, len(unique)


def check_drills(index, checker, part_ids, article_ids):
    set_tags = {}
    for lang, path in index.get("drills", {}).items():
        base = (ROOT / path).parent
        listing = json.loads((ROOT / path).read_text(encoding="utf-8"))
        total = 0
        for meta in listing["sets"]:
            data = json.loads((base / meta["file"]).read_text(encoding="utf-8"))
            where = f"{path} {meta['id']}"
            tags = data.get("tags", {})
            set_tags[meta["id"]] = tags
            for key in data.get("why", {}):
                if key not in tags:
                    checker.error(where, f"why for unknown tag {key!r}")
            for item in data["items"]:
                here = item.get("id", where)
                if item.get("tag") not in tags:
                    checker.error(here, f"unknown tag {item.get('tag')!r}")
                if item.get("level") not in LEVELS:
                    checker.error(here, f"bad level {item.get('level')!r}")
                typed = {"type": item.get("type", data.get("type", "transform")), **item}
                if typed["type"] == "transform":
                    fr = item.get("fr", "")
                    if fr.count("[") != fr.count("]") or "[[" in fr or ("underlined" in item.get("task_en", "") and "[" not in fr):
                        checker.error(here, f"[marked] words must be balanced and present for an underlined task: {fr!r}")
                checker.item(here, typed)
            total += len(data["items"])
            print(f"{meta['file']}: {len(data['items'])} sentences, {len(tags)} types")
    for lang, path in index.get("translate", {}).items():
        data = json.loads((ROOT / path).read_text(encoding="utf-8"))
        for item in data["items"]:
            here = item.get("id", path)
            if item.get("level") not in LEVELS:
                checker.error(here, f"bad level {item.get('level')!r}")
            if item.get("unit") and str(item["unit"]) not in part_ids:
                checker.error(here, f"unknown unit {item['unit']!r}")
            for tag in item.get("tags", []):
                if tag not in article_ids:
                    checker.error(here, f"unknown grammar article {tag!r}")
            checker.item(here, {"type": "build", **item})
        print(f"{path}: {len(data['items'])} Czech sentences")
    return set_tags


def main():
    index = json.loads((ROOT / "words.json").read_text(encoding="utf-8"))
    words = load_words(index)
    failed = False
    for lang, path in index.get("courses", {}).items():
        course = json.loads((ROOT / path).read_text(encoding="utf-8"))
        conj = json.loads((ROOT / index["conjugations"][lang]).read_text(encoding="utf-8"))
        checker = Checker(lang, words, conj)
        topics = course.get("topics", {})
        units = course.get("units", [])
        parts = [p for u in units for p in (u.get("parts") or [u])]
        ids = [str(p["id"]) for p in parts]
        if len(set(ids)) != len(ids):
            checker.error(path, "duplicate unit or part ids")
        for part in parts:
            if part.get("file"):
                file = (ROOT / path).parent / part["file"]
                checker.unit(file.name, json.loads(file.read_text(encoding="utf-8")), topics)
        for key, level in course.get("levels", {}).items():
            if level.get("file"):
                file = (ROOT / path).parent / level["file"]
                own = {str(p["id"]) for u in units if u.get("level") == key for p in (u.get("parts") or [u]) if p.get("file")}
                checker.test(file.name, json.loads(file.read_text(encoding="utf-8"))["test"], own)
        print(f"{path}: {len(units)} units, {len(parts)} parts, {len(checker.ids)} exercises, {len(checker.sentences)} French sentences")
        before = len(checker.sentences)
        if lang in index.get("grammar", {}):
            g = check_grammar(lang, index["grammar"][lang], checker, topics)
            print(f"  grammar adds {len(checker.sentences) - before} French sentences")
            if lang in index.get("writing", {}):
                check_writing(index["writing"][lang], checker, set(ids), set(g.articles))
            if lang in index.get("speaking", {}):
                check_writing(index["speaking"][lang], checker, set(ids), set(g.articles), speaking=True)
            drill_start = len(checker.sentences)
            set_tags = check_drills(index, checker, set(ids), set(g.articles))
            for aid, article in g.articles.items():
                for link in article.get("drills", []):
                    if link.get("tag") not in set_tags.get(link.get("set"), {}):
                        checker.error(aid, f"drills link to unknown set or type: {link}")
                    if not link.get("label"):
                        checker.error(aid, "drills link needs a label")
        for e in checker.errors:
            print("  ERROR", e)
        failed |= bool(checker.errors)
        if "--proofread" in sys.argv:
            only = checker.sentences[drill_start:] if "--drills" in sys.argv else checker.sentences[before:] if "--grammar" in sys.argv else checker.sentences
            problems, n = proofread(only, lang)
            print(f"LanguageTool checked {n} unique sentences: {len(problems)} remarks")
            for p in problems:
                print("  ", p)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
