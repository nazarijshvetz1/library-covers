# Library covers

Сховище обкладинок бібліотечних матеріалів для Google-таблиці
«Єдина службова база початкової школи».

## Формат файлів

- папка: `covers/`;
- назва: `CAT-XXXX.jpg`;
- формат: справжній JPEG;
- максимальний розмір після обробки: 600 × 900;
- JPEG quality: 82, progressive та optimized.

Постійний URL має вигляд:

```text
https://raw.githubusercontent.com/nazarijshvetz1/library-covers/main/covers/CAT-0112.jpg
```

## Автоматичне додавання обкладинки

1. У блоці додавання книги на аркуші «Матеріали» користувач вставляє URL у
   «Джерело обкладинки».
2. Google Apps Script напряму завантажує сторінку або зображення й шукає
   `og:image`, `twitter:image`, `image_src` чи JSON-LD.
3. Прямий режим не залежить від GitHub Actions і послідовно використовує
   GitHub Contents API.
4. Користувач перевіряє preview і встановлює checkbox.
5. Після появи `CAT-ID` Apps Script конвертує BMP/GIF/JPEG/PNG у JPEG і
   створює `covers/<CAT-ID>.jpg`.
6. Apps Script одразу записує постійний raw GitHub URL у чинну колонку
   «Обкладинка (URL)».

Старий `repository_dispatch`/status JSON шлях збережено як резервний режим
`COVER_PROCESSING_MODE=actions`. Прямий режим не встановлює точні 600×900
і quality 82; `optimize-covers.yml` залишається окремим додатковим проходом.

Старі workflow `unpack-covers.yml`, `import-base64-cover.yml` та
`optimize-covers.yml` залишаються незалежними й не змінюються.

## Розробка і тести

```bash
python -m pip install -r scripts/requirements.txt
python -m pytest -q
node tests/test_apps_script_logic.mjs
```

Локальна перевірка без запису в `covers/`:

```bash
python scripts/import_cover.py \
  --cat-id CAT-0114 \
  --source-url https://example.com/cover.jpg \
  --request-id 11111111-1111-4111-8111-111111111111 \
  --mode commit \
  --dry-run true
```

Докладне налаштування українською:
[docs/COVER_AUTOMATION_SETUP_UK.md](docs/COVER_AUTOMATION_SETUP_UK.md).

