import re

with open("C:\\KAI\\temp_modelfile.txt", "r", encoding="utf-16le") as f:
    content = f.read()

# Replace the ACTUAL FROM line
content = re.sub(r'\nFROM .*', '\nFROM llama3.1:8b', content, count=1)

# Ensure context is reduced
if 'PARAMETER num_ctx' in content:
    content = re.sub(r'PARAMETER num_ctx .*', 'PARAMETER num_ctx 8192', content)
else:
    # insert before SYSTEM or somewhere
    content = content.replace('SYSTEM """', 'PARAMETER num_ctx 8192\nSYSTEM """')

# Strip deprecated parameters that break llama 3
content = re.sub(r'PARAMETER rope_frequency_base .*\n', '', content)

# Save to new file (utf-8)
with open("C:\\KAI\\KaiCoderModelfile", "w", encoding="utf-8") as f:
    f.write(content)

print("Modelfile created.")
