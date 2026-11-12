# Backend App

Бэкенд на NestJS, TypeORM и PostgreSQL. Сейчас реализованы:

- регистрация по email и паролю с необязательным подтверждением почты кодом или ссылкой;
- аутентификация: вход с необязательным подтверждением по почте, JWT в HttpOnly cookies, обновление пары токенов, выход и проверка access для защищённых маршрутов.

## Требования

- Node.js 24.9 или новее: более старые версии не подойдут для e2e-тестов
- Docker с Docker Compose

## Запуск

```bash
npm install
cp .env.example .env
```

В `.env` заполни пять ключей: `CONFIRMATION_HMAC_SECRET`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `LOGIN_CHALLENGE_HMAC_KEY` и `LOG_EMAIL_HMAC_KEY`. Для каждого выполни отдельно:

```bash
openssl rand -hex 32
```

Ключи должны быть не короче 32 байт и не совпадать между собой. Если хотя бы одна настройка неверна, приложение не запустится и перечислит, что исправить.

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

Все значения задаются в `.env`, пример лежит в `.env.example`. Настройки проверяются при запуске.

| Переменная | Описание |
| --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Подключение к Postgres, их же использует `docker-compose.yml` |
| `DB_HOST` | Хост Postgres |
| `PORT` | Порт приложения, по умолчанию `3000` |
| `APP_URL` | Адрес приложения, подставляется в ссылку из письма |
| `FRONTEND_ORIGIN` | Доверенный frontend, только origin без пути. Пока отдельного frontend нет, совпадает с `APP_URL`. Только ему разрешены CORS-запросы с cookies |
| `AUTH_COOKIE_SAME_SITE` | Необязательно. `strict` по умолчанию, `none` — если frontend на другом site |
| `REGISTRATION_CONFIRM_ENABLED` | `true` — нужно подтверждение, `false` — аккаунт сразу активен |
| `REGISTRATION_CONFIRM_METHOD` | Способ подтверждения: `otp` или `magic_link` |
| `REGISTRATION_RATE_LIMIT`, `REGISTRATION_RATE_TTL_SECONDS` | Не больше `LIMIT` запросов за `TTL` секунд, отдельно для регистрации и повторной отправки |
| `LOGIN_EMAIL_CONFIRMATION_ENABLED` | `true` — вход подтверждается письмом, `false` — без письма. Не зависит от регистрации |
| `LOGIN_EMAIL_CONFIRMATION_METHOD` | Способ подтверждения входа: `otp` или `magic_link` |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Издатель и получатель JWT, проверяются при каждом запросе |
| `CONFIRMATION_HMAC_SECRET` | Ключ HMAC для кодов и токенов из писем регистрации |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Ключи подписи access- и refresh-токенов |
| `LOGIN_CHALLENGE_HMAC_KEY` | Ключ HMAC для кодов и токенов из писем входа |
| `LOG_EMAIL_HMAC_KEY` | Ключ для необратимого идентификатора email в логах |
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

| Статус | `code` | Когда |
| --- | --- | --- |
| `400` | `validation_failed` | Некорректные данные |
| `400` | `invalid_confirmation` | Неверный или просроченный код или токен; попытка не найдена или уже использована |
| `400` | `no_pending_confirmation` | Повторная отправка для email, который не ждёт подтверждения |
| `409` | `email_taken` | Email уже зарегистрирован, в том числе ожидает подтверждения |
| `429` | `attempts_exhausted`, `resend_too_early`, `rate_limited` | Исчерпаны вводы кода, письмо запрошено раньше 60 секунд, слишком частые запросы |
| `503` | `email_delivery_failed` | Письмо не отправлено. Аккаунт и попытка сохранены, письмо можно запросить заново через `/resend` |

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

## Аутентификация

| Запрос | Тело | Успешный ответ |
| --- | --- | --- |
| `POST /auth/login` | `email`, `password` | `204` и cookies, либо `202` — ждёт подтверждения по почте |
| `POST /auth/login/confirm` | `attemptId` и `code` либо `token` | `204` и cookies |
| `POST /auth/login/resend` | `attemptId` | `202` — письмо отправлено заново |
| `GET /auth/login/confirm#token=...` | — | `200` — страница с кнопкой входа |
| `POST /auth/refresh` | — | `204` и новая пара cookies |
| `POST /auth/logout` | — | `204`, cookies очищены. Всегда, даже без сессии |

Войти может только пользователь в статусе `active`.

### Cookies

Токены передаются только в cookies и никогда не возвращаются в теле ответа.

| Cookie | Срок | Путь |
| --- | --- | --- |
| `access_token` | 15 минут | `/` |
| `refresh_token` | 30 дней | `/auth/refresh` |

