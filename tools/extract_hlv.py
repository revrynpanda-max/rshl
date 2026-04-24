import sys
from pdfminer.high_level import extract_text

def extract(pdf_path, out_path):
    print(f"Extracting {pdf_path}...")
    text = extract_text(pdf_path)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(text)
    print(f"Done. Saved to {out_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python extract_hlv.py <pdf_path> <out_path>")
    else:
        extract(sys.argv[1], sys.argv[2])
