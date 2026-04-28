"""
repair_main.py — Restores the truncated tail of src/main.rs.

main.rs is truncated at line 10203, ending mid-function inside run_fid_audit.
main_fixed.rs contains the complete version.

Strategy:
  1. Keep main.rs lines 1-10202 (everything before the incomplete serde_json!({ call)
  2. Append main_fixed.rs from line 10124 onwards (the matching continuation point)

Run with: python repair_main.py
"""
import sys

MAIN = "src/main.rs"
FIXED = "src/main_fixed.rs"

with open(MAIN, "r", encoding="utf-8") as f:
    main_lines = f.readlines()

with open(FIXED, "r", encoding="utf-8") as f:
    fixed_lines = f.readlines()

print("main.rs total lines  :", len(main_lines))
print("main_fixed.rs lines  :", len(fixed_lines))

# The truncation: main.rs line 10203 (index 10202) is the incomplete json!({
# We keep lines 0..10201 (indexes 0-10201, i.e. lines 1-10202)
# main_fixed.rs continuation starts at line 10124 (index 10123)
KEEP_UNTIL = 10202       # keep lines[0:10202] == lines 1-10202
FIXED_FROM  = 10123      # fixed_lines[10123:] == lines 10124 onwards

kept    = main_lines[:KEEP_UNTIL]
tail    = fixed_lines[FIXED_FROM:]

# Sanity check: the last kept line and the first tail line should both be the same
# content pattern (the opening of the json! macro that was interrupted)
print("Last kept line       :", repr(kept[-1].rstrip()))
print("First tail line      :", repr(tail[0].rstrip()))

# Verify the tail starts at the right point
expected_tail_start = "            serde_json::json!({"
if tail[0].rstrip() != expected_tail_start:
    print()
    print("WARNING: tail start does not match expected.")
    print("Expected :", repr(expected_tail_start))
    print("Got      :", repr(tail[0].rstrip()))
    print("Proceeding anyway — please verify manually.")

repaired = kept + tail

with open(MAIN, "w", encoding="utf-8") as f:
    f.writelines(repaired)

print()
print("Repaired main.rs written.")
print("Total lines now:", len(repaired))
print("run_fid_audit continuation: lines", FIXED_FROM + 1, "to end from main_fixed.rs")
print("synthesize_to_speech + run_train_truths restored from main_fixed.rs")
print()
print("Next step: python strip_nulls.py && cargo check --bin kai")
