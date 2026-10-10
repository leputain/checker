# Аудит и обновление Vinext и Cloudflare

Обычный тест и ИБ-челлендж используют Vinext и Cloudflare runtime на DE VPS. Подготовлен выпуск **1.7.1** на согласованном актуальном Cloudflare bundle с Miniflare 5 alpha; scoring v2/v3 и managed schema 19 сохраняются. Два связанных read-only аналитических SQL теперь выполняются одним D1 batch, без изменения запросов и формул. Рабочий выпуск 1.7.0 остаётся активным до завершения приёмки и отдельного переключения; окончательные локальные проверки и production deployment пока не завершены.

## Исходное состояние

На 10.10.2026 полный `npm audit` сообщает 23 уязвимых package entries: 19 high и 4 moderate. Они соответствуют 26 установленным путям и 40 различным GHSA в 10 корневых пакетах. Остальные пакеты отмечены через транзитивную цепочку `via`; это не 23 независимых сценария эксплуатации. `npm audit --omit=dev` равен нулю, но service запускает Vite preview и Cloudflare из devDependencies, поэтому такой фильтр недостаточен.

Read-only проверка сервера: приложение 1.7.0, schema 19, 9 завершённых обычных попыток и 1 завершённая попытка ИБ-челленджа. Активных попыток и pending/sending outbox нет. Очередь содержит 317 sent и 19 dead. Перед переключением эти цифры нужно снять заново; новые результаты также входят в проверку сохранности.

Worker compatibility date работающей сборки — **2026-05-15**. CLI `wrangler.local.jsonc` содержит другую дату 2026-08-27. Обновление закрепляет реальную runtime дату 2026-05-15, без изменения семантики Workers по умолчанию. Service использует `KillMode=control-group`.

## Уязвимости и достижимость

Достижимость ниже — вывод из кода и конфигурации приложения; severity и исправленные версии — данные npm audit и maintainer advisories. Атаки на production не выполняются.

| Корневой пакет | Установленная версия | Минимум исправления | Приоритет и условия |
|---|---|---|---|
| react-server-dom-webpack | 19.2.6 | 19.2.8 | P0: активный RSC runtime, multipart POST может дойти до decodeAction до проверки функции. Отсутствие `use server` недостаточно для исключения риска. |
| ws | 8.18.0 | 8.21.0 | P0: используется Cloudflare/Miniflare и inspector bridge. У приложения нет собственного WS API; конкретный disclosure-путь не подтверждён. |
| undici | 7.24.8 | 7.29.1 | P0: runtime Pool/fetch. 21 GHSA требует разных функций, включая cache/retry/SOCKS/WebSocket; их наличие в пакете не доказывает 21 публичный вектор. |
| sharp | 0.34.5 в Miniflare | 0.35.5 | P1: native image processing. Images binding и optimizer в приложении отсутствуют. |
| vite | 8.0.13 | 8.0.16 | P1: два Windows dev-server advisory; локальная разработка соответствует платформе, Linux preview VPS — нет. |
| image-size | 2.0.2 | 2.0.3 | P1: Vinext metadata images, без найденного пути публичного upload в этот parser. |
| fast-uri | 3.1.6 | 3.1.8 | P2: Ajv/toolchain, бизнес URI разбираются встроенным URL. |
| brace-expansion | 1.1.18 и 5.0.9 | 1.1.21 и 5.0.12 | P2: доверенные build/lint glob patterns. |
| braces | 3.0.3 | опубликованного исправления нет | P2: stack exhaustion в glob patterns. Vinext и ESLint сохраняют эту зависимость; предупреждение нельзя скрывать снижением audit threshold. |
| esbuild | 0.18.20 и 0.27.3 | 0.25.0 и 0.28.1 соответственно | P2: advisories требуют esbuild serve; проект использует transform/build. Старый экземпляр приходит из Drizzle loader. |