Обе cookies `HttpOnly; Secure; SameSite=Strict`, без `Domain`. Внутри — JWT HS256 с `sub` (id пользователя) без ролей и email. Access и refresh подписаны разными ключами.

Сессии на сервере не хранятся. Поэтому после refresh прежний refresh-токен работает до своего срока, а logout очищает cookies только в текущем браузере. Остановить все сессии пользователя можно сменой его статуса: следующий запрос с любым его токеном получит `401`.

Браузеры принимают cookies с `Secure` по `http://localhost`, кроме Safari: для ручной проверки используй Chrome или Firefox.

### Подтверждение входа по почте

При `LOGIN_EMAIL_CONFIRMATION_ENABLED=true` после верного пароля приходит `202` с `attemptId`, а на почту уходит код или ссылка. Правила те же, что у регистрации: 10 минут, 5 вводов кода, повторное письмо не чаще раза в 60 секунд. Ссылка передаёт токен во фрагменте URL (`#token=...`), поэтому он не попадает на сервер при открытии письма.

### Пример

```bash
curl -i -c cookies.txt http://localhost:3200/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"Passw0rd"}'

curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:3200/auth/refresh
curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:3200/auth/logout
```

### Защищённые маршруты

```ts
@UseGuards(AccessGuard)
@Get("me")
me(@CurrentUserId() userId: string) {}
```

`AccessGuard` берёт access только из cookie `access_token`, проверяет подпись, срок и claims, а затем статус пользователя в базе. Модуль с таким контроллером импортирует `AuthModule`.

### Ошибки

| Статус | `code` | Когда |
| --- | --- | --- |
| `400` | `validation_failed`, `invalid_confirmation` | Неверный формат; неверный, просроченный или уже использованный код или токен |
| `401` | `invalid_credentials` | Неизвестный email, неверный пароль или аккаунт не активен. Ответ одинаковый для всех трёх |
| `401` | `invalid_session` | Access или refresh отсутствует, невалиден, истёк или пользователь не активен |
| `403` | `csrf_rejected` | Изменяющий запрос с чужого origin или без `X-CSRF-Protection: 1` |
| `429` | `rate_limited` | Больше 30 запросов в минуту с IP на `/auth/login` или `/auth/refresh` |
| `429` | `too_many_attempts` | 5 неудачных входов с пары email и IP за 15 минут |
| `429` | `attempts_exhausted`, `resend_too_early` | Исчерпаны вводы кода; письмо запрошено раньше 60 секунд, `retryAfterSeconds` — сколько ждать |
| `503` | `email_delivery_failed`, `service_unavailable` | Не ушло письмо (в ответе есть `attemptId`), недоступна база или подпись токенов |

## Frontend на другом адресе

По умолчанию frontend и API работают на одном origin. Если frontend на другом:

1. Укажи его в `FRONTEND_ORIGIN`. Только ему разрешены CORS-запросы с cookies, без `*`.
2. Отправляй запросы с `credentials: "include"`.
3. Добавляй к изменяющим запросам (`POST`, `PUT`, `PATCH`, `DELETE`) заголовок `X-CSRF-Protection: 1`. Без него запрос получит `403 csrf_rejected`.
4. Если frontend на другом site (другом домене), поставь `AUTH_COOKIE_SAME_SITE=none`.

## Формат ошибок и логи

Все ошибки возвращаются в одном формате:

```json
{ "statusCode": 409, "code": "email_taken", "message": "Email already registered" }
```

Каждый ответ содержит заголовок `X-Request-Id`. Его же пишет каждая строка лога этого запроса (`requestId=...`), поэтому по нему легко найти всё, что произошло с запросом. Можно передать свой `X-Request-Id`: буквы, цифры, `.`, `_` и `-`, до 64 символов.

В логи не попадают пароли, хеши, коды, токены, cookies и email. Неизвестный email записывается как `emailRef` — необратимый идентификатор на ключе `LOG_EMAIL_HMAC_KEY`.

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
npm test               # unit-тесты, база не нужна
npm run test:e2e       # e2e-тесты, нужен запущенный Postgres
npm run test:cov:all   # оба набора и общее покрытие, нужен запущенный Postgres
```

E2E-тесты работают с отдельной базой `backend_app_test` и пересоздают её при каждом запуске настоящими миграциями, рабочая база не затрагивается. Почта в них заменена фейком, поэтому Mailpit не нужен. Приложение для e2e собирает `test/helpers/create-test-app.ts` с той же настройкой, что и `main.ts`.

`test:cov:all` завершается с ошибкой, если покрытие ниже 80%. Отчёт в HTML сохраняется в `coverage/index.html`. В покрытие не входят `src/main.ts`, `src/data-source.ts` и миграции.
