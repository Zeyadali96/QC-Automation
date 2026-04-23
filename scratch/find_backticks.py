
with open(r"c:\Users\Zeyad-PC\Downloads\Scripts\server.ts", 'r', encoding='utf-8') as f:
    for i, line in enumerate(f):
        if '`' in line:
            print(f"{i+1}: {line.strip()}")
