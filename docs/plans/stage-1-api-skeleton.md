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

Цель шага: в процессе API живёт ровно один `PrismaClient`, доступный как `app.prisma`, а `/api/health` честно проверяет соединение с Postgres.

> ⚠️ **Prisma 7 заметно отличается от большинства туториалов в интернете:**
>
> - появился `prisma.config.ts` (URL базы берётся оттуда, `.env` сам больше не подгружается);
> - новый генератор `prisma-client` с явным `output`: клиент генерируется в исходники, а не в `node_modules`;
> - Rust-движок запросов убран, драйвер-адаптеры (`@prisma/adapter-pg`) стали обязательными.
>
> Если в гайде встречается `generator client { provider = "prisma-client-js" }` и `url = env(...)` в `schema.prisma`, этот гайд описывает старую версию. Ориентироваться на официальный Getting Started для PostgreSQL и upgrade guide на v7.

### 5.1. Зависимости ✅

- `prisma` в devDependencies (CLI: `init`, `generate`, позже `migrate`), `@prisma/client` и `@prisma/adapter-pg` в dependencies (нужны в рантайме).
- Все три зафиксированы на одной точной версии (`7.10.1`, без `^`) и обновляются только вместе: CLI генерирует код под конкретную версию клиента.
- В `allowBuilds` (`pnpm-workspace.yaml`) разрешены install-скрипты `prisma` и `@prisma/engines`: последний скачивает бинарник schema engine, без которого не работают `migrate` и `db push`.

**Почему так**

- **Не доверять тегу `latest` вслепую.** На момент установки у `prisma` тег `latest` указывал на `8.0.0-rc.*`, а у `@prisma/client` на `7.10.1`. `pnpm add prisma` поставил RC восьмой версии, который вдобавок притащил `workerd` и ещё 45 уязвимостей по цепочке. Перед `add` полезно смотреть `npm view <pkg> dist-tags`.
- **`allowBuilds` — белый список.** pnpm по умолчанию не выполняет install-скрипты зависимостей, потому что это главный вектор supply-chain атак. Разрешать стоит только то, про что понятно, откуда оно и зачем (`pnpm why <pkg>`).
- **Остаток `pnpm audit`.** 3 уязвимости в `lodash` приходят через Prisma Studio (`prisma → @prisma/studio-core → @visx/* → lodash`). Это dev-инструмент, в рантайм и прод-образ он не попадает. Ждём обновления Prisma, `overrides` не используем.

**Проверка:** `pnpm -F @daily-fitness/api exec prisma --version` показывает одинаковые версии `prisma` и `@prisma/client` и находит Schema Engine. `pnpm why workerd -r` пустой.

### 5.2. `prisma init`

- Запустить внутри `apps/api`. Появятся `prisma/schema.prisma` и `prisma.config.ts`.
- Сразу после этого посмотреть `git diff`: `init` может дописать строки в `.env` и `.gitignore`. Убедиться, что `DATABASE_URL` в `.env` не перезаписан (порт **5433**, как в `docker-compose.yml`), а лишних записей в `.gitignore` нет.
- Привести `schema.prisma` к виду v7:
  - `generator client`: `provider = "prisma-client"` (без `-js`) и `output = "../src/generated/prisma"`;
  - `datasource db`: только `provider = "postgresql"`, без `url`.
- Моделей не добавлять, схема остаётся пустой.

**Почему так**

- **Клиент в исходниках.** Генератор `prisma-client` пишет обычные TS-файлы в `src/generated/prisma`, импорт идёт из `src/generated/prisma/client`. Код генерируется как ESM, и это совпадает с `"type": "module"` у API.
- **Схема пустая.** Модели появятся на этапе 2. `generate` с пустой схемой работает, а миграций пока нет.

### 5.3. `prisma.config.ts` и загрузка `.env`

- В конфиге указать путь к схеме, папку миграций (`prisma/migrations`, пригодится на этапе 2) и `datasource.url` из `DATABASE_URL`.
- CLI Prisma запускается не через наш `dev`-скрипт, поэтому `--env-file` на него не действует, а сам `.env` Prisma 7 не читает. Загрузить файл встроенным `process.loadEnvFile()` (Node ≥ 21), без пакета `dotenv`.
- `loadEnvFile()` бросает исключение, если файла нет. Вызывать его только при наличии `.env`: на проде файла не будет, переменные придут из окружения контейнера.
- Этот файл читает только CLI. Сервер берёт URL из нашего `env` (шаг 3), а не из `prisma.config.ts`.

**Почему так**

- **Одно правило для всех окружений.** Локально переменные берутся из `.env`, в Docker и CI из окружения процесса. Код при этом одинаковый, отличается только источник (12-factor, раздел III).
- **Без `dotenv`.** В Node уже есть всё нужное, и это на одну зависимость меньше (и на один пакет меньше в цепочке поставок).

**Проверка:** `pnpm -F @daily-fitness/api exec prisma validate` проходит без ошибок.

### 5.4. Генерация клиента и инструменты

