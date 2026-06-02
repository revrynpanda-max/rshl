import sqlite3
import re
import os

DB_PATH = r"C:\KAI\tools\oracle-discord\transcripts.db"
OUTPUT_PATH = r"C:\KAI\tools\discord_corpus.txt"

def clean_message(text):
    # Remove URLs
    text = re.sub(r'http\S+', '', text)
    # Remove mentions
    text = re.sub(r'<@\!?\d+>', '', text)
    # Remove custom emojis
    text = re.sub(r'<a?:\w+:\d+>', '', text)
    return text.strip()

def main():
    if not os.path.exists(DB_PATH):
        print(f"Error: {DB_PATH} not found.")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT c2 FROM transcript_fts_content WHERE c0 != 'test'")
    rows = cursor.fetchall()

    valid_lines = 0
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        for row in rows:
            msg = row[0]
            if msg:
                cleaned = clean_message(msg)
                # Only keep messages with enough substance
                if len(cleaned) > 10 and not cleaned.startswith("http") and not cleaned.startswith("```"):
                    f.write(cleaned + "\n")
                    valid_lines += 1

    print(f"Extracted {valid_lines} valid dialogue lines to {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
