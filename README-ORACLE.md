# BugalterSZ на Oracle Cloud (бесплатный сервер)

Эта версия работает как обычный сервер: сайт, API и база (файл SQLite) на одной машине. Сканер аукциона крутится **в фоне сам**, открытые вкладки больше не нужны. Лимитов на чтение и запись базы нет. Версия для Cloudflare Pages остаётся рабочей, её файлы не тронуты.

Что внутри этой версии:

```
server/index.js     сервер: раздаёт public/, обрабатывает /api/*, запускает фоновый сканер
server/db.js        база: файл SQLite с интерфейсом, как у Cloudflare D1
server/backup.js    резервные копии базы (npm run backup)
deploy/             bugalter.service (автозапуск) и Caddyfile (https)
.env.example        образец настроек (ключи EXBO, регион, порт)
```

Нужно: карта для регистрации в Oracle (деньги не списываются, проверяется карта), Node.js 22 и желательно свой домен или бесплатный адрес на duckdns.org для https.

---

## 1. Аккаунт и виртуальная машина

1. Зарегистрируйся на https://www.oracle.com/cloud/free/ . Выбери домашний регион поближе (например, Frankfurt). Его потом нельзя поменять.
2. В консоли: Compute → Instances → Create instance.
3. Образ: **Ubuntu 24.04** (или 22.04). Форма: на выбор
   - Ampere **VM.Standard.A1.Flex**, 1-2 ядра, 6-12 ГБ памяти (Arm);
   - если пишет «Out of capacity» (свободных мощностей нет), выбери **VM.Standard.E2.1.Micro** (AMD, 1 ГБ). Для нашего сайта этого хватает.
   - Подходящие варианты помечены **Always Free-eligible**. Условия бесплатного уровня Oracle иногда меняет, проверь пометку в консоли.
4. В блоке SSH keys выбери «Generate a key pair for me» и **скачай приватный ключ** (`.key`). Потерянный ключ не восстановить.
5. Нажми Create. Через минуту появится **Public IP address**, запиши его.

## 2. Открыть порты 80 и 443

В Oracle порты закрыты в двух местах, нужно открыть оба.

**а) В консоли:** Networking → Virtual Cloud Networks → твоя сеть → Security Lists → Default Security List → Add Ingress Rules. Добавь два правила: Source CIDR `0.0.0.0/0`, протокол TCP, порты `80` и `443` (по одному правилу на порт).

**б) На самой машине** (после подключения по SSH, шаг 3):

```
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Подключиться по SSH

В Windows (PowerShell), указав путь к скачанному ключу и IP машины:

```
ssh -i C:\Users\ТЫ\Downloads\ssh-key.key ubuntu@ПУБЛИЧНЫЙ_IP
```

Если ругается на права к ключу: правый клик по файлу → Свойства → Безопасность, оставь доступ только себе.

## 4. Установить Node.js 22 и git

```
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git sqlite3
node --version
```

Версия должна быть v22 или выше (нужен встроенный модуль SQLite).

## 5. Скачать проект

Репозиторий приватный, поэтому при клонировании на вопрос «Password» нужно вставить GitHub-токен (Settings → Developer settings → Personal access tokens → Fine-grained, доступ только к этому репозиторию, право Contents: Read-only).

```
cd ~
git clone https://github.com/Kronixdvd404/BugalterSZ.git
cd BugalterSZ
npm run build
```

`npm run build` скачивает каталог предметов в `public/catalog.json`. Устанавливать пакеты через `npm install` не нужно, у сервера нет зависимостей.

## 6. Настройки

```
cp .env.example .env
nano .env
```

Впиши `EXBO_CLIENT_ID` и `EXBO_CLIENT_SECRET`, при желании поменяй `REGIONS` (например, `REGIONS=eu`, если нужен только один регион). Сохранить: Ctrl+O, Enter, выйти: Ctrl+X.

Проверка вручную:

```
npm start
```

Должны появиться строки про порт и «фоновый сканер запущен». Останови командой Ctrl+C и переходи дальше.

## 7. Автозапуск (systemd)

Файл `deploy/bugalter.service` рассчитан на пользователя `ubuntu` и папку `/home/ubuntu/BugalterSZ`.

```
sudo cp deploy/bugalter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bugalter
sudo systemctl status bugalter
journalctl -u bugalter -f
```

Теперь сайт сам стартует после перезагрузки и перезапускается при сбоях.

## 8. HTTPS через Caddy

1. Домен. Бесплатный вариант: зайди на https://www.duckdns.org , создай имя (например, `bugalter.duckdns.org`) и укажи Public IP машины.
2. Установка Caddy:

```
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

3. Открой `deploy/Caddyfile`, замени `ВАШ-ДОМЕН.duckdns.org` на свой адрес и примени:

```
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Через минуту сайт откроется по `https://твой-домен`. Если домена нет, сайт доступен и без Caddy: поставь в `.env` `HOST=0.0.0.0`, `TRUST_PROXY=0`, перезапусти (`sudo systemctl restart bugalter`) и открой порт 3000 так же, как в шаге 2. Но тогда пароли передаются без шифрования, для постоянной работы этот вариант не рекомендуется.

## 9. Обновление сайта

После каждого `git push` из Windows на сервере:

```
cd ~/BugalterSZ
git pull
npm run build
sudo systemctl restart bugalter
```

## 10. Резервные копии

```
npm run backup
```

Копии сохраняются в `data/backups` (последние 14). Автоматически раз в сутки в 04:00: `crontab -e` и добавить строку

```
0 4 * * * cd /home/ubuntu/BugalterSZ && /usr/bin/npm run backup >> /home/ubuntu/backup.log 2>&1
```

Скачать копию к себе: `scp -i ключ ubuntu@IP:BugalterSZ/data/backups/ИМЯ.db .` Только не забывай и про сам сервер: данные хранятся в одном месте.

## 11. Перенос данных с Cloudflare (если нужно)

Пользователей, бухгалтерию и заметки можно перенести, а ленту и сканер заполнит сам. На компьютере, где настроен wrangler:

```
npx wrangler d1 export bugalter-sz --remote --no-schema --table users --table ledger --table notes --output=data.sql
```

Перекинь `data.sql` на сервер через `scp` и выполни:

```
sqlite3 data/bugalter.db < data.sql
```

Имена таблиц смотри в `schema.sql`. Если экспорт не работает из-за превышенного лимита D1, дождись сброса в 00:00 по UTC. Пользователям после переноса придётся войти заново (сессии не переносятся), пароли сохраняются.

---

## Важно знать

- **Простаивающие машины Oracle может отбирать.** По правилам Always Free, если машина много дней почти ничего не делает (малая загрузка процессора), её могут остановить. Постоянный сканер даёт какую-то нагрузку, но гарантий нет. Надёжнее перевести аккаунт на Pay As You Go: пока ты укладываешься в бесплатные лимиты, платить не придётся, а риск отбора пропадает.
- **Сервер теперь на тебе:** обновления системы (`sudo apt update && sudo apt upgrade`), копии базы и защита SSH-ключа.
- **Версия для Cloudflare** по-прежнему работает: папка `functions/` и `wrangler.toml` не менялись. Сканер там по-прежнему запускается открытыми вкладками.
