#!/usr/bin/env python3
"""Extract every ```sql block whose first line starts with '-- migration:' from docs/data-model.md, in order.

usage: extract_migrations.py <data-model.md> <outdir> [--fixed]
  --fixed  apply the minimal fixes of fixes.py (the patch description proposed for docs/data-model.md)
Writes <outdir>/NNNN_name.sql and prints the file list.
"""
import os, re, sys

src, outdir = sys.argv[1], sys.argv[2]
fixed = '--fixed' in sys.argv
text = open(src, encoding='utf-8').read()
blocks = re.findall(r'```sql\n(.*?)```', text, flags=re.S)
os.makedirs(outdir, exist_ok=True)
for f in os.listdir(outdir):
    os.remove(os.path.join(outdir, f))
fixes = {}
if fixed:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from fixes import FIXES as fixes
names = []
for b in blocks:
    first = b.split('\n', 1)[0]
    m = re.match(r'-- migration: (\S+)', first)
    if not m:
        continue
    name = m.group(1)
    for old, new in fixes.get(name, []):
        if b.count(old) != 1:
            sys.exit(f'fix for {name} does not match exactly once: {old[:60]!r}')
        b = b.replace(old, new)
    path = os.path.join(outdir, name + '.sql')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(b)
    names.append(name)
print('\n'.join(names))
