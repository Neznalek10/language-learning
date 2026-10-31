# Vocab

A French trainer for Czech speakers that runs in the browser and installs on a phone as an app (PWA). It started as a vocabulary trainer and grew into a full A1 to A2 course with grammar, drills, writing and speaking practice. German has a small vocabulary set.

> **Vibe coded.** This project was built with AI assistance (Claude Code) by prompting and iterating, not by writing every line by hand. The course content (lessons, grammar, sentences) was also written with AI help, checked with the validator and LanguageTool, and reviewed by hand, but it has **not** been reviewed by a teacher. Expect some mistakes, and please open an issue when you find one.

## Features

- **Vocabulary**: 1,055 French words in 27 decks and 100 German words in 8 decks, Czech on the other side. Practise in either direction or mixed.
- **Levels**: every word moves through New, Learning (0 to 2 correct in a row), Familiar (3 to 4) and Mastered (5). Smart sessions show due words first, then new ones.
- **Answer checking** that forgives missing accents (optional), points out typos and explains each mistake: wrong accent, the letter that is off, a word you mixed it up with, a missing German article or reflexive pronoun.
- **Learn**: a French course in 9 units (A1 units 1 to 5, A2 units 6 to 9) with lessons explained in Czech, about 1,750 exercises and a test for every part. Units open in order.
- **Grammar**: a reference in English with 219 articles in 16 chapters, A1 to B1, each with typical mistakes and practice. Four chapters are step-by-step paths (object pronouns, imperative, conditional and *si*, subjunctive).
- **Tenses**: conjugation tables for 117 verbs in 18 tenses, with a drill.
- **Drills**: 900+ Czech sentences to translate, 372 pronoun replacements, 259 negations and 163 questions.
- **Write** (87 topics) and **Speak** (50 scenarios): writing is checked by an AI you connect yourself; speaking builds a prompt for any voice AI.
- **Profiles** with names only, **backup and restore** as a file, **works offline**.

Everything stays in your browser. There is no server and no account.

## Run it locally

No build step and no dependencies. Serve the folder and open it:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` straight from disk does not work, because browsers block loading the JSON files from `file://`.

## Put it online with GitHub Pages

All paths are relative (`./`), so the app works in a subfolder such as `https://<username>.github.io/<repo>/`.

1. Push this folder to a GitHub repository.
2. On github.com open the repository, then **Settings > Pages**.
3. Under **Build and deployment** choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute or two the address appears at the top of that page.

**Install on a phone:** open the address in Chrome, tap **⋮**, then **Install app** (or **Add to home screen**). It then opens full screen from its icon.

