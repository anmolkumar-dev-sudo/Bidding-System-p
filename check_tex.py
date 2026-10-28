import re, collections, sys

s = open('resume.tex', encoding='utf-8').read()

# strip comments (respecting escaped \%)
lines = []
for ln in s.split('\n'):
    out, i = [], 0
    while i < len(ln):
        if ln[i] == '\\' and i + 1 < len(ln):
            out.append(ln[i:i+2]); i += 2; continue
        if ln[i] == '%':
            break
        out.append(ln[i]); i += 1
    lines.append(''.join(out))
body = '\n'.join(lines)

depth = 0
for ch in body:
    if ch == '{': depth += 1
    elif ch == '}': depth -= 1
    if depth < 0:
        print('UNBALANCED: extra }'); sys.exit(1)
print('final brace depth (0 == balanced):', depth)

b = collections.Counter(re.findall(r'\\begin\{([^}]*)\}', body))
e = collections.Counter(re.findall(r'\\end\{([^}]*)\}', body))
bad = {k: (b[k], e[k]) for k in set(b) | set(e) if b[k] != e[k]}
print('env imbalances:', bad if bad else 'none')
print('resumeProject calls:', len(re.findall(r'\\resumeProject\b', body)) - 1)
print('resumeAchievement calls:', len(re.findall(r'\\resumeAchievement\b', body)) - 1)
print('total lines:', len(s.split('\n')))