Основные primary sources: [React](https://github.com/react/react/security/advisories/GHSA-wx67-qw84-cm4g), [ws DoS](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p), [ws disclosure](https://github.com/websockets/ws/security/advisories/GHSA-58qx-3vcg-4xpx), [undici security release](https://github.com/nodejs/undici/releases/tag/v7.29.1), [sharp](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w), [Vite file access](https://github.com/advisories/GHSA-fx2h-pf6j-xcff), [Vite NTLM](https://github.com/advisories/GHSA-v6wh-96g9-6wx3), [image-size](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), [fast-uri](https://github.com/fastify/fast-uri/security/advisories/GHSA-hrr3-gc8f-f4qj), [brace-expansion](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr), [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [esbuild](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99).

## Inspector

Текущий preview отвечает HTTP 200 на локальный `/__debug` и слушает inspector на `127.0.0.1:9229`. `/candidate/__debug` возвращает 404 как локально, так и через public HTTPS; публичная доступность inspector этим не доказана. Production-конфигурация нового выпуска явно задаёт `inspectorPort: false`; приёмка требует отсутствия debugger listener и недоступности debug middleware. [Cloudflare API](https://developers.cloudflare.com/workers/vite-plugin/reference/api/).

## Варианты обновления

1. Stable Cloudflare Vite plugin `1.49.0`, Wrangler `4.116.0`, Miniflare `4.20260730.0` с точечными undici/sharp overrides. Рассмотрен как вариант: Windows benchmark проходил с максимальным p95 266,6 мс, но matched Linux прогон также обрывал parallel RPC. Старый SDK не устраняет эту проблему и тоже меняет vendor persistence format.
2. Cloudflare Vite plugin `1.63.1`, Wrangler `4.149.0`, Miniflare `5.20261006.1-alpha`. **Выбран после проверки:** vendor согласует эти версии, необходимые undici/sharp fixes входят в dependency graph без Miniflare overrides; два read-only SQL объединены batch для одного snapshot и совместимого RPC. При matched Linux измерении этот вариант быстрее stable 4. Alpha-статус Miniflare остаётся реальным риском: нужны полный локальный/CI gate, fresh SQL transfer proof и production stage; major SDK migration не считается безопасной только по peer metadata.

| Компонент | Закреплено в выпуске 1.7.1 |
|---|---|
| Vinext | 1.1.0 |
| Vite | 8.3.4 |
| plugin-rsc | 0.5.36 |
| plugin-react | 6.0.2 без изменения |
| React, React DOM, RSC | 19.2.8, одинаковая версия |
| Cloudflare Vite plugin | 1.63.1 |
| Wrangler | 4.149.0 |
| Miniflare | 5.20261006.1-alpha |
| workerd | 1.20261006.1 |
| workers-types | 5.20261006.1 |
| Next и eslint-config-next | 16.3.8 без изменения |

Registry peer relationships выбранного bundle совместимы. Тестовые/ops consumers используют общий adapter `scripts/miniflare-runtime.ts` и официальный `convertV4MiniflareOptions`. Project option `resourcePersistencePath=<absolute state>/v3` передаётся явно после conversion, сохраняя D1 в `<state>/v3/d1`. Raw `d1Persist` и относительный root отклоняются fail-closed, чтобы ops-job не открыл другой ledger. Runtime, adapter и Wrangler `--persist-to` должны адресовать один канонический D1 SQLite. `scripts/miniflare-runtime.test.ts` проверяет повторное открытие ledger и чтение того же файла через Wrangler. Дублирующий `configPath` к programmatic D1 binding не добавляется. [Miniflare changelog](https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/miniflare/CHANGELOG.md), [programmatic config](https://developers.cloudflare.com/workers/vite-plugin/reference/programmatic-configuration/).

Официальный `convertV4MiniflareOptions` молча отбрасывает старый `d1Persist`, из-за чего можно открыть пустую временную БД. Явный resource root и guards в project adapter закрывают этот риск до открытия state. SDK использует свои штатные pool/HTTP настройки; node_modules, native Pool и глобальный dispatcher не патчатся.

Worker types 5 больше не загружаются глобально вместе с `@types/node`: `db/env.d.ts` импортирует D1 interfaces как module types и объявляет только необходимые aliases/Env. Это устраняет подмену Node Buffer declarations в scripts/E2E без casts бизнес-кода и без изменения runtime bindings.

Опасные рекомендации автоматического `npm audit fix` — downgrade eslint-config-next до 14.x и drizzle-kit до 0.18.x — отклонены. Финальные overrides ограничены двумя родителями: `satori → fflate 0.7.5` и `@esbuild-kit/core-utils → esbuild 0.28.2`. `scripts/dependency-overrides.test.ts` разрешает dependency именно из parent scope, проверяет zlib interoperability с Node, Unicode ZIP/binary roundtrip, публичные sync/async transform API legacy loader, выполнение TypeScript Drizzle config и source map metadata. Miniflare 5 уже включает undici `7.29.1` и sharp `0.35.5`; scoped Miniflare overrides рассматривались для stable 4 и в финальном package отсутствуют. Native sharp проверен PNG encode/decode. Legacy loader использует transform, а не esbuild serve.

## Benchmark, RPC и существующее ограничение VPS

Initial Windows результаты на fixture 10 000 / 300 000: May Miniflare 4 baseline — максимальный p95 210,4 мс; July stable 4 — 266,6 мс; диагностический SDK 5 batch — 265,2 мс. Эти измерения не переносились на Linux без проверки той же нагрузки/хоста.

На matched Linux host исходные parallel D1 proxy/RPC reads теряли соединение (`ECONNRESET/UND_ERR_SOCKET`) и с July SDK 4, и с SDK 5 до rebuild. Keep-alive probe не помог. В `lib/analytics-direct.ts` только два связанных **read-only** SQL (`questionAggregateStatement` и `choiceAggregateStatement`) теперь выполняются одним `db.batch`: SQL, filters, scoring и формулы не меняются; результаты относятся к одному consistent snapshot. Это устраняет наблюдавшиеся обрывы обоих SDK. Конкретная upstream RPC-причина не подтверждена; timeout/idle-race гипотезы не выдаются за диагноз, blanket retries для RPC-записей не добавлены.

Matched Linux контроль старого May SDK на исходной реализации завершил все 11 измерений, но overview p95 был **735,7 мс** при SLA 500. July 4 batch дал **669 мс**; выбранный SDK 5 batch — **549,4 мс**, остальные 10 persisted-read metrics ниже 500. Снижение overview относительно исходного baseline — примерно четверть (735,7 → 549,4 мс), но 549,4 всё ещё превышает SLA. Это выявленное существующее ограничение ёмкости VPS на синтетической нагрузке 10 000 / 300 000, **P2**, а не полный benchmark PASS. Локальный/CI gate p95 ≤500 мс сохраняется без ослабления. Нагрузка не означает, что production сейчас содержит 10 000 попыток; текущие реальные counts фиксируются отдельно перед cutover.

## Полный audit и временное исключение

После обновления полный audit содержит **8 high package entries**, происходящих от **одного** неисправленного advisory `braces`: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Восемь entries учитывают транзитивные `via`-цепочки через glob/build/lint; это не восемь независимых GHSA. Снижение severity threshold не применяется. `npm audit --omit=dev` остаётся дополнительной проверкой, но не заменяет полный gate: production использует Vite/Cloudflare из devDependencies.

`npm run security:audit` запускает полный `npm audit --json` и проверяет точный advisory, package set, зависимости `via`, installed paths и версии lockfile. Допускается только рассмотренная цепочка `braces 3.0.3`; новое advisory, другая цепочка/версия, неверный отчёт, недоступный audit или истечение срока блокируют gate. Исключение действует **до 10 ноября 2026, 03:00 МСК** (`2026-11-10T00:00:00Z`). На этой границе gate уже завершается ошибкой. Остаточный риск build/lint patterns зафиксирован явно; полный audit не объявляется нулевым.

## Persistence и проверенный перенос данных

Synthetic SDK 5 SQL transfer сохранил schema 19, активные/завершённые v2/v3, challenge/events/feedback, pending/sending outbox, банк, черновик и новые post-cutover изменения при повторном чтении fresh old SDK 4 и fresh new SDK 5. Проверяются fingerprints **29 application tables**: 21 business, 7 derived и 1 runtime; отдельно сохраняется `sqlite_sequence`, включая high water после удалений. Manifest хеширует typed values, NULL, PK и schema, не выводит строки, имена кандидатов, токены или payloads. Неизвестная таблица останавливает проверку. Финальная stage-проверка актуальной production clone выбранным SDK ещё обязательна.

Выпуск разворачивается в **fresh Miniflare 5 state через актуальный application SQL**, с проверкой всех 29 tables и sequence до включения записи/maintenance. Source state остаётся нетронутым. После переключения нельзя подставлять прежний snapshot поверх новых результатов, feedback, drafts или outbox.

Несовместимость vendor state не ограничивается SDK 5: рассмотренный Miniflare 4.20260730.0 тоже создаёт `metadata.sqlite`. Прямой reopen state обоих новых SDK старым May Miniflare 4.20260515.0 воспроизводимо завершается `ERR_RUNTIME_FAILURE`. Managed SQL schema 19 и scoring остаются прежними; отсутствие бизнес-миграции не означает совместимости vendor persistence. **Code-only rollback new 5 → old 4 запрещён**, как и latest 4 → old 4 на state, уже открытом новым SDK.

Откат использует export **актуального** application SQL, fresh target, инициализированный прежним SDK, прямой SQLite import и повторное чтение старым runtime. Сравнение должно сохранить latest writes во всех 29 tables и sequence. Удаление vendor metadata на рабочем state не является процедурой отката. Synthetic new 5 → SQL → fresh old/new path проверен; перед production cutover требуется также фактическая Linux stage-проверка SQL → fresh old reader.

Команды выполнять после остановки writers; target должен отсутствовать. Использовать канонический D1 SQLite, исключив vendor `metadata.sqlite`. Перед заполнением переменных сверить binding `DB`, database UUID и разрешённые абсолютные пути. Ни один helper не разрешает перезапись существующего target.

```bash
set -euo pipefail
umask 077
SOURCE_DB='<canonical source D1.sqlite>'
TRANSFER_SQL='<private new transfer.sql>'
BEFORE_MANIFEST='<new before-manifest.json>'
TARGET_STATE='<new absolute state directory>'
DB_ID='<same DB binding database UUID>'

python3 -B scripts/sqlite-business-manifest.py export "$SOURCE_DB" "$TRANSFER_SQL" > "$BEFORE_MANIFEST"
node --experimental-strip-types scripts/initialize-transfer-state.ts "$TARGET_STATE" "$DB_ID"

# Для fresh state прежним проверенным Miniflare 4 вместо предыдущей строки:
# node --experimental-strip-types scripts/initialize-transfer-state.ts "$TARGET_STATE" "$DB_ID" \
#   --sdk-package '<verified previous release>/node_modules/miniflare'

TARGET_DB="$TARGET_STATE/v3/d1/miniflare-D1DatabaseObject/$(basename "$SOURCE_DB")"
test -f "$TARGET_DB"
test "$TARGET_DB" != "$SOURCE_DB"

# Импорт напрямую в уже инициализированный SQLite. На target для отката
# не запускать новый SDK 5/Wrangler: он снова создаст несовместимые metadata.
node --input-type=module - "$TARGET_DB" "$TRANSFER_SQL" <<'JS'
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
let db;
try {
  db = new DatabaseSync(process.argv[2]);
  db.exec(readFileSync(process.argv[3], 'utf8'));
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error();
} catch {
  console.error('transfer_import_failed');
  process.exitCode = 1;
} finally {
  db?.close();
}
JS

python3 -B scripts/sqlite-business-manifest.py compare "$TARGET_DB" "$BEFORE_MANIFEST" --scope application
```

`--scope application` требует совпадения всех application tables и `sqlite_sequence`; vendor metadata/SQLite statistics сравниваются отдельно как internal. После повторного открытия нужным SDK сравнение выполнить ещё раз. `ops:restore` здесь не применяется: он сразу запускает retention и меняет очереди/старые незавершённые попытки. Raw SQL содержит чувствительные данные; хранить с правами 0600 не более 24 часов и удалить после приёмки.

## Maintenance и завершение процессов

Для stage задавать `CANDIDATE_CHECK_MAINTENANCE_ENABLED=0`. Это отключает background HTTP maintenance и startup backup retention. Одного `TELEGRAM_ENABLED=0` недостаточно: активный maintenance гасит pending/sending outbox и очищает payload, а также закрывает просроченные challenge attempts. Stage credentials/egress остаются изолированными независимо от отключения maintenance.

Production cutover выполняется под временным Nginx admission `503`: новые публичные запросы не доходят до приложения. Первый запуск нового state — с `CANDIDATE_CHECK_MAINTENANCE_ENABLED=0`, чтобы сравнить 29 application tables/sequence и очередь без фоновых записей. После совпадения fingerprints остановить экземпляр и подтвердить отсутствие PID/FD writers; затем перезапустить с `CANDIDATE_CHECK_MAINTENANCE_ENABLED=1` и `CANDIDATE_CHECK_MAINTENANCE_START_DELAY_MS=60000`. Выполнить private smoke до открытия admission; через 60 секунд maintenance запускается автоматически.

Допустимый start delay — целое `1..120000`, default `2000`; enabled принимает `0|1`, default `1`. Grace не отключает startup backup retention и не останавливает foreground API-записи, поэтому сама по себе не заменяет admission barrier. На каждом переключении проверить service/process journal; при провале этапа выполняется компенсация, а состояние не объявляется принятым по одному health 200.

Node wrapper передаёт SIGTERM/SIGINT в собственную POSIX process group, завершает оставшихся descendants и освобождает lock после остановки runtime. На Windows stop path использует `taskkill /T /F` для собственного child tree; POSIX delivery не эмулируется. `scripts/runtime-process.test.ts` проверяет реальный synthetic child/grandchild, отключённый maintenance/retention, grace и освобождение lock. На production дополнительно сохраняется systemd `KillMode=control-group`.

## План внедрения

### P0 Подготовка

- Сохранить обезличенные before audit и dependency tree. Создать воспроизводимый baseline toolchain отдельно от изменяемого node_modules.
- Зафиксировать schema 19, scoring/config hashes, bindings, реальный state path, compatibility date и public vars. Секреты не переносить в отчёт или сборку.
- Добавить manifest, который хеширует все бизнес-таблицы, PK, типы значений и NULL, выводя только counts/digests. Неизвестная таблица останавливает проверку до классификации.

### P1 Обновление и проверки

- Обновить exact версии согласованного bundle, адаптировать Miniflare API, отключить inspector и явно закрепить compatibility date.
- Добавить управляемое отключение maintenance для stage и корректную остановку Node wrapper/child tree. На production maintenance остаётся включённым.
- Выполнить fresh npm ci, полный audit, unit/model/bank/admin/Telegram/scoring/challenge, ops, TypeScript, ESLint, build, secrets scan, benchmark и весь WebKit E2E.
- В отдельной синтетической state проверить restart активных v2/v3/ИБ, повтор ответов, pending/sending outbox, черновик банка, feedback и импорт/экспорт через новый и старый toolchain.
- Production clone запускать без maintenance и без реальных credentials/egress. Простого `TELEGRAM_ENABLED=0` недостаточно: обычный maintenance удаляет/гасит очередь и завершает просроченные challenge attempts. `ops:restore` с retention для побитового переноса не использовать.
- Подтвердить на копии: новый runtime и Wrangler читают одну D1; все application fingerprints/sequence совпадают; обратный путь выполняется через актуальный SQL в fresh old-toolchain state. Прямой old-reader на новом vendor state уже известен как несовместимый.

### P2 Переключение

- Переснять актуальное состояние всех попыток/очереди; не ограничиваться первоначальными девятью результатами. Дождаться отсутствия активных обычных и ИБ-попыток, затем включить временный Nginx admission `503`.
- Остановить service и всех writers; подтвердить PID/FD tree и реальный state path. Повторно проверить active counts: если появились активные, компенсированно восстановить прежний рабочий контур и отложить переключение.
- Снять свежий защищённый snapshot/manifest, экспортировать актуальный SQL в fresh SDK 5 state, проверить schema 19 и все 29 application tables/sequence. Исходный state не перезаписывать.
- Запустить новый экземпляр с maintenance `0`; по private доступу проверить readiness, application fingerprints и очередь. При несовпадении прекратить приёмку и выполнять проверенный rollback, не открывая admission.
- Остановить validation instance, подтвердить отсутствие FD writers и ошибок journal, затем перезапустить с maintenance `1` и grace `60000`. Повторить private live/ready, SSR/assets/admin/challenge, inspector и journal smoke.
- Только после этих проверок снять admission `503`, проверить public HTTPS и штатный maintenance/outbox. Не создавать production тестовые попытки или реальные Telegram-сообщения ради smoke. Любой failure компенсировать восстановлением рабочего service/admission и сохранением актуальных данных.
- После приёмки удалить stage clone/log и raw snapshot; оставить несекретный manifest, предыдущий код и проверенную процедуру отката.

## Откат и критерии готовности

Откат возвращает старый toolchain с **актуальными** данными через fresh SQL transfer. Старый snapshot нельзя восстанавливать поверх post-cutover ответов, feedback, очереди или публикаций банка. Прямой code-only rollback с SDK 5 или July SDK 4 к May 4.20260515.0 уже проверенно несовместим: остановить writers, экспортировать актуальный application SQL и создать свежий old-toolchain state по процедуре выше. Дата Workers, модель оценки и schema 19 остаются прежними, но vendor state формат изменён.

Готовность означает: нет runtime GHSA в исправляемых цепочках; остаточные findings перечислены; локальный/CI gate проходит; все business facts/outbox/sequence сохранены; inspector отключён; forward SDK 5 и SQL → fresh old reader доказаны на финальном stage. Linux overview 549,4 мс на 10k capacity fixture фиксируется отдельным P2 с сохранением SLA 500 и исходного baseline 735,7; это не маркируется full performance PASS. Любой новый провал сохранности, transport completion или совместимости оставляет production на предыдущем выпуске.

## Итог выполнения

Финальные локальные проверки 1.7.1 пройдены: fresh npm ci, unit/model/scoring/challenge/bank/admin/Telegram/analytics, ops, persistence, manifest, TypeScript, ESLint, secrets и audit policy. WebKit: **51 passed, 23 штатных skip**. Нагрузочный gate на Windows: 10 000 попыток / 300 000 фактов, 11/11 проверок, максимальный p95 **209,9 мс** при прежнем лимите 500 мс.

На финальном Linux stage: fresh install/build/artifact scan, process cleanup, 12 assets, SSR, live/ready и debug 404 подтверждены. Все 29 таблиц приложения и sqlite_sequence после переноса, запуска и обратного SQL-переноса идентичны; старый SDK читает fresh rollback state. Сохранены 9 обычных результатов, 1 ИБ-результат и 336 outbox rows. Девять синтетических fault-сценариев switch/rollback подтвердили компенсацию каждого rename и сохранение post-cutover данных.

Matched Linux transport завершает все 11 измерений, 10 ниже 500 мс, overview 549,4 мс против существовавших 735,7 baseline. Это открытый P2 capacity risk, без снижения SLA. Приватный банк не передаётся в CI: workflow теперь создаёт 160 синтетических вопросов с каноническими темами и ИБ-пулом, exclusive-create допускается только в GitHub Actions. Это исправляет прежний CI mismatch с неполным example-bank; timeout общего verify увеличен до 30 минут.

Удалённый CI и production переключение пока не завершены. Deployment manifest и актуальные counts добавляются после приёмки; production success здесь не заявляется.