- `apps/api/src/generated/` добавить в `.gitignore`.
- Тот же путь добавить в `.prettierignore` и в `ignorePatterns` в `.oxlintrc.json`.
- Скрипты в `apps/api/package.json`:
  - `db:generate` → `prisma generate`;
  - `postinstall` → `prisma generate`.

**Почему так**

- **Сгенерированный код не коммитят.** Это артефакт, его всегда можно восстановить из `schema.prisma`. В git он даёт огромные бессмысленные диффы и конфликты.
- **Линтеры не должны проверять чужой код.** Без игнора `pnpm lint` и `pnpm format:check` начнут падать на файлах, которые ты не писал и править не должен.
- **`postinstall`.** На свежем клоне, в CI и в Docker-сборке клиента ещё нет. Без автоматической генерации `typecheck` упадёт на импорте `generated/prisma/client`. `db:generate` нужен для ручного запуска после правки схемы.

**Проверка:** удалить `src/generated`, выполнить `pnpm install`, и папка должна появиться снова. `pnpm lint` и `pnpm format:check` не упоминают файлы из `src/generated`.

### 5.5. Плагин `src/plugins/prisma.ts`

- Обернуть в `fastify-plugin`, как `error-handler`.
- Создать адаптер `PrismaPg` с `connectionString: env.DATABASE_URL` и передать его в `new PrismaClient({ adapter })`. URL брать из провалидированного `env`, не из `process.env`.
- `app.decorate("prisma", client)`.
- В хуке `onClose` вызвать `client.$disconnect()`.
- В этом же файле module augmentation: `declare module "fastify"` с полем `prisma: PrismaClient` в `interface FastifyInstance`.
- Зарегистрировать плагин в `app.ts` до роутов, рядом с `errorHandler`.
- Явный `$connect()` при старте не вызывать.

**Почему так**

- **Один `PrismaClient` на процесс.** Каждый клиент держит свой пул соединений, а у Postgres жёсткий лимит подключений (по умолчанию 100). Если создавать клиент в каждом модуле или запросе, лимит быстро закончится. Декоратор на инстансе решает это и заодно даёт доступ из сервисов.
- **`fastify-plugin`.** Без него декоратор виден только внутри контекста плагина, и в роутах `app.prisma` будет `undefined` (инкапсуляция, см. шаг 4).
- **Module augmentation.** TypeScript не знает, что `decorate` добавил поле. Расширение интерфейса через declaration merging даёт типизированный `app.prisma` во всём приложении.
- **`$disconnect` в `onClose`.** Graceful shutdown из `server.ts` вызывает `app.close()`, а тот запускает все `onClose`-хуки. Соединения закрываются аккуратно и не висят в Postgres до таймаута.
- **Ленивое подключение.** Пул `pg` открывает соединение на первом запросе. Если БД недоступна при старте, API всё равно поднимется, а `/health` покажет 503. Это даёт процессу пережить перезапуск базы. Явный `$connect()` при старте сделал бы обратное: API падал бы, пока база не готова.

**Проверка:** `pnpm typecheck` проходит, и в любом роуте `app.prisma` типизирован без кастов.

### 5.6. `/api/health` с проверкой БД

- Перенести health из временного `routes/test.ts` в постоянное место (`routes/health.ts`), а `test.ts` удалить.
- В обработчике выполнить `` app.prisma.$queryRaw`SELECT 1` ``.
- Успех: 200 `{ status: "ok" }`.
- Ошибка: поймать **в обработчике**, залогировать через `request.log.error`, ответить 503 в общем формате ошибок (`code: "SERVICE_UNAVAILABLE"`).
- Описать схему ответа через Zod, как для остальных роутов.

**Почему так**

- **Health проверяет БД.** Если API жив, а база нет, `/health` с ответом 200 врёт. Позже Docker healthcheck и мониторинг будут опираться именно на этот эндпоинт.
- **`SELECT 1`.** Самый дешёвый запрос, который доказывает, что соединение из пула живое и база отвечает.
- **503, а не 500.** Непойманная ошибка ушла бы в error handler и стала 500 («баг на сервере»). 503 (Service Unavailable) говорит точнее: сервис временно не может работать, повтори позже. Балансировщики и оркестраторы понимают именно так.

### 5.7. Проверка шага целиком

1. `docker compose up -d`, `pnpm -F @daily-fitness/api dev` → `curl localhost:3000/api/health` отвечает **200**.
2. `docker compose stop postgres` → тот же запрос отвечает **503**, в логе ошибка подключения, процесс API жив.
3. `docker compose start postgres` → снова **200** без перезапуска API: пул переподключается сам.
4. Ctrl+C → в логе `shutting down`, процесс завершается без зависания (сработал `$disconnect`).
5. `pnpm typecheck && pnpm lint && pnpm format:check` проходят.
6. Свежий клон (или `rm -rf node_modules apps/api/src/generated && pnpm install`) → `pnpm typecheck` проходит без ручного `generate`.

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