**Updates:** bump the number in `version.js` with every change you push. The service worker keys its offline cache on that number, and the version shows at the bottom of Home and in Settings. GitHub Pages usually rebuilds within one or two minutes. If a phone keeps showing the old version, close the app fully and reopen it, or use **Settings > Check for updates**.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/`, `icons/` | The app |
| `version.js` | Version number, bump it on every push |
| `manifest.json`, `sw.js` | Install info and the service worker (offline, newest files first) |
| `words.json` | Languages, the list of deck files and where the course files are |
| `words/<lang>/<deck>.json` | One file per vocabulary deck |
| `conjugations/fr.json` | Generated conjugation tables |
| `courses/fr/course.json` | The course map: units, parts, topics, level tests |
| `courses/fr/NN-name.json`, `a2-name.json`, `a1-test.json` | One file per course part (lessons and test), plus the A1 final test |
| `courses/fr/grammar.json`, `grammar/NN-name.json` | Grammar chapters and their articles |
| `courses/fr/drills.json`, `drills/*.json`, `translate.json` | Sentence drills and the translation bank |
| `courses/fr/writing.json`, `speaking.json` | Writing topics and speaking scenarios |
| `prompts/*.md` | Instructions sent to the AI (essay check, topic generator, free chat, answer appeal) |
| `tools/check_course.py` | Validates all course files, optionally proofreads them |
| `tools/conjugate.py` | Regenerates the conjugation tables |

## Adding words

Add a deck file, for example `words/fr/food-2.json`, and add its path to `decks` in `words.json`:

```json
{
  "lang": "fr",
  "from": "cs",
  "type": "topics",
  "title": "Food 2",
  "unit": null,
  "level": null,
  "words": [
    {"q": "jíst", "a": "manger"},
    {"q": "pes", "a": ["chien", "le chien"], "unit": "2.1", "level": "A1"}
  ]
}
```

- `lang` is the language you learn, `from` the language you translate from (two-letter codes).
- `type` groups decks in the app: `verbs`, `adjectives`, `nouns`, `phrases`, `topics` or `other`. Verb decks also feed the Tenses page.
- `a` is one answer or a list of accepted answers. The first one is shown as the correct answer.
- `unit` puts a word into a course part (`"2.1"`, `"9"`), `null` means no unit. Set it on the deck or override it per word.
- `level` is `A1` to `C2` or `null`. `why` (optional) is your own note, shown first when the word is answered wrong.
- For a new language create a folder such as `words/es/` and optionally add the language to `languages` in `words.json`.

Progress is stored per deck path and prompt (`fr/food#jíst`). Editing answers keeps progress; renaming a deck file or changing a prompt starts that word from zero.

**In the app:** Decks > Import takes pasted text (`pes; chien | le chien`, one pair per line), CSV or JSON. Decks > Add adds single words. Both are saved on that device only; a deck's **Download JSON** gives you a file to put into `words/`.

## Learn

**Path** shows the 9 units. A1 is 1 *Salut !*, 2 *Ma famille et mes loisirs*, 3 *Au collège*, 4 *À table et chez moi* and 5 *En ville*; A2 is 6 *La mode et le week-end*, 7 *Vacances et santé*, 8 *Médias et fêtes* and 9 *Mon avenir*. Units 1 to 8 are split into two or three parts (2.1 *Ma famille*, 2.2 *Portrait*, 2.3 *Mes loisirs*...). Each part has lessons and a test (70% to pass). A lesson opens after the previous one is practised, a test after all its lessons, the next part after the test. The **A1 final test** can be taken any time and opens all of A1 when passed. **Topics** lets you practise any reached grammar or vocabulary topic, mixed.

A lesson is **Learn** cards (Czech explanation, tables, examples, tips, a quick check) followed by **Practice**:

| Type | What you do |
|---|---|
| `word` | Czech word → French |
| `cloze` | Fill the gap |
| `form` | Conjugate (from the verb tables) |
| `order` | Build the sentence from tiles |
| `build` | Write the French for a Czech sentence |
| `transform` | Rewrite a sentence (negative, plural, pronoun...) |

Wrong answers come back once at the end. **I was right** accepts your answer on this device; **Ask AI** lets the AI judge it (needs an AI key). Tests give no feedback until the end, then show every mistake, a score per lesson and links to the grammar behind the mistakes.

### Course file format

`course.json` lists topics, units and level tests. A unit has `"parts"` (each with an `id` such as `"2.1"` and a `file`) or is a single part with its own `file`.

```json
{
  "id": "fr-01-3",
  "title": "Je suis...",
  "topics": ["pronouns", "etre"],
  "words": ["greetings#Čech, Češka", "basics#ano"],
  "learn": [
    {"title": "Sloveso être", "blocks": [
      {"type": "text", "cs": "*Être* je nepravidelné, takže se ho nauč nazpaměť."},
      {"type": "table", "verb": "être", "tense": "present"},
      {"type": "examples", "items": [{"fr": "Je suis tchèque.", "cs": "Jsem Čech."}]},
      {"type": "tip", "cs": "Národnost se píše malým písmenem."},
      {"type": "check", "item": {"type": "cloze", "fr": "Tu ___ tchèque ?", "a": ["es"]}}
    ]}
  ],
  "practice": [
    {"id": "fr-01-3-01", "type": "cloze", "fr": "Je ___ Hugo.", "a": ["suis"], "hint": "être"},
    {"id": "fr-01-3-08", "type": "build", "cs": "Jsi Francouz?", "a": ["{Tu es français|Es-tu français} ?"]}
  ]
}
```

- `*word*` marks French in explanations, `**word**` is bold.
- `{a|b}` in an answer accepts both versions and `{|très }bien` makes a part optional. Capitals, commas and final punctuation are ignored.
- Every exercise has a fixed `id`; progress is saved per id, so never rename ids. Some A1 files and ids still carry older unit numbers for that reason.
- Conjugations in lessons and `form` exercises always come from `conjugations/fr.json`.
- A test is `"test": {"pass": 0.7, "count": 20, "words": 6, "pool": [...]}` and each pool item names its `"lesson"`.

## Grammar

The Grammar tab is a reference: nothing is locked or tracked. Articles have **In short** first, then sections such as forms, use, word order, examples and **Watch out**. **Practice this rule** runs the article's checks; tense articles link to the conjugation drill. Search ignores accents, and a level filter hides articles above A1, A2 or B1 (the step-by-step chapters, marked `"path": true` in `grammar.json`, are never hidden).

Besides the Learn block types, grammar articles can use `pattern` (a sentence split into labelled slots), `compare` (English, the typical wrong French, the right French with the difference in `[[...]]`), `tree` and `see` (links). Explanations go in `en`. Check ids start with `g-<article id>-` and never change. The topic lists follow the DELF A1 to B1 grammar lists and the Lawless French A1 to B1 lessons.

## Drills

**Learn > Drills** (also on Home and in Grammar) has four sets: Translate into French, Replace with pronouns, Make it negative and Make it a question. Filter by level, unit or type, choose how many sentences and whether you want a smart mix, only your mistakes or random ones. Sets live in `courses/fr/drills/<set>.json` (`tags`, a `why` text per tag, and `items` with `[marked words]`); translation sentences are in `translate.json`.

## Write, Speak and AI

**Write**: pick a topic, level, length and how strict the check should be, then write in French. The AI scores task, grammar, vocabulary and naturalness (0 to 10 each, combined into a percentage by the app), marks mistakes with the rule behind them, suggests better phrasing and gives a corrected version. You can also ask it to practise particular pronouns, write freely, or chat with an AI pen pal. Mistakes are collected in **My mistakes** and can be practised.

**Speak** does not talk to an AI inside the app. It builds a detailed prompt for a voice AI you already use (ChatGPT voice mode, Gemini Live and similar): pick a scenario or free speech, the level, length and correction style, copy the prompt and paste it there.

**AI setup** is in Settings: an OpenAI-compatible address, key and model. The default is [OpenRouter](https://openrouter.ai) with the free router `openrouter/free`; a local [Ollama](https://ollama.com) server works too. The key stays in your browser and is never included in backups. Without a key you can still write, keep drafts and copy speaking prompts.

## Profiles, privacy and backups

The app opens on a profile picker. Profiles are names only, without passwords, and each has its own progress and settings, stored in this browser's `localStorage` under `vocab.<profileId>.<key>`. Nothing is sent anywhere except the texts you choose to check with the AI provider you configured.

Clearing site data or changing devices loses progress, so use **Settings > Back up progress**. **Restore** always creates a new profile and never overwrites one.

## Tools

Validate the course after every change (unique ids, known types, links, verb forms, one gap per cloze and more). `--proofread` also sends the French sentences to the public [LanguageTool](https://languagetool.org) API; it catches grammar and spelling, not wrong translations.

```bash
python3 tools/check_course.py
python3 tools/check_course.py --proofread            # everything
python3 tools/check_course.py --proofread --grammar  # grammar only
python3 tools/check_course.py --proofread --drills   # drills and translation bank only
```

The conjugation tables are generated with [verbecc](https://github.com/bretttolbert/verbecc) (Verbiste data), never typed by hand. After adding verbs to a verb deck:

```bash
python3 -m venv venv
venv/bin/pip install verbecc
venv/bin/python tools/conjugate.py
```

The script skips verbs it does not know, so check its output for typos.

## License

Released under the [MIT License](LICENSE).
