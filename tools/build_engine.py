#!/usr/bin/env python3
"""Генерирует app/src/main/assets/engine.js из исходного Scriptable-файла.

Запуск:  python3 tools/build_engine.py [путь/к/файлу.scriptable]
Весь код скрипта (SOAP, парсеры, HTML карты) остаётся без изменений;
добавляется только слой совместимости (Request, FileManager, Location,
Pasteboard, WebView), который обращается к Kotlin-мосту `Android`.
"""
import json, re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else next((root / "original").glob("*.scriptable"))
script = json.loads(src.read_text(encoding="utf-8"))["script"]

# 1) «Поделиться скриптом» в Android не имеет смысла — заглушка.
stub = ('async function performShareApp() {\n'
        '  return { ok: false, error: "Отправка скрипта недоступна в Android-версии" };\n}\n')
script, n = re.subn(r"async function performShareApp\(\) \{.*?\n\}\n", lambda m: stub, script, count=1, flags=re.S)
assert n == 1, "performShareApp не найден"

shims = (root / "tools" / "shims.js").read_text(encoding="utf-8")
out = shims + "\n(async () => {\n" + script + "\n})().catch(e => Android.fatal(String((e && e.stack) || e)));\n"
dst = root / "app/src/main/assets/engine.js"
dst.write_text(out, encoding="utf-8")
print("OK:", dst, len(out), "bytes")
