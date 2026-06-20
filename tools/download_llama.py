import urllib.request
url = "https://raw.githubusercontent.com/huggingface/candle/main/candle-transformers/src/models/llama.rs"
response = urllib.request.urlopen(url)
data = response.read()
with open("src/cognition/bitnet_llama.rs", "wb") as f:
    f.write(data)
print("Downloaded bitnet_llama.rs")
