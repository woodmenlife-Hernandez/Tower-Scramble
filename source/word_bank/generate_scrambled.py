#!/usr/bin/env python3
"""Generate a scrambled words.json from words_plain.json.

This script deterministically scrambles by reversing each word; if reversing
equals the original (palindrome), it rotates the word by one character.
"""
import json
import os

HERE = os.path.dirname(__file__)
PLAIN = os.path.join(HERE, "words_plain.json")
OUT = os.path.join(HERE, "words.json")

def scramble(word: str) -> str:
    s = word[::-1]
    if s == word:
        # simple deterministic fallback for palindromes
        return word[1:] + word[0]
    return s

def main():
    with open(PLAIN, "r", encoding="utf-8") as f:
        words = json.load(f)
    for entry in words:
        entry["scrambled"] = scramble(entry["unscrambled"])
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(words, f, indent=2, ensure_ascii=False)
    print(f"Wrote {OUT} with {len(words)} entries")

if __name__ == "__main__":
    main()
