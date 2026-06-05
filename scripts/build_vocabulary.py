import os
import nltk
from nltk.corpus import wordnet as wn
import gensim.downloader as api
import time

def setup():
    print("Downloading NLTK WordNet...")
    nltk.download('wordnet', quiet=True)
    nltk.download('omw-1.4', quiet=True)
    
    print("Loading Gensim GloVe model (this may take a minute if downloading for the first time)...")
    # glove-twitter-25 is relatively small (~104 MB) and fast to load
    model = api.load("glove-twitter-25") 
    return model

# A list of highly common concepts for KAI to understand the world
CORE_VOCABULARY = [
    "human", "computer", "brain", "network", "system", "data", "information",
    "math", "science", "physics", "geometry", "time", "space", "energy", "matter",
    "thought", "emotion", "memory", "learning", "language", "word", "concept",
    "logic", "truth", "knowledge", "idea", "mind", "consciousness", "reality",
    "universe", "planet", "earth", "nature", "animal", "plant", "water", "light",
    "sun", "moon", "star", "friend", "family", "society", "culture", "art",
    "music", "story", "book", "code", "software", "hardware", "machine", "robot",
    "ai", "intelligence", "algorithm", "model", "pattern", "structure", "form"
]

def generate_training_data(model, words, output_path):
    print(f"\nGenerating training data for {len(words)} core concepts...")
    
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("# KAI Foundational Vocabulary Intake\n\n")
        
        for word in words:
            # 1. Get Definition
            synsets = wn.synsets(word)
            if not synsets:
                continue
            
            # Use the most common definition
            definition = synsets[0].definition()
            
            # 2. Get Associated Words
            try:
                # Top 5 similar words, filtered for alphabetic strings to avoid punctuation
                raw_related = model.most_similar(word, topn=10)
                related = [item[0] for item in raw_related if item[0].isalpha() and item[0] != word][:5]
            except KeyError:
                related = []
            
            # 3. Format naturally for KAI's memory lattice
            sentence = f"The concept of '{word}' means: {definition}. "
            if related:
                sentence += f"It is deeply connected to ideas like {', '.join(related)}."
            
            f.write(sentence + "\n")
            print(f"Processed: {word}")
            
    print(f"\nDone! Saved {len(words)} facts to {output_path}")
    print("KAI's background worker will automatically ingest this file.")

if __name__ == "__main__":
    start_time = time.time()
    try:
        model = setup()
        output_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ingest", "foundational_vocabulary.txt")
        generate_training_data(model, CORE_VOCABULARY, output_file)
        print(f"Completed in {time.time() - start_time:.2f} seconds.")
    except Exception as e:
        print(f"Error during execution: {e}")
