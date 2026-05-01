KAI IDLE INGEST FOLDER
======================

Drop plain-text files (.txt) here and KAI will learn from them
passively while idle. One fact per line. He absorbs a few lines
per heartbeat whenever no conversation is quiet enough to leave
background attention free.

This works in the TUI and in headless Oracle mode (`kai --oracle`).
That means the Discord Oracle can stay usable while KAI slowly eats
clean corpus files in the background.

FORMAT
------
Each non-empty line becomes one memory cell. Lines are best written
as complete sentences or claims — that's what the lattice encodes
and retrieves against.

  # This is a comment line — ignored.
  Water is composed of two hydrogen atoms and one oxygen atom.
  The mitochondrion is often called the powerhouse of the cell.

Optional region tagging:

  [science] Photosynthesis converts CO2 and H2O into glucose.
  [history] The Roman Empire fell in 476 CE.
  [programming] Rust's ownership model prevents data races.

Without a [tag], lines are stored in the default 'knowledge' region.

BEHAVIOR
--------
- Lines shorter than 12 characters are skipped.
- Duplicate lines reinforce existing cells instead of creating new ones.
- Files are moved to ../ingested/ once fully absorbed so you can see
  which corpora KAI has consumed.
- You can drop new files at any time; KAI will pick them up on his
  next idle tick.

TIP
---
A 5,000-line corpus will take a few hours of idle time to absorb at
the default rate. Drop files before bed, check his cell count in
the morning.
