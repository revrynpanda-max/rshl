import os
import glob

src_dir = "src"
files = glob.glob(src_dir + "/**/*.rs", recursive=True)

total = 0
for path in sorted(files):
    with open(path, "rb") as f:
        raw = f.read()
    count = raw.count(b'\x00')
    if count > 0:
        with open(path, "wb") as f:
            f.write(raw.replace(b'\x00', b''))
        print("stripped " + str(count) + " null bytes from " + path)
        total += count
    else:
        print("  clean: " + path)

print("")
if total > 0:
    print("Done. Total removed: " + str(total))
    print("Now run: cargo check")
else:
    print("All files already clean.")
