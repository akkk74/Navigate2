# Спутник — Android (порт Scriptable-скрипта)

Тот же интерфейс и логика, что в iOS-скрипте: исходный JS (SOAP, парсеры, HTML карты)
выполняется без изменений в скрытой WebView, а слой совместимости (`tools/shims.js`)
подменяет API Scriptable: `Request` → HttpURLConnection, `FileManager` → файлы приложения,
`Location` → GPS Android, `Pasteboard` → буфер обмена.

## Получить APK через GitHub (без установки Android Studio)
1. Создайте репозиторий на GitHub и загрузите в него содержимое этой папки.
2. Вкладка **Actions → Build APK → Run workflow** (или просто push в main).
3. Через 3–5 минут откройте завершённый запуск → **Artifacts → Sputnik-APK**, внутри `app-debug.apk`.
4. Перекиньте APK на телефон и установите (разрешите установку из неизвестных источников).

## Через Android Studio
Откройте папку как проект → Build → Build Bundle(s)/APK(s) → Build APK(s).

## Обновление при изменении исходного скрипта
Положите новый `.scriptable` в `original/` и выполните `python3 tools/build_engine.py`.

## Отличия от iOS
- Кнопка «поделиться скриптом» отключена (не имеет смысла на Android).
- Tailwind/Leaflet при первом запуске подгружаются из интернета и кэшируются.
