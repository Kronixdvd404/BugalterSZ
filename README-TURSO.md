# BugalterSZ на Cloudflare Pages + база Turso

Сайт остаётся на Cloudflare Pages, а база переезжает с Cloudflare D1 на Turso (это та же SQLite, лимиты у неё свои). Код сайта не меняется: если заданы переменные `TURSO_DATABASE_URL` и `TURSO_AUTH_TOKEN`, используется Turso, иначе по-прежнему D1.

## 1. Создать базу в Turso

1. Зайди на https://turso.tech и зарегистрируйся (проще всего через GitHub).
2. Создай базу: Create Database, имя `bugalter-sz`, регион выбери ближайший к Европе (Frankfurt или Ireland, если есть).
3. Открой базу и скопируй **URL** вида `libsql://bugalter-sz-логин.turso.io`.
4. Создай токен (Generate Token, доступ Read & Write, срок «без ограничения») и скопируй его. Токен это пароль к базе, никому его не показывай и не коммить в git.

## 2. Создать таблицы

В PowerShell в папке `C:\BugalterSZ`:

```
npm install
$env:TURSO_DATABASE_URL="libsql://bugalter-sz-логин.turso.io"
$env:TURSO_AUTH_TOKEN="ВСТАВЬ_ТОКЕН"
npm run db:turso
```

В конце должно появиться «Готово. Таблицы: auth_hits, baselines, deals, feed, ledger, meta, notes, scan_state, sessions, users».

## 3. Отключить D1 и запушить

В `wrangler.toml` закомментируй (поставь `#` в начале каждой строки) блок:

```
# [[d1_databases]]
# binding = "DB"
# database_name = "bugalter-sz"
# database_id = "..."
```

Затем:

```
git add -A
git commit -m "База Turso вместо D1"
git push
```

## 4. Переменные в Cloudflare

В панели Cloudflare: Workers & Pages → твой проект → Settings → Variables and Secrets. Добавь:

| Имя | Тип |
|---|---|
| `TURSO_DATABASE_URL` | Text |
| `TURSO_AUTH_TOKEN` | **Secret** |
| `EXBO_CLIENT_ID`, `EXBO_CLIENT_SECRET` | Secret (если ещё не добавлены) |

Потом Deployments → Retry deployment.

## 5. Проверка

Открой сайт, зарегистрируйся и оставь вкладку открытой на несколько минут. В панели Turso во вкладке Usage должны появиться прочитанные и записанные строки. Если сайт пишет ошибку, смотри логи в Cloudflare (Functions → Real-time logs) и пришли текст ошибки.

## Что стоит знать

- **Чтение и запись данных.** Старые данные из D1 не переносятся автоматически: аккаунты нужно создать заново (ленту и сканер сайт заполнит сам). Если данных много, скажи, подготовлю перенос.
- **Скорость.** База теперь в другом месте, а не рядом с кодом, поэтому каждый запрос занимает немного больше времени. Выбор ближайшего региона и кэш из патча это компенсируют.
- **Лимиты считаются за месяц, а не за сутки,** и расход всё равно растёт с числом открытых вкладок. Следи за Usage в панели Turso.
