import re, sys
doc = open(sys.argv[1]).read()
needle = sys.argv[2]
blocks = [m.group(1) for m in re.finditer(r"```sh\n([\s\S]*?)\n```", doc)]
hits = [b for b in blocks if needle in b]
if not hits:
    sys.exit(f"no fenced sh block containing {needle!r}")
print(min(hits, key=len) if "--shortest" in sys.argv else hits[0])
