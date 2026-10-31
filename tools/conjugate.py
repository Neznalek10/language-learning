"""Builds conjugations/fr.json for every verb in the French verb decks.

Run it again after adding verbs to a deck whose "type" is "verbs":

    python3 -m venv venv
    venv/bin/pip install verbecc
    venv/bin/python tools/conjugate.py
"""
import json
import logging
import re
import sys
from pathlib import Path

from verbecc import CompleteConjugator, LangCodeISO639_1

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "conjugations" / "fr.json"

PERSONS = ["je", "tu", "il/elle", "nous", "vous", "ils/elles"]
PRONOUN_INDEX = {"je": 0, "tu": 1, "il": 2, "elle": 2, "nous": 3, "vous": 4, "ils": 5, "elles": 5}

# key, verbecc mood, verbecc tense, label, mood label, level
TENSES = [
    ("present", "indicatif", "présent", "Présent", "Indicatif", "core"),
    ("passe-compose", "indicatif", "passé-composé", "Passé composé", "Indicatif", "core"),
    ("imparfait", "indicatif", "imparfait", "Imparfait", "Indicatif", "core"),
    ("futur-simple", "indicatif", "futur-simple", "Futur simple", "Indicatif", "core"),
    ("futur-proche", None, None, "Futur proche", "Indicatif", "core"),
    ("passe-recent", None, None, "Passé récent", "Indicatif", "advanced"),
    ("plus-que-parfait", "indicatif", "plus-que-parfait", "Plus-que-parfait", "Indicatif", "advanced"),
    ("futur-anterieur", "indicatif", "futur-antérieur", "Futur antérieur", "Indicatif", "advanced"),
    ("passe-simple", "indicatif", "passé-simple", "Passé simple", "Indicatif", "literary"),
    ("passe-anterieur", "indicatif", "passé-antérieur", "Passé antérieur", "Indicatif", "literary"),
    ("conditionnel-present", "conditionnel", "présent", "Conditionnel présent", "Conditionnel", "advanced"),
    ("conditionnel-passe", "conditionnel", "passé", "Conditionnel passé", "Conditionnel", "advanced"),
    ("subjonctif-present", "subjonctif", "présent", "Subjonctif présent", "Subjonctif", "advanced"),
    ("subjonctif-passe", "subjonctif", "passé", "Subjonctif passé", "Subjonctif", "advanced"),
    ("subjonctif-imparfait", "subjonctif", "imparfait", "Subjonctif imparfait", "Subjonctif", "literary"),
    ("subjonctif-plus-que-parfait", "subjonctif", "plus-que-parfait", "Subjonctif plus-que-parfait", "Subjonctif", "literary"),
    ("imperatif-present", "imperatif", "imperatif-présent", "Impératif présent", "Impératif", "core"),
    ("imperatif-passe", "imperatif", "imperatif-passé", "Impératif passé", "Impératif", "advanced"),
]

HINTS = {
    "present": "What happens now or usually.",
    "passe-compose": "Finished past actions. avoir/être in présent + past participle. With être the participle agrees with the subject.",
    "imparfait": "Past descriptions, habits and ongoing actions. nous-stem of the présent + -ais, -ais, -ait, -ions, -iez, -aient.",
    "futur-simple": "Future. Infinitive + -ai, -as, -a, -ons, -ez, -ont. Some verbs have irregular stems (ir-, ser-, aur-, fer-).",
    "futur-proche": "Near future. aller in présent + infinitive.",
    "passe-recent": "Something that just happened. venir de in présent + infinitive.",
    "plus-que-parfait": "A past action before another past action. avoir/être in imparfait + past participle.",
    "futur-anterieur": "Will have done. avoir/être in futur simple + past participle.",
    "passe-simple": "Literary past used in books and stories. Mostly learn to recognize it.",
    "passe-anterieur": "Literary. A past before the passé simple. avoir/être in passé simple + past participle.",
    "conditionnel-present": "Would do. Futur simple stem + imparfait endings.",
    "conditionnel-passe": "Would have done. avoir/être in conditionnel présent + past participle.",
    "subjonctif-present": "After que with wishes, feelings, doubt and necessity. ils-stem of the présent + -e, -es, -e, -ions, -iez, -ent.",
    "subjonctif-passe": "Past subjunctive. avoir/être in subjonctif présent + past participle.",
    "subjonctif-imparfait": "Literary. Appears in old or formal texts.",
    "subjonctif-plus-que-parfait": "Literary. Appears in old or formal texts.",
    "imperatif-present": "Commands, only tu, nous and vous, without the pronoun. -er verbs drop the -s for tu.",
    "imperatif-passe": "Rare. A command to have something done by a certain time.",
}

IMPERSONAL = {"pleuvoir", "neiger", "falloir"}
# verbecc's template for these is broken in the simple tenses; borrow a verb with the same pattern.
PATTERN_DONOR = {"neiger": ("manger", "mang", "neig")}
VOWEL = re.compile(r"^[aeiouyhâàäéèêëîïôöûùüœ]", re.I)
SUBJECT = re.compile(r"^(?:que |qu')?(?:je |j'|tu |il |elle |on |nous |vous |ils |elles )")


