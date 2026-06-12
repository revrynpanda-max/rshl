import sys

path = r'C:\KAI\src\bridge\oracle_server.rs'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

target = '''    } else {
        write_simple(stream, 400, "Bad Request", "no pending proposal")
    }
fn handle_oracle_cache'''

repl = '''    } else {
        write_simple(stream, 400, "Bad Request", "no pending proposal")
    }
}

fn handle_oracle_cache'''

if target in content:
    content = content.replace(target, repl)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('TARGET NOT FOUND')
