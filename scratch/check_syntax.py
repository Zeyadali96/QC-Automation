
import sys

def check_braces(filename):
    with open(filename, 'r', encoding='utf-8') as f:
        content = f.read()
    
    stack = []
    line_no = 1
    col_no = 0
    in_string = False
    string_char = ''
    i = 0
    while i < len(content):
        char = content[i]
        col_no += 1
        
        if char == '\n':
            line_no += 1
            col_no = 0
            
        if not in_string:
            if char in "'\"`":
                in_string = True
                string_char = char
            elif char == '/':
                if i + 1 < len(content) and content[i+1] == '/':
                    # Skip comment
                    while i < len(content) and content[i] != '\n':
                        i += 1
                    line_no += 1
                    col_no = 0
                    continue
                elif i + 1 < len(content) and content[i+1] == '*':
                    # Skip block comment
                    i += 2
                    while i + 1 < len(content) and not (content[i] == '*' and content[i+1] == '/'):
                        if content[i] == '\n':
                            line_no += 1
                        i += 1
                    i += 1 # skip /
            elif char == '{':
                stack.append(('{', line_no, col_no))
            elif char == '}':
                if not stack:
                    print(f"Unexpected closing brace at line {line_no}, col {col_no}")
                    return False
                top = stack.pop()
                if top[0] != '{':
                    print(f"Mismatch: found }} but expected matching bracket for {top[0]} at line {top[1]}")
                    return False
            elif char == '(':
                stack.append(('(', line_no, col_no))
            elif char == ')':
                if not stack:
                    print(f"Unexpected closing parenthesis at line {line_no}, col {col_no}")
                    return False
                top = stack.pop()
                if top[0] != '(':
                    print(f"Mismatch: found ) but expected matching brace for {top[0]} at line {top[1]}")
                    return False
            elif char == '[':
                stack.append(('[', line_no, col_no))
            elif char == ']':
                if not stack:
                    print(f"Unexpected closing bracket at line {line_no}, col {col_no}")
                    return False
                top = stack.pop()
                if top[0] != '[':
                    print(f"Mismatch: found ] but expected matching bracket for {top[0]} at line {top[1]}")
                    return False
        else:
            if char == string_char:
                if content[i-1] != '\\':
                    in_string = False
        i += 1
    
    if stack:
        for item in stack:
            print(f"Unclosed {item[0]} at line {item[1]}, col {item[2]}")
        return False
    
    print("Braces, brackets and parentheses are balanced.")
    return True

if __name__ == "__main__":
    check_braces(r"c:\Users\Zeyad-PC\Downloads\Scripts\server.ts")