def strip_subject(form):
    return SUBJECT.sub("", form, count=1).strip()


def cells(rows, impersonal):
    persons = [[] for _ in PERSONS]
    rows = sorted(rows, key=lambda r: r.get("g") == "f")
    for row in rows:
        index = PRONOUN_INDEX.get(row.get("pr", ""))
        if index is None or (impersonal and index != 2):
            continue
        for form in row["c"]:
            bare = strip_subject(form)
            if bare and bare != "-" and bare not in persons[index]:
                persons[index].append(bare)
    return [p or None for p in persons]


def reflexive_parts(infinitive):
    for prefix in ("se ", "s'"):
        if infinitive.startswith(prefix):
            return infinitive[len(prefix):]
    return None


def periphrastic(helper_forms, infinitive, joiner, impersonal):
    base = reflexive_parts(infinitive)
    out = []
    for i, helper in enumerate(helper_forms):
        if impersonal and i != 2:
            out.append(None)
            continue
        if base:
            pronoun = ["me", "te", "se", "nous", "vous", "se"][i]
            verb = (pronoun[0] + "'" + base) if VOWEL.match(base) and pronoun in ("me", "te", "se") else f"{pronoun} {base}"
        else:
            verb = infinitive
        if joiner == "de":
            link = "d'" if VOWEL.match(verb) else "de "
            out.append([f"{helper} {link}{verb}"])
        else:
            out.append([f"{helper} {verb}"])
    return out


def verb_infinitives():
    index = json.loads((ROOT / "words.json").read_text(encoding="utf-8"))
    verbs = {}
    for path in index["decks"]:
        deck = json.loads((ROOT / path).read_text(encoding="utf-8"))
        if deck.get("lang") != "fr" or deck.get("type") != "verbs":
            continue
        for word in deck["words"]:
            answer = word["a"][0] if isinstance(word["a"], list) else word["a"]
            verbs.setdefault(answer.strip(), path)
    return verbs


def main():
    logging.disable(logging.WARNING)
    cg = CompleteConjugator(lang=LangCodeISO639_1.fr)
    conjugate = lambda inf: json.loads(json.dumps(cg.conjugate(inf).get_data(), default=str))
    aller = cells(conjugate("aller")["moods"]["indicatif"]["présent"], False)
    venir = cells(conjugate("venir")["moods"]["indicatif"]["présent"], False)

    result = {}
    problems = []
    for infinitive in verb_infinitives():
        data = conjugate(infinitive)
        if data["verb"].get("predicted"):
            problems.append(f"{infinitive}: not in the dictionary, check the spelling (skipped)")
            continue
        impersonal = infinitive in IMPERSONAL
        donor = PATTERN_DONOR.get(infinitive)
        donor_data = conjugate(donor[0]) if donor else None
        moods = data["moods"]
        tenses = {}
        for key, mood, tense, *_ in TENSES:
            if key == "futur-proche":
                tenses[key] = periphrastic([f[0] for f in aller], infinitive, "", impersonal)
                continue
            if key == "passe-recent":
                tenses[key] = periphrastic([f[0] for f in venir], infinitive, "de", impersonal)
                continue
            table = cells(moods.get(mood, {}).get(tense, []), impersonal)
            if donor and not any(table):
                donor_table = cells(donor_data["moods"][mood][tense], impersonal)
                table = [[f.replace(donor[1], donor[2], 1) for f in c] if c else None for c in donor_table]
                if any(table):
                    problems.append(f"{infinitive} {key}: filled from {donor[0]}")
            if any(table):
                tenses[key] = table
        compound = tenses["passe-compose"][2][0]
        participle = re.sub(r"^étant ", "", moods["participe"]["participe-passé"][0]["c"][0])
        present_participle = moods["participe"]["participe-présent"][0]["c"][0]
        if reflexive_parts(infinitive) and not present_participle.startswith(("se ", "s'")):
            present_participle = ("s'" if VOWEL.match(present_participle) else "se ") + present_participle
        result[infinitive] = {
            "aux": "être" if re.match(r"^(?:[mts]'|me |te |se |nous |vous )?(?:suis|es|est|sommes|êtes|sont) ", compound) else "avoir",
            "pp": participle,
            "ppr": present_participle,
            "impersonal": impersonal,
            "t": tenses,
        }

    out = {
        "lang": "fr",
        "source": "verbecc (Verbiste data)",
        "persons": PERSONS,
        "tenses": [{"key": k, "label": label, "mood": mood_label, "level": level, "hint": HINTS[k]}
                   for k, _, _, label, mood_label, level in TENSES],
        "verbs": result,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(result)} verbs x {len(TENSES)} tenses to {OUT.relative_to(ROOT)}")
    for p in problems:
        print("  note:", p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
