Word bank for team word-scramble game

Files:
- `words_plain.json`: master list with `level`, `category`, and `unscrambled` fields.
- `generate_scrambled.py`: produces `words.json` by adding a deterministic `scrambled` field.
- `words.json`: generated file (not checked into source by default). Run the script to create it.

To generate `words.json` (requires Python 3):

```bash
python source/word_bank/generate_scrambled.py
```

The script scrambles deterministically (reverse of the word) so results are stable across runs.
