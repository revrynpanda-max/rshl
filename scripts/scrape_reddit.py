import urllib.request
import urllib.parse
import json
import time
import os

SUBREDDITS = ['CasualConversation', 'AskReddit', 'explainlikeimfive', 'socialskills', 'Advice']
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Antigravity/1.0'}

OUTPUT_FILE = r'C:\KAI\data\training_corpus\reddit_conversations.jsonl'

def fetch_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return None

def extract_conversations():
    pairs = []
    
    for sub in SUBREDDITS:
        print(f"Scraping r/{sub}...")
        url = f"https://www.reddit.com/r/{sub}/top.json?limit=100&t=month"
        data = fetch_json(url)
        if not data or 'data' not in data or 'children' not in data['data']:
            continue
            
        posts = data['data']['children']
        for post in posts:
            post_data = post['data']
            post_id = post_data['id']
            post_title = post_data.get('title', '')
            post_text = post_data.get('selftext', '')
            
            # Combine title and text for input context
            input_text = f"{post_title} {post_text}".strip()
            if not input_text:
                continue
                
            # Fetch comments for this post
            comments_url = f"https://www.reddit.com/r/{sub}/comments/{post_id}.json?limit=50"
            time.sleep(1.5) # Be nice to Reddit's API
            
            comments_data = fetch_json(comments_url)
            if not comments_data or len(comments_data) < 2:
                continue
                
            comments = comments_data[1]['data']['children']
            for comment in comments:
                if 'data' not in comment or 'body' not in comment['data']:
                    continue
                
                reply_text = comment['data']['body'].strip()
                if not reply_text or reply_text == '[deleted]' or reply_text == '[removed]':
                    continue
                    
                # Clean up formatting roughly
                reply_text = reply_text.replace('\n', ' ').replace('\r', '')
                input_clean = input_text.replace('\n', ' ').replace('\r', '')
                
                if len(input_clean) > 10 and len(reply_text) > 10:
                    pairs.append({'input': input_clean, 'reply': reply_text})
                    
                # Also do comment-to-comment pairs if replies exist
                if 'replies' in comment['data'] and isinstance(comment['data']['replies'], dict):
                    sub_replies = comment['data']['replies']['data']['children']
                    for sub_reply in sub_replies:
                        if 'data' not in sub_reply or 'body' not in sub_reply['data']:
                            continue
                        sub_reply_text = sub_reply['data']['body'].strip()
                        if not sub_reply_text or sub_reply_text == '[deleted]' or sub_reply_text == '[removed]':
                            continue
                            
                        sub_reply_text = sub_reply_text.replace('\n', ' ').replace('\r', '')
                        if len(reply_text) > 10 and len(sub_reply_text) > 10:
                            pairs.append({'input': reply_text, 'reply': sub_reply_text})
    
    return pairs

def main():
    print("Starting Reddit conversation scraper...")
    pairs = extract_conversations()
    print(f"Extracted {len(pairs)} conversational pairs.")
    
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        for p in pairs:
            f.write(json.dumps(p) + '\n')
            
    print(f"Saved to {OUTPUT_FILE}")

if __name__ == '__main__':
    main()
