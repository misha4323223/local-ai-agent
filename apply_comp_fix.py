#!/usr/bin/env python3
import io, sys

P = "src/main.js"
src = io.open(P, encoding="utf-8").read()

old = """  } else {
    const pathDirs = (process.env.PATH || "").split(path.delimiter);
    for (const d of pathDirs) {
      try {
        for (const e of fs.readdirSync(d)) {
          if (e.toLowerCase().startsWith(token.toLowerCase())) matches.push(e);
        }
      } catch {}
    }
  }
  return { matches: [...new Set(matches)].sort().slice(0, 30), base, tokenLen: token.length };"""

new = """  } else {
    const pathDirs = (process.env.PATH || "").split(path.delimiter);
    for (const d of pathDirs) {
      try {
        for (const e of fs.readdirSync(d)) {
          if (e.toLowerCase().startsWith(token.toLowerCase())) matches.push(e);
        }
      } catch {}
    }
    // Команд с таким префиксом нет — дополняем файлами рабочей папки (как в bash)
    if (!matches.length) listDir(cwd, token, "");
  }
  return { matches: [...new Set(matches)].sort().slice(0, 30), base, tokenLen: token.length };"""

n = src.count(old)
if n != 1:
    sys.exit(f"FAIL: найдено {n}")
src = src.replace(old, new, 1)
io.open(P, "w", encoding="utf-8", newline="\n").write(src)
print("OK — bare-токен дополняется файлами cwd")