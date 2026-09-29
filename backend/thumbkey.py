"""Stable thumbnail filenames: hash(file identity), not scan order.

Survives trip renames and reordering. Old `{trip}_mNNNN.jpg` files are
migrated by (file, size) match in server.py, then pruned.
"""
import hashlib


def stable_thumb(filename, size=None, mtime=None):
    h = hashlib.sha1(f"{filename}|{size}|{mtime}".encode("utf-8")).hexdigest()[:16]
    return f"t{h}.jpg"
