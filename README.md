# Backend App

Бэкенд на NestJS, TypeORM и PostgreSQL. Сейчас реализована регистрация по email и паролю с необязательным подтверждением почты кодом или ссылкой.

## Требования

- Node.js 24.9 или новее: более старые версии не подойдут для e2e-тестов
- Docker с Docker Compose

## Запуск

```bash
npm install
cp .env.example .env
```

В `.env` замени `CONFIRMATION_HMAC_SECRET` на случайное значение:

```bash
openssl rand -hex 32
```

Затем подними Postgres и Mailpit, создай таблицы и запусти приложение:

```bash
docker compose up -d
npm run migration:run
npm run start:dev
```

При настройках из `.env.example` будут доступны:

| Что | Адрес |
| --- | --- |
| API | http://localhost:3200 |
| Swagger | http://localhost:3200/api/docs |
| Mailpit (входящие письма) | http://localhost:8025 |

## Настройки

Все значения задаются в `.env`, пример лежит в `.env.example`.

| Переменная | Описание |
| --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Подключение к Postgres, их же использует `docker-compose.yml` |
| `DB_HOST` | Хост Postgres |
| `PORT` | Порт приложения |
| `APP_URL` | Адрес приложения, подставляется в ссылку из письма |
| `REGISTRATION_CONFIRM_ENABLED` | `true` — нужно подтверждение, `false` — аккаунт сразу активен |
| `REGISTRATION_CONFIRM_METHOD` | Способ подтверждения: `otp` или `magic_link` |
| `REGISTRATION_RATE_LIMIT`, `REGISTRATION_RATE_TTL_SECONDS` | Не больше `LIMIT` запросов за `TTL` секунд, отдельно для регистрации и повторной отправки |
| `CONFIRMATION_HMAC_SECRET` | Ключ HMAC для кодов и токенов из писем |
| `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` | Отправка почты |

## Регистрация

| Запрос | Тело | Успешный ответ |
| --- | --- | --- |
| `POST /auth/register` | `email`, `password`, необязательный `name` | `201` — аккаунт активен, `202` — ждёт подтверждения |
| `POST /auth/register/confirm` | `attemptId` и `code` либо `token` | `200` — аккаунт активен |
| `POST /auth/register/resend` | `email` | `202` — письмо отправлено заново |
| `GET /auth/register/confirm?token=...` | — | `200` — страница с кнопкой подтверждения |

Открытие ссылки из письма статус не меняет: почтовые сканеры и превью сами открывают ссылки через GET. Аккаунт активирует POST по нажатию кнопки на странице.

Код и ссылка действуют 10 минут. Для кода разрешено 5 вводов, повторно запросить письмо можно раз в 60 секунд.

Ошибки:

| Код | Когда |
| --- | --- |
| `400` | Некорректные данные; неверный или просроченный код или токен; попытка не найдена или уже использована |
| `409` | Email уже зарегистрирован, в том числе ожидает подтверждения |
| `429` | Исчерпаны вводы кода, письмо запрошено раньше 60 секунд, слишком частые запросы |
| `503` | Письмо не отправлено. Аккаунт и попытка сохранены, письмо можно запросить заново через `/resend` |

### Пример с кодом

При `REGISTRATION_CONFIRM_METHOD=otp`:

```bash
curl -i http://localhost:3200/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"Passw0rd"}'
```

Возьми `attemptId` из ответа и код из письма в Mailpit:

```bash
curl -i http://localhost:3200/auth/register/confirm \
  -H 'Content-Type: application/json' \
  -d '{"attemptId":"<attemptId>","code":"<код>"}'
```

### Пример со ссылкой

Поставь `REGISTRATION_CONFIRM_METHOD=magic_link`, перезапусти приложение и зарегистрируй новый email. Затем открой ссылку из письма в Mailpit и нажми кнопку на странице.

## Миграции

Схема базы меняется только миграциями, автоматическая синхронизация выключена.

```bash
npm run migration:run      # применить новые миграции
npm run migration:show     # показать статус миграций
npm run migration:revert   # откатить последнюю миграцию
```

Новую миграцию нужно добавить в массив `migrations` в `src/data-source.ts`, иначе CLI её не увидит.

## Тесты

```bash
npm test            # unit-тесты, база не нужна
npm run test:e2e    # e2e-тесты, нужен запущенный Postgres
```

E2E-тесты работают с отдельной базой `backend_app_test` и пересоздают её при каждом запуске, рабочая база не затрагивается. Почта в них заменена фейком, поэтому Mailpit не нужен.
