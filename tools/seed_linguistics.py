"""
seed_linguistics.py — Ingest grammar/linguistics knowledge into KAI's RSHL lattice.

Posts a rich set of definitions, examples, and rules for every major
part of speech (and more) so that KAI has real retrieval content when
asked about grammar/language topics.
"""
import urllib.request
import json
import time

BASE = "http://127.0.0.1:3334"

ENTRIES = [
    # ── Nouns ──────────────────────────────────────────────────────────────
    {"text": "A noun is a word that names a person, place, thing, or idea.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Common nouns name general things: dog, city, book, happiness.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Proper nouns name specific people, places, or organizations and are capitalized: London, Ryan, NASA.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Abstract nouns name ideas or feelings that cannot be touched: freedom, justice, love, anger.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Concrete nouns name things you can perceive with your senses: rain, fire, bread, music.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Collective nouns name groups: flock, team, army, committee.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Count nouns can be made plural: one apple, two apples.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Mass nouns (uncountable) cannot be easily counted: water, sand, information.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "In a sentence, a noun can serve as the subject, object, or complement.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Nouns are one of the eight traditional parts of speech in English grammar.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Verbs ──────────────────────────────────────────────────────────────
    {"text": "A verb is a word that expresses an action, occurrence, or state of being.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Action verbs describe physical or mental actions: run, think, build, imagine.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Linking verbs connect the subject to a description: is, are, was, seem, become, feel.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Auxiliary verbs (helping verbs) assist the main verb: can, will, have, should, must, might.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Transitive verbs take a direct object: She kicked the ball.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Intransitive verbs do not take a direct object: He smiled. The sun rose.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Verb tense indicates when an action happens: past, present, or future.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Irregular verbs don't follow standard conjugation: go/went, be/was, have/had.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "A phrasal verb is a verb combined with a preposition or adverb: give up, look into, run out.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Subject-verb agreement means the verb must match the subject in number: He runs. They run.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Adjectives ─────────────────────────────────────────────────────────
    {"text": "An adjective is a word that modifies or describes a noun or pronoun.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Adjectives answer the questions: which one? what kind? how many?", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Descriptive adjectives describe qualities: tall, green, angry, beautiful.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Quantitative adjectives tell how many: three cats, several problems, few options.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Comparative adjectives compare two things: bigger, smarter, more interesting.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Superlative adjectives rank one above all others: biggest, smartest, most interesting.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Demonstrative adjectives point out specific nouns: this book, those trees.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Possessive adjectives show ownership: my car, her idea, their house.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Adjectives usually appear before the noun they modify: a red apple.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Adverbs ────────────────────────────────────────────────────────────
    {"text": "An adverb is a word that modifies a verb, adjective, or another adverb.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Adverbs of manner describe how an action is done: quickly, softly, carefully.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Adverbs of time tell when: yesterday, now, soon, already, never.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Adverbs of place tell where: here, there, everywhere, outside.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Adverbs of frequency tell how often: always, often, rarely, sometimes.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Adverbs of degree tell to what extent: very, quite, almost, extremely, barely.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Many adverbs are formed by adding -ly to an adjective: slow → slowly, happy → happily.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Pronouns ───────────────────────────────────────────────────────────
    {"text": "A pronoun is a word that replaces a noun to avoid repetition.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Personal pronouns refer to people or things: I, you, he, she, it, we, they.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Possessive pronouns show ownership: mine, yours, his, hers, ours, theirs.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Reflexive pronouns refer back to the subject: myself, yourself, himself, themselves.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Relative pronouns introduce relative clauses: who, whom, which, that, whose.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Interrogative pronouns ask questions: who, what, which, whose.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Indefinite pronouns refer to nonspecific people or things: someone, anything, nobody, all.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Demonstrative pronouns point to things: this, that, these, those.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Prepositions ───────────────────────────────────────────────────────
    {"text": "A preposition is a word that shows the relationship between a noun and other words.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Common prepositions: in, on, at, by, for, with, about, between, through, under, over.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Prepositions of time: at noon, on Monday, in January, during the meeting.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Prepositions of place: in the box, on the table, at the door, under the bridge.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "A prepositional phrase includes the preposition plus its object: in the morning, with a smile.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Conjunctions ───────────────────────────────────────────────────────
    {"text": "A conjunction is a word that connects words, phrases, or clauses.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Coordinating conjunctions join equal elements: for, and, nor, but, or, yet, so (FANBOYS).", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Subordinating conjunctions introduce dependent clauses: because, although, if, when, since, while.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Correlative conjunctions come in pairs: either/or, neither/nor, both/and, not only/but also.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Interjections ─────────────────────────────────────────────────────
    {"text": "An interjection is a word or phrase that expresses strong emotion: Oh! Wow! Ouch! Hey!", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Interjections are grammatically independent — they don't connect to the rest of the sentence.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Articles ───────────────────────────────────────────────────────────
    {"text": "Articles are a type of determiner. English has three: a, an, and the.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "The definite article 'the' refers to a specific noun: the car, the idea.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "The indefinite articles 'a' and 'an' refer to any one of a class: a dog, an idea.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Use 'an' before words that start with a vowel sound: an apple, an hour.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Sentence Structure ─────────────────────────────────────────────────
    {"text": "A sentence must have a subject and a predicate to be complete.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "The subject of a sentence is who or what the sentence is about.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "The predicate contains the verb and says something about the subject.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "A clause is a group of words with a subject and verb. Independent clauses can stand alone.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "A dependent clause cannot stand alone and needs an independent clause: 'because it rained'.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "A phrase is a group of words without a complete subject-verb pair: 'in the morning'.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "A simple sentence has one independent clause: The cat sat on the mat.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "A compound sentence has two or more independent clauses joined by a conjunction.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "A complex sentence has an independent clause and at least one dependent clause.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Tense & Aspect ─────────────────────────────────────────────────────
    {"text": "Simple present tense describes habitual actions or facts: She walks to work. Water boils at 100°C.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Simple past tense describes completed actions: He finished his homework.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Simple future tense describes upcoming actions: They will arrive tomorrow.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Present progressive (continuous) describes ongoing actions: I am writing right now.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Past perfect tense describes an action completed before another past action: She had left before he arrived.", "region": "language", "source": "grammar", "strength": 1.0},

    # ── Punctuation ────────────────────────────────────────────────────────
    {"text": "A period (.) ends a declarative sentence.", "region": "language", "source": "grammar", "strength": 0.9},
    {"text": "A question mark (?) ends an interrogative sentence.", "region": "language", "source": "grammar", "strength": 0.9},
    {"text": "An exclamation mark (!) ends an exclamatory sentence.", "region": "language", "source": "grammar", "strength": 0.9},
    {"text": "A comma (,) separates elements in a list or joins clauses with a conjunction.", "region": "language", "source": "grammar", "strength": 0.9},
    {"text": "A semicolon (;) connects two closely related independent clauses.", "region": "language", "source": "grammar", "strength": 0.9},
    {"text": "A colon (:) introduces a list, explanation, or quotation.", "region": "language", "source": "grammar", "strength": 0.9},
    {"text": "Quotation marks (\"\") enclose direct speech or titles of short works.", "region": "language", "source": "grammar", "strength": 0.9},

    # ── Parts of Speech Overview ────────────────────────────────────────────
    {"text": "The eight traditional parts of speech in English are: noun, verb, adjective, adverb, pronoun, preposition, conjunction, and interjection.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Every word in a sentence belongs to a part of speech that describes its grammatical function.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Grammar is the system of rules that governs the structure of a language.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Syntax is the arrangement of words and phrases to create well-formed sentences.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Morphology studies the structure and formation of words, including prefixes and suffixes.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "A thesaurus lists synonyms and related words. A dictionary lists definitions and word types.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "In English dictionaries, each entry shows the word's part of speech: n. for noun, v. for verb, adj. for adjective.", "region": "language", "source": "grammar", "strength": 1.0},
    {"text": "Etymology is the study of the origin and historical development of words.", "region": "language", "source": "grammar", "strength": 0.9},

    # ── KAI-specific grammar knowledge ─────────────────────────────────────
    {"text": "When someone asks about grammar, I draw on my understanding of English parts of speech.", "region": "language", "source": "kai-self", "strength": 1.0},
    {"text": "I know the difference between nouns, verbs, adjectives, adverbs, pronouns, prepositions, conjunctions, and interjections.", "region": "language", "source": "kai-self", "strength": 1.0},
    {"text": "Grammar describes how words work together in a language to convey meaning.", "region": "language", "source": "kai-self", "strength": 1.0},
]


def bulk_ingest(entries):
    payload = json.dumps({"entries": entries}).encode()
    req = urllib.request.Request(
        f"{BASE}/api/bulk-ingest",
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    resp = urllib.request.urlopen(req, timeout=30)
    return resp.read().decode('utf-8')


# Split into batches of 20
BATCH = 20
total = 0
for i in range(0, len(ENTRIES), BATCH):
    batch = ENTRIES[i:i+BATCH]
    result = bulk_ingest(batch)
    total += len(batch)
    print(f"  [{i+len(batch)}/{len(ENTRIES)}] {result}", flush=True)
    time.sleep(0.1)

print(f"\n✅ Seeded {total} linguistics entries into KAI's RSHL lattice.")
print("Rebuilding index...")

# Trigger index rebuild so the new cells are searchable immediately
req = urllib.request.Request(
    f"{BASE}/api/lattice/rebuild-index",
    data=b"{}",
    headers={"Content-Type": "application/json"}
)
try:
    resp = urllib.request.urlopen(req, timeout=30)
    print("Index rebuild:", resp.read().decode('utf-8'))
except Exception as e:
    print(f"Index rebuild: {e} (may not matter, index rebuilds lazily)")
