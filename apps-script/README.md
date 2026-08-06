# Google Apps Script для автоматизації обкладинок

Файли в цій папці є версією коду, який потрібно додати до прив’язаного
Apps Script-проєкту Google-таблиці.

## Важливо

- Не вставляйте GitHub token у `Code.gs`, таблицю, README або git commit.
- Не замінюйте наявний код фільтра «Ревізії».
- Додайте `Code.gs` як окремий файл або об’єднайте функції без видалення
  наявних `onOpen`/`onEdit`.
- `onEditCoverAutomation` має бути installable trigger, а не простим `onEdit`.
- Тригери встановлює один визначений адміністратор таблиці.

## Script Properties

У **Project Settings → Script Properties** створіть:

| Property | Value |
| --- | --- |
| `GITHUB_TOKEN` | fine-grained token лише для `library-covers` |
| `GITHUB_OWNER` | `nazarijshvetz1` |
| `GITHUB_REPO` | `library-covers` |

Для `repository_dispatch` токену потрібен доступ **Contents: Read and write**
лише до цього репозиторію. Встановіть дату завершення дії токена.

## Перший запуск

1. Спочатку переконайтеся, що `.github/workflows/import-cover.yml` уже
   знаходиться в гілці `main`.
2. Додайте код до прив’язаного Apps Script-проєкту.
3. Додайте Script Properties.
4. Запустіть `setupCoverAutomation()` вручну.
5. Підтвердьте запитані Google дозволи.
6. Перевірте, що створено один edit trigger і один clock trigger.

Повторний запуск `setupCoverAutomation()` безпечний: наявні заголовки,
формули й тригери не дублюються.

## Видалення тригерів

Запустіть:

```javascript
removeCoverAutomationTriggers();
```

Функція видаляє лише тригери цієї автоматизації, створені поточним
користувачем.
