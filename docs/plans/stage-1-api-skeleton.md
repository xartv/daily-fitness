# Этап 1: скелет API и база

Развёрнутый план этапа 1 из [`implementation-plan.md`](./implementation-plan.md).

Цель этапа: `pnpm dev` поднимает API, `GET /api/health` отвечает 200 и при этом реально ходит в Postgres через Prisma. Бизнес-логики пока нет, строится только каркас, на который дальше навешиваются модули.

На старте этапа в `apps/api` есть только `package.json` и `tsconfig.json`. Ниже шаги в рекомендуемом порядке: каждый шаг можно проверить отдельно, прежде чем идти дальше.

---

## Шаг 1. Postgres в Docker (`docker-compose.yml` в корне)

**Что сделать**

- Сервис `postgres` на официальном образе с конкретной мажорной версией (например `postgres:18`), а не `latest`.
- Переменные `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.
- Именованный volume для данных.
- Порт пробросить только на localhost: `"127.0.0.1:5432:5432"`.
- `healthcheck` через `pg_isready`.

**Почему так**

- **Фиксированная версия образа.** Мажорные версии Postgres несовместимы по формату данных. Если `latest` однажды обновится до новой мажорной версии, контейнер не сможет прочитать старый volume.
- **Именованный volume.** Данные переживают `docker compose down` и пересоздание контейнера, а удаляются только через `down -v`.
- **`127.0.0.1:` перед портом.** Запись `5432:5432` открывает базу на всех сетевых интерфейсах машины. На Linux-сервере Docker к тому же обходит ufw. Привычка ограничивать порт localhost'ом пригодится на этапе 4.
- **Healthcheck.** Позже по нему можно будет запускать API только после того, как база действительно готова. Запущенный контейнер ещё не значит, что база принимает подключения.

> ⚠️ В образе Postgres 18 изменился путь для данных: volume монтируется в `/var/lib/postgresql`, а не в `.../data`, как в старых гайдах. Сверься со страницей образа.

**Проверка:** `docker compose up -d`, `docker compose ps` показывает статус `healthy`, а `docker compose exec postgres psql -U <user> <db>` подключается к базе.

---

## Шаг 2. Минимальный Fastify и запуск TS

**Что сделать**

- Зависимости в `apps/api`: `fastify`, `fastify-plugin`, `fastify-type-provider-zod`, `@fastify/helmet`. Для dev: `tsx` (или аналог, см. ниже).
- Разделить код на два файла:
  - `src/app.ts`: функция `buildApp()` создаёт инстанс Fastify, регистрирует плагины и роуты и возвращает его. Порт она не слушает.
  - `src/server.ts`: вызывает `buildApp()`, затем `listen()` и обрабатывает `SIGINT`/`SIGTERM` через `app.close()`.
- Скрипты в `apps/api/package.json`: `dev` (запуск с watch) и `typecheck` (`tsc`).

**Почему так**

- **Разделение `app` и `server`.** На этапе 5 интеграционные тесты будут вызывать `buildApp()` и `app.inject()` без реального порта. Если сразу сделать один файл с `listen()`, потом придётся его разрезать.
- **Graceful shutdown.** Docker при остановке контейнера шлёт `SIGTERM`. API должен дообработать текущие запросы и закрыть пул соединений с БД, а не умереть посреди транзакции. `app.close()` запускает хуки `onClose` всех плагинов, туда и попадёт отключение Prisma.

**Чем запускать TS.** В `tsconfig.base.json` стоит `noEmit`, то есть `tsc` здесь только проверяет типы, а исполнять код должен кто-то другой. Варианты:

- `tsx watch src/server.ts` — **рекомендуется для dev.** Работает с любым TS-синтаксисом и с пакетом `shared`, который экспортирует исходники `.ts`.
- Встроенный type stripping в Node 24 (`node --watch src/server.ts`). Без зависимостей, и `erasableSyntaxOnly` уже включён. Но в импортах придётся писать расширение `.ts`, а на сгенерированном коде Prisma могут быть шероховатости.
- Для прода код всё равно собирается бандлером (esbuild/tsdown) на этапе 4. Сейчас об этом думать не нужно.

**Проверка:** временный `GET /api/health` с ответом `{ status: "ok" }`, затем `curl localhost:<port>/api/health`.

---

## Шаг 3. Конфиг через zod (`src/config/env.ts`)

**Что сделать**

- Zod-схема для `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`. `JWT_SECRET` и остальные секреты добавятся на этапе 5.
- `parse(process.env)` при импорте модуля, наружу экспортировать типизированный объект `env`. Дальше по коду `process.env` напрямую не читать.
- Загружать `.env` встроенным флагом Node `--env-file=.env` (tsx его тоже поддерживает). Пакет `dotenv` не нужен.
- Создать `apps/api/.env.example` со всеми ключами и фейковыми значениями.

**Почему так**

- **Падать при старте (fail fast).** Если `DATABASE_URL` забыт, лучше узнать это при деплое, когда контейнер сразу упадёт с понятной ошибкой. Иначе ошибка всплывёт через час на первом запросе пользователя.
- **Строки в `process.env`.** Там всё хранится строками, поэтому для `PORT` нужен `z.coerce.number()`.
- **Сообщение об ошибке.** Не выводить значения переменных в лог, это секреты. Достаточно имён полей, которые не прошли валидацию: для этого есть `z.prettifyError` или `issues`.
- **`HOST`.** Локально подходит `127.0.0.1`, а в Docker на этапе 4 понадобится `0.0.0.0`. Поэтому хост задаётся через env, а не в коде.

**Проверка:** удалить переменную из `.env` и убедиться, что сервер не стартует, а в ошибке названо имя этой переменной.

---

## Шаг 4. Логирование, ошибки, helmet

**Что сделать**

- **Pino.** Добавить `pino-pretty` в devDependencies. Передать `logger` в опции Fastify: уровень берётся из env, в dev вывод идёт через `pino-pretty` (transport), в проде остаётся чистый JSON.
- **Type provider.** Подключить `validatorCompiler` и `serializerCompiler` из `fastify-type-provider-zod`. Без них Zod-схемы в роутах не заработают.
- **Плагин `src/plugins/error-handler.ts`:**
  - `setErrorHandler` приводит все ошибки к формату `{ error: { code, message, details? } }`;
  - ошибки валидации Zod превращаются в 400 с `code: "VALIDATION_ERROR"` и деталями (у type provider есть хелпер для их распознавания);
  - ошибки со `statusCode < 500` (например, от Fastify) отдаются как есть, только в нужном формате;
  - всё остальное логируется полностью, а клиенту уходит 500 с общим текстом;
  - `setNotFoundHandler` отдаёт 404 в том же формате.
- **Helmet.** Зарегистрировать `@fastify/helmet`.

**Почему так**

- **Не раскрывать детали 500.** Стектрейсы и тексты ошибок Prisma могут содержать структуру БД и куски данных, а это подсказка атакующему. Подробности пишутся в лог, клиенту уходит общее сообщение.
- **Единый формат ошибок.** Фронтовый fetch-клиент на этапе 5 сможет разбирать любую ошибку одним кодом.
- **JSON-логи в проде.** Их можно фильтровать и парсить (`docker logs | jq`), а pretty-вывод нужен только человеку в терминале.
- **Helmet для JSON API.** Пользы от него здесь немного: CSP и прочее важнее для HTML. Но заголовки дешёвые, и это принятая практика.

**Главная концепция Fastify для этого шага — инкапсуляция.** Каждый `register` создаёт изолированный контекст: декораторы и хуки, объявленные внутри плагина, не видны снаружи. Чтобы `fastify.prisma` или error handler действовали на всё приложение, плагин оборачивают в `fastify-plugin`. Стоит прочитать про это до написания кода, иначе легко потерять час на вопрос «почему `app.prisma` равен undefined».

**Проверка:** `GET /api/nope` возвращает 404 в нашем формате. Временный роут с `throw new Error("boom")` возвращает 500 без текста `boom` в ответе, но со стектрейсом в логе.

---

## Шаг 5. Prisma

**Что сделать**

- Зависимости: `prisma` (dev) и `@prisma/client`, а также драйвер-адаптер `@prisma/adapter-pg`.
- `prisma init` внутри `apps/api`.
- Плагин `src/plugins/prisma.ts` (через `fastify-plugin`): создаёт клиент, делает `decorate('prisma', client)`, в хуке `onClose` вызывает `$disconnect()`. Добавить module augmentation `FastifyInstance` в TS, чтобы `app.prisma` был типизирован.
- `/api/health` выполняет `SELECT 1` через `$queryRaw`. Если БД недоступна, он отвечает 503.
- Сгенерированный клиент добавить в `.gitignore`. Скрипт `postinstall` или отдельный `db:generate` вызывает `prisma generate`.

> ⚠️ **Prisma 7 заметно отличается от большинства туториалов в интернете:**
>
> - появился `prisma.config.ts` (URL базы берётся оттуда, `.env` сам больше не подгружается);
> - новый генератор `prisma-client` с явным `output`;
> - драйвер-адаптеры стали обязательными.
>
> Если в гайде встречается `generator client { provider = "prisma-client-js" }` и `url = env(...)` в `schema.prisma`, этот гайд описывает старую версию. Ориентироваться на официальный Getting Started для PostgreSQL и upgrade guide на v7.

**Почему так**

- **Один `PrismaClient` на процесс.** Каждый клиент держит свой пул соединений, а у Postgres жёсткий лимит подключений (по умолчанию 100). Если создавать клиент в каждом модуле или запросе, лимит быстро закончится. Декоратор на инстансе решает это и заодно даёт доступ из сервисов.
- **Health проверяет БД.** Если API жив, а база нет, `/health` с ответом 200 врёт. Позже Docker healthcheck и мониторинг будут опираться именно на этот эндпоинт.
- **Схема пустая.** Модели появятся на этапе 2. `generate` с пустой схемой работает, а миграций пока нет.

**Проверка:** `/api/health` отвечает 200. После `docker compose stop postgres` он отвечает 503, а сам API при этом не падает.

---

## Шаг 6. Связка монорепо

- В API импортировать что-нибудь из `@daily-fitness/shared` и убедиться, что проходят и `pnpm typecheck`, и запуск через tsx. Этим закрывается хвост этапа 0.
- В корневом `package.json` добавить скрипт `dev`: `pnpm -r --parallel dev` (позже он будет поднимать и web, и api).
- Записать в `CLAUDE.md` команды API: `dev`, `typecheck`, `prisma generate`, `migrate dev`, `db seed`, `docker compose up -d`.
- Проверить `pnpm lint`: oxlint с type-aware правилами должен видеть новый пакет.

---

## Что почитать

Читать по ходу шагов, не всё сразу.

| Тема | Что именно |
| --- | --- |
| **Fastify** — [fastify.dev/docs/latest](https://fastify.dev/docs/latest/) | Getting Started; **Encapsulation** и **Plugins Guide** (обязательно); Decorators; Hooks (`onClose`); Errors / `setErrorHandler`; Logging; Type Providers; Server (опции `logger`, `listen`) |
| fastify-plugin | [github.com/fastify/fastify-plugin](https://github.com/fastify/fastify-plugin): зачем нужен `fp` |
| fastify-type-provider-zod | README: подключение компиляторов, обработка ошибок валидации, совместимость с Zod 4 |
| @fastify/helmet | README, опции по умолчанию |
| **Pino** | [getpino.io](https://getpino.io): уровни, transports; `pino-pretty` |
| **Zod 4** | [zod.dev](https://zod.dev): `parse`/`safeParse`, `z.coerce`, форматирование ошибок |
| **Node** | `--env-file`, `--watch`, type stripping ([nodejs.org/api/typescript.html](https://nodejs.org/api/typescript.html)); [tsx.is](https://tsx.is) |
| **Prisma 7** | Getting Started → PostgreSQL; `prisma.config.ts`; генератор `prisma-client`; Driver adapters (`adapter-pg`); **Upgrade to v7**; Connection management (почему один клиент) |
| **Docker** | Compose file reference (`services`, `volumes`, `ports`, `healthcheck`); страница образа `postgres` на Docker Hub (env-переменные, путь данных в v18) |
| pnpm | `pnpm -r`, `--filter`, `--parallel` |

Для общего понимания бэкенда: [12-factor app](https://12factor.net/ru/), разделы III «Конфигурация», IX «Утилизируемость» и XI «Журналирование». Это ровно то, что делается в шагах 3–5.
