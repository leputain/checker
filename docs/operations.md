# Candidate Check: локальный runbook

## Оценка v3 / выпуск 1.7.0

Выпуск опубликован на DE VPS 10.10.2026. Переключение заняло 3,44 секунды; public HTTPS live/ready, главная, восемь JS/CSS ресурсов, ИБ-челлендж и PIN-login проверены. Managed schema 19; Telegram configured. Контрольные суммы attempts/answers/attempt_questions/questions до/после совпадают: девять прежних попыток не изменены. В admin v2 они доступны двумя банковыми когортами (7 + 2), без смешивания редакций банка. На сервере сохранены предыдущий код и manifest проверки; raw SQLite snapshot и stage validation state/log удалены после приёмки, credentials имеют права 0600. Тестовых попыток или Telegram-сообщений в production не создавали.

Проверки выпуска: unit/model/bank/analytics/Telegram/admin tests, SQL integrity/operations backup/restore, TypeScript и ESLint — PASS. Основной WebKit iPad E2E: 51 PASS, 23 намеренно пропущены; после dependency patch повторно 7 связанных E2E PASS. Production build и проверка артефактов на секреты PASS; benchmark 10 000 / 300 000 PASS. Порог 17/20 является выбранной продуктовой строгостью, а не статистически откалиброванной нормой.

Новые обычные попытки используют `scoringVersion=3`; активные v2 завершаются по своей версии. Миграция `0020_scoring_v3_penalties.sql` (managed schema version 19) добавляет отдельные `penalty_score` к ответам и агрегатам с DEFAULT 0. Значения старых score/verdict и факты ответов не пересчитываются. Миграция инвалидирует только производную аналитическую проекцию.

Перед выпуском проверить: unit tests, SQL integrity для обеих версий и отрицательного сырого итога, operations backup/restore, TypeScript, ESLint, production build и изолированные E2E. E2E проверяет 15/20 основных + 5 правильных дополнительных → 80/REVIEW, ранний штраф и повторный ответ, продолжение v2 и сохранение исторического результата. Telegram в тестовом контуре отключён от реальной доставки.

На DE VPS runtime расположен в `/opt/candidate-check/app`, state — `/opt/candidate-check/state` через symlink `.wrangler/state`. User service `candidate-check.service` запускает Node 24.20.0 и preview на `127.0.0.1:18301`, приложение опубликовано под `/candidate`. Новый выпуск собирается в отдельном каталоге `releases`; перед переключением делать SQLite online backup с правами 0600 и записывать хеш бизнес-фактов без имён, токенов или payloads. Проверять отсутствие активных попыток либо сохранять поддержку v2; после переключения — live/ready, schema=19, оба config v2/v3, неизменность прежних бизнес-фактов и отсутствие штрафов в исторических v2.

Cloudflare/Vite запекает public vars в `dist/server/wrangler.json`: при сборке сохранять текущие `TELEGRAM_*` status/enabled/required, `ADMIN_CONFIG_STATUS`, analytics/selection/challenge flags и `NEXT_PUBLIC_BASE_PATH=/candidate`. Секреты передаются только runtime-обёрткой, в сборку их не включать. Сравнить public vars до/после. Для stage использовать изолированную копию SQLite, отключить реальные credentials/egress и передать `CANDIDATE_CHECK_MAINTENANCE_ENABLED=0`; простого отключения Telegram недостаточно, потому что maintenance гасит pending/sending очередь и закрывает просроченные challenge attempts. После остановки probe вернуть production public vars. `.validation-state` и stage runtime log удалить до переключения.

Проверка 10.10.2026 выявила три production dependency advisories; закреплены Next и eslint-config-next `16.3.8`, sharp `0.35.5`, source-map-js `1.2.2` в lockfile. `npm audit --omit=dev` для 1.7.0 вернул 0. Источники: [Next.js](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), [sharp](https://github.com/advisories/GHSA-wq5f-xc86-pv6w), [source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). Полный audit графа 1.7.0 содержал 23 package entries (19 high, 4 moderate), включая Vinext/Vite/Cloudflare и react-server-dom-webpack. Поскольку production service использует Vite preview и Cloudflare runtime из devDependencies, это нельзя считать исключительно риском локальной разработки. Согласованное обновление подготовлено отдельным выпуском 1.7.1; результаты и незавершённые проверки описаны ниже. Выпуск 1.7.0 не объявляется полностью очищенным по full audit.

Откат к прежней оценке допустим до появления любых попыток v3. Если managed schema ещё 18, достаточно вернуть прежний каталог приложения. После миграции 19 обычный бинарный 1.6.1 отклонит readiness из-за номера схемы: для возврата старого кода требуется совместимый rollback build с `CURRENT_SCHEMA_VERSION=19`, сохранением текущих runtime flags и неизменной БД. Колонки DEFAULT 0 и migration marker 19 остаются; старые операции пишут v2 без штрафов. После появления фактов v3 старый код не понимает их сумму: требуется выпуск с поддержкой обоих ledger либо исправление вперёд. Не восстанавливать старую БД поверх новых результатов и не удалять v3 ради отката. Резервную копию держать в закрытом каталоге не более 24 часов; после приёмки убрать raw snapshot, сохранив несекретный manifest и предыдущий код.

## Обновление toolchain / подготовленный выпуск 1.7.1

Выпуск 1.7.1 подготовлен локально на актуальном согласованном Cloudflare bundle с Miniflare 5 alpha; финальные проверки и production deployment ещё не завершены. На сервере продолжает работать 1.7.0. Scoring v2/v3, конфигурации тестов и managed schema 19 не меняются. Только связанная пара read-only аналитических SQL переведена в один D1 batch без изменения SQL и формул. Подробная приёмка и команды переноса — в `docs/security-toolchain-upgrade.md`.

Exact bundle: Vinext `1.1.0`, Vite `8.3.4`, Cloudflare Vite plugin `1.63.1`, Wrangler `4.149.0`, Miniflare `5.20261006.1-alpha`, workerd `1.20261006.1`, workers-types `5.20261006.1`, plugin-rsc `0.5.36`, React/React DOM/RSC `19.2.8`. Next/eslint-config-next остаются `16.3.8`, plugin-react — `6.0.2`. Runtime compatibility date закреплена `2026-05-15`; inspector выключен через `inspectorPort: false`. Miniflare alpha входит в официальную SDK-цепочку, но требует отдельной совместимости/сохранности приёмки; его статус не скрывается.

Финальные scoped overrides: `satori → fflate 0.7.5` и `@esbuild-kit/core-utils → esbuild 0.28.2`. Функциональные проверки используют dependency из parent scope: zlib/ZIP Unicode и binary roundtrip, Node interoperability, sync/async TypeScript transform legacy loader, выполнение Drizzle config и source map metadata. SDK 5 уже включает undici `7.29.1` и sharp `0.35.5` без Miniflare overrides; native sharp проверен PNG encode/decode. Worker D1 interfaces импортируются как module types через `db/env.d.ts`; Worker globals не подменяют Node Buffer types.

Project adapter `scripts/miniflare-runtime.ts` использует официальный `convertV4MiniflareOptions`, после которого явно задаёт `resourcePersistencePath=<absolute state>/v3`, сохраняя D1 в `<state>/v3/d1`. Converter молча отбрасывает прежний `d1Persist`; raw `d1Persist` и относительные roots поэтому отклоняются fail-closed до открытия БД. SDK и Wrangler `--persist-to` должны читать один ledger. `CANDIDATE_CHECK_STATE_PATH` управляет runtime, тогда как ops-context использует `<workspace>/.wrangler/state`: перед действиями проверить реальные пути и symlink. Native Pool/HTTP настройки SDK не патчатся.

Выбранный SDK 5 разворачивать в fresh Miniflare 5 state через **актуальный** application SQL. Для этого существуют `scripts/sqlite-business-manifest.py export/capture/compare` и `scripts/initialize-transfer-state.ts`; последний отклоняет существующий target. До открытия трафика требовать сохранения всех **29 application tables** — 21 business, 7 derived, 1 runtime — и `sqlite_sequence`, включая повторное чтение нужным SDK. Synthetic SQL → fresh old SDK 4/new SDK 5 proof прошёл; окончательная Linux production clone/stage-проверка ещё требуется. Полный командный блок приведён в `docs/security-toolchain-upgrade.md`.

Stable Cloudflare `1.49.0`/Wrangler `4.116.0`/Miniflare `4.20260730.0` был рассмотрен как альтернатива и проходил Windows fixture с p95 266,6 мс. Matched Linux прогон выявил parallel RPC reset и у него, и у SDK 5; отключение keep-alive не помогло, точная upstream причина не установлена. В `lib/analytics-direct.ts` два связанных read-only SQL теперь выполняются одним `db.batch` для consistent snapshot; SQL/filters/формулы остаются прежними. Наблюдавшиеся обрывы обоих SDK устраняются, остальные business paths не меняются, blanket retry записей не добавлен.

**P2 capacity на VPS:** matched старый May SDK/исходная реализация завершил все 11 метрик, но overview p95 был **735,7 мс** при SLA 500. July 4 batch — **669 мс**; выбранный SDK 5 batch — **549,4 мс**, остальные 10 метрик ниже 500. Это улучшение примерно на четверть, но overview ещё выше SLA; Linux 10k/300k прогон не объявляется полным performance PASS. Локальный/CI gate остаётся **p95 ≤500 мс**, без снижения порога. Синтетические 10 000 попыток не являются текущими production counts.

Vendor persistence несовместимость доказана для SDK 5 и рассмотренного July SDK 4: новый `metadata.sqlite`/формат не читается прежним May Miniflare `4.20260515.0`, direct reopen возвращает `ERR_RUNTIME_FAILURE`. Schema 19/scoring не меняются, но это не гарантирует совместимость vendor state. **Code-only rollback 5 → old 4 и latest 4 → old 4 запрещён.** Переносить актуальный application SQL в fresh прежний SDK, не удалять vendor metadata на рабочем state и не подставлять snapshot поверх новых ответов, feedback, drafts/outbox. Финальная stage old-reader приёмка pending.

Проверки этого этапа доступны отдельно:

```powershell
npm run test:dependencies
npm run test:ops
npm run test:manifest
npm run test:persistence
npm run security:audit
```

`test:persistence` готовит изолированный Miniflare 4 fixture в `.data/security-upgrade/baseline-runtime`; старый SDK не добавляется в production dependencies. Все тестовые state синтетические. Проверка preservation должна охватывать свежие данные на момент cutover, а не только девять первоначальных попыток.

### Maintenance для stage и переключения

```powershell
# Изолированный stage: без background maintenance и startup backup retention.
$env:CANDIDATE_CHECK_MAINTENANCE_ENABLED = '0'
npm run preview -- --port 3102
```

После остановки stage убрать `CANDIDATE_CHECK_MAINTENANCE_ENABLED` из временного shell environment; для следующего штатного запуска использовать default `1` или установить его явно.

Production cutover закрыть временным Nginx admission `503`. Первый запуск fresh SDK 5 state — с maintenance `0`: по private доступу проверить readiness, все 29 application fingerprints/sequence и очередь. Затем остановить экземпляр, подтвердить отсутствие PID/FD writers и ошибок journal; перезапустить с maintenance `1` и grace `60000`, выполнить private smoke и только после этого снять admission. Через 60 секунд maintenance включится автоматически. Grace не блокирует foreground API и не откладывает startup backup retention, поэтому не заменяет admission barrier.

Enabled принимает только `0|1`, default `1`; start delay — целое `1..120000` мс, default `2000`. Неверная конфигурация останавливает wrapper до открытия runtime. SIGTERM/SIGINT передаются собственному POSIX child tree, зависшие descendants завершаются до освобождения lock. Windows stop path использует `taskkill /T /F`; Windows forced process kill не является доставкой POSIX signal. На DE VPS сохранять `KillMode=control-group`.

Переключать только при отсутствии active обычных/ИБ-попыток и после остановки всех writers; проверку повторить под admission. Снять свежий snapshot/manifest, использовать fresh target и проверенный forward/back SQL path. Failure любого этапа компенсировать восстановлением рабочего service/admission с сохранением актуальных данных; одного health 200 недостаточно. При откате сохранять post-cutover ответы, challenge/feedback, drafts/outbox, старый snapshot поверх новых данных не восстанавливать.

## Границы

Runbook рассчитан на один локальный экземпляр в `C:\Users\Admin\Documents\!python\checkbox_kandidat`. Команды не предназначены для cloud D1 без отдельной адаптации.

Секреты, имя кандидата, тексты вопросов и ответы нельзя копировать в issue, CI log или чат диагностики.

## Запуск

```powershell
Set-Location 'C:\Users\Admin\Documents\!python\checkbox_kandidat'
npm install
npm run questions:validate
npm run verify
npm run dev -- --port 3001
```

После старта проверить:

```powershell
Invoke-RestMethod http://localhost:3001/api/health/live
Invoke-RestMethod http://localhost:3001/api/health/ready
```

Ожидается `live.status=ok` и `ready.status=ready`. Код `telegram_misconfigured` означает, что новые тесты намеренно заблокированы; уже активные попытки продолжают работать.

### ИБ-челлендж

Локальный `npm run dev` включает челлендж по умолчанию. Wrapper задаёт `1`, если
переменная не установлена; для preview/production передавать `SECURITY_CHALLENGE_ENABLED=0|1`
явно и при сборке, и при запуске, сверяя запечённые public vars.
Проверка состояния не раскрывает вопросы или ответы:

```powershell
Invoke-RestMethod http://localhost:3001/api/challenges/infosec/config
```

Ожидаются `enabled=true`, `ready=true`, `totalTimeSeconds=900`, `questionTimeSeconds=60` и
ненулевой `poolSize`. При `ready=false` CTA скрыт, новые попытки не создаются; следует
проверить наличие активных leaf-вопросов со стабильным selection key категории
«Информационная безопасность» по всем четырём сложностям. Telegram для челленджа не нужен.

Попытки, события, отзывы и конфигурация хранятся в отдельных таблицах схемы 18 и входят в
штатный backup/restore. Завершённая история сохраняется для рейтинга и аналитики; фоновый
maintenance закрывает попытки, у которых истёк общий deadline. При быстром rollback
выключить флаг и перезапустить приложение — миграцию и накопленные данные оставлять на месте.

## Admin PIN и analytics

Admin-раздел не влияет на readiness candidate flow. Для его включения создать локальный `admin_pin.txt` с одной строкой из 4–12 цифр и перезапустить процесс. Файл игнорируется Git; PIN, его hash/salt и session secret запрещено выводить в логи или передавать через `VITE_*`.

Проверки после запуска:

1. `/admin/login` принимает корректный PIN и создаёт HttpOnly-сессию.
2. `/api/admin/analytics/overview` без cookie отвечает `401`.
3. До накопления выборки UI показывает «Недостаточно данных», а не искусственные метрики.
4. Logout инвалидирует локальную cookie; смена PIN требует перезапуска и автоматически инвалидирует старые сессии.

После нового завершённого теста analytics generation помечается устаревшим. Панель до пересчёта получает `409 analytics_refresh_required` и сохраняет кнопку «Обновить аналитику» как ручной fallback. Фоновый maintenance ждёт debounce `30 секунд`, объединяет несколько завершений и запускает не более одного rebuild за cooldown `3 минуты`. Auto и manual refresh используют общий persisted lease на `2 минуты`, поэтому два тяжёлых пересчёта не стартуют параллельно. Сам rebuild одной D1-транзакцией заменяет persisted aggregates; на наборе 10 000 / 300 000 он занимает примерно 12–16 секунд. Ошибка или generation race оставляет projection stale и последний целостный snapshot, а следующий допустимый maintenance-проход повторяет попытку. Candidate API пересчёт не вызывает и его результата не ждёт.

### Локальные demo-кандидаты

Для визуальной проверки аналитики на остановленном dev-сервере можно воспроизводимо
создать 50 полностью синтетических завершённых попыток:

```powershell
npm run db:demo:seed
npm run db:demo:seed -- --count 50 --seed candidate-check-v1.4-demo
```

Seed детерминированно перемешивает текущую D1-ревизию и выбирает штатным legacy
selector один base-план `5/7/7/1` с пятью вопросами на каждую из четырёх тем. Поэтому у
20 базовых вопросов накапливается ровно `n=50`; ошибки могут создавать только
одноуровневые remedial-вопросы, не более 10 на попытку. Результаты, тайминги и
вердикты детерминированы параметром `--seed`. Скрипт не создаёт Telegram outbox,
после записи проверяет exact-facts invariants и сразу перестраивает persisted analytics.

Повторный запуск атомарно заменяет только ранее созданный demo-набор. Явная очистка:

```powershell
npm run db:demo:clear
```

Demo-строки имеют внутренний marker `candidate_key=demo:v1:<sha256>` и обезличенный
alias; очистка требует одновременно marker точного формата, пустое `candidate_name`
и demo-alias. Обычные кандидаты и их данные в область удаления не входят. Seed и
cleanup используют общий runtime guard и откажутся работать одновременно с локальным
приложением.

## Обновление банка

1. Создать backup текущей D1.
2. Открыть `/admin/analytics` и вкладку «Банк вопросов».
3. Для нового материала выбрать «Новый вопрос»; для изменения текста, темы, сложности,
   контекста, вариантов или правильного ответа — «Создать новую редакцию».
4. Для временного исключения без изменения содержания использовать переключатель активности.
5. Для серии изменений использовать массовую операцию или «Черновики»: сначала preview, затем одну атомарную публикацию.
6. При импорте сначала выполнить «Проверить изменения»; наличие invalid-строки блокирует apply всего файла.
7. Проверить раздел «Контроль»: readiness, category × difficulty и тематические дефициты.
8. Проверить readiness в результате операции и `/api/health/ready`.
9. Создать и проверить контрольный backup после завершения серии изменений.

`db/questions.json` является только bootstrap-источником для пустой D1. После появления
`question_bank_state` рабочим источником истины становится D1; изменение JSON и перезапуск
не заменяют управляемую ревизию. Подробный workflow описан в
[`question-bank-admin.md`](question-bank-admin.md).

`questions:readiness` не выводит prompt, choices или correct answer. `NOT READY` legacy означает, что текущий тест и обязательный минимальный remedial reserve собрать нельзя. Для balanced `NOT READY` означает математическую невозможность одновременно выполнить topic/difficulty quotas и глобальную уникальность `dedupeKey`; недостаточный worst-case запас после допустимого base-plan остаётся `WARNING`, а не блокировкой candidate flow.

Если изменение отклонено, D1 и текущая ревизия остаются прежними. Не исправлять таблицы вручную:
скорректировать форму или восстановить проверенный backup при подтверждённом повреждении.
Активные попытки заморожены на своей `bankRevision`; новые редакции не подмешиваются в их
remedial-очередь.

## Ротация Telegram token

1. Остановить приложение.
2. Обновить только локальный `tg_token.txt`.
3. Запустить приложение заново.
4. Проверить readiness.
5. При согласованном внешнем smoke выполнить `npm run telegram:test`.

Не передавать token через аргументы CLI и не добавлять его в `.env` с префиксом `VITE_`.

Режим Telegram-отчёта задаётся до запуска: `TELEGRAM_REPORT_MODE=progress_errors` по умолчанию, `summary` отправляет только итог, `all_answers` используется только для диагностики. После изменения режима перезапустить dev-сервер.

Аварийный rollback Telegram:

```powershell
$env:TELEGRAM_ENABLED='0'
npm run dev
```

После устранения причины очистить переменную или открыть новый терминал и перезапустить сервер. Локальный maintenance consumer продолжит обработку outbox без участия браузера.

## Backup

```powershell
npm run ops:backup
npm run ops:backup:verify -- --from backups/<имя>.sql
```

Команда создаёт SQL export и manifest с SHA-256, версией схемы и агрегированными счётчиками, включая `question_categories`, `question_bank_change_sets` и `question_bank_change_set_items`. Verify импортирует backup во временную изолированную D1, выполняет `PRAGMA quick_check`, проверяет Unicode identity/selection keys категорий, структуру change sets и сравнивает счётчики.

Каталог `backups/` игнорируется Git и содержит чувствительные данные: свежий SQL export может включать имя кандидата и ещё не доставленный Telegram payload. Поэтому raw backup и `rollback-state-*` имеют жёсткий TTL 24 часа. Manifest явно содержит `containsSensitiveData=true` и `expiresAt`.

Очистка выполняется best-effort перед и после `ops:backup`, а также до запуска локального Worker при включённом maintenance. `CANDIDATE_CHECK_MAINTENANCE_ENABLED=0` отключает только startup очистку wrapper; explicit ops-команды сохраняют свою retention policy. Очистка удаляет только строго распознанные артефакты `candidate-check-<UTC>-<id>.sql`/`.manifest.json`, аварийные orphan-файлы того же точного формата и `rollback-state-<UTC>-<id>` непосредственно внутри `<workspace>/backups`. Symlink/junction, выход за разрешённый root и нестандартные имена не удаляются автоматически. Автоматическая очистка не выводит имена файлов.

Проверить политику без удаления:

```powershell
npm run ops:backup:retention
```

Явное применение (например, после долгого простоя без запуска приложения):

```powershell
npm run ops:backup:retention -- --apply
```

TTL применяется при следующем локальном запуске или ops-вызове: процесс не работает как фоновый системный scheduler при выключенном компьютере. До очистки каталог нужно хранить только на зашифрованном диске с ограниченным ACL; копирование raw backup в облако, Git или долговременный архив запрещено. Для длительного хранения требуется отдельный обезличенный export, которого в текущем roadmap нет.

## Retention

Dry-run безопасен при запущенном приложении:

```powershell
npm run ops:retention
```

Apply требует остановленного приложения:

```powershell
npm run ops:retention -- --apply
```

Политика:

- завершённые попытки и ответы автоматически не удаляются;
- активные брошенные и прерванные попытки старше 24 часов удаляются фоновым maintenance
  при работающем приложении; `ops:retention -- --apply` остаётся проверяемым ручным контуром;
- оставшийся outbox payload очищается через 24 часа; имена active/aborted попыток следуют той же abandoned-политике, а имя завершённого кандидата сохраняется для административного отчёта;
- ручной `ops:retention -- --apply` сначала создаёт и проверяет backup;
- фоновый maintenance очищает только просроченные служебные данные по своей узкой политике и отдельный backup не создаёт.
- apply очищает derived analytics tables и требует пересчёта через admin UI после следующего входа.

Ручное удаление по дате или точному UUID всегда начинается с dry-run:

```powershell
npm run ops:retention -- --before 2026-01-01
npm run ops:retention -- --attempt <UUID>
```

Для применения добавить `--apply`; приложение должно быть остановлено. Это удаление невосстановимо без созданного командой backup.

## Эксплуатационная проверка аналитики

```powershell
npm run analytics:explain
npm run test:analytics:performance
```

`analytics:explain` проверяет планы raw rebuild и persisted-read запросов. Benchmark использует изолированную синтетическую D1 с 10 000 попыток и 300 000 answer facts, не читает рабочие имена, вопросы или ответы. Он сначала фиксирует негейтящий direct baseline (три чтения до rebuild), затем делает один явный rebuild и измеряет основные persisted-отчёты и A/B ревизий; целевой p95 persisted reads — не более 500 мс.

Baseline 2026-08-28: raw overview `p95 847,9 мс`, raw question-list `p95 3 590 мс`, rebuild `13,33 с`, persisted reads `p95 20,9–220,2 мс`. Поэтому stale API не переключается на raw fallback: до успешного фонового либо ручного atomic refresh он отвечает `409 analytics_refresh_required`, сохраняя предсказуемый SLA и целостный предыдущий snapshot.

## CI, защита `main` и dependency audit

GitHub Actions запускает единый job `verify` для `push` и `pull_request`. В настройках branch protection для `main` следует включить required status check `verify` и требование актуальной ветки перед merge. Релиз или прямой push в `main` не считается завершённым, пока удалённый `verify` не стал зелёным; локальный успешный запуск не заменяет GitHub check.

Workflow использует `actions/checkout@v7` и `actions/setup-node@v7`. Версия runtime приложения и quality gate читается из `.node-version` и сейчас зафиксирована на Node.js `24.20.0` LTS; `package.json` допускает совместимые обновления внутри major 24, но переход на следующий major выполняется только отдельным проверенным изменением.

Перед `verify` GitHub Actions создаёт 160 синтетических вопросов через `scripts/prepare-ci-question-bank.ts`: четыре канонические темы, все сложности и отдельный достаточный ИБ-пул. Helper требует `CI=true` и `GITHUB_ACTIONS=true`, создаёт игнорируемый `db/questions.json` через `wx` и никогда не читает/перезаписывает существующий банк. Приватный production банк не нужен и не загружается в CI. Общий job ограничен 30 минутами; функциональные и performance assertions сохранены.

Security gate учитывает полный dependency graph, включая production toolchain из devDependencies:

```powershell
npm audit --omit=dev
npm run security:audit
```

Для подготовленного 1.7.1 `--omit=dev` равен нулю, а полный audit содержит **8 high package entries от одного GHSA braces**, без опубликованного исправления: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). `scripts/dependency-audit-policy.ts` принимает только точный рассмотренный advisory/graph, installed paths и lockfile versions. Новое advisory, иной package/edge/version, ошибка audit, повреждённый отчёт или истечение исключения блокируют выпуск. Severity threshold не снижается; полный audit не называется нулевым.

Исключение build/lint glob chains действует до **10 ноября 2026, 03:00 МСК** (`2026-11-10T00:00:00Z`), на этой границе gate уже завершается ошибкой и блокирует выпуск. До срока пересмотреть опубликованное исправление либо безопасное удаление цепочки; срок не продлевать автоматически. `npm audit fix --force` не применять: он предлагает несовместимые downgrade ESLint/Drizzle и широкое изменение toolchain. `verify` включает оба audit gate, functional overrides checks, Miniflare/persistence и manifest tests; его финальный результат для 1.7.1 ещё должен быть подтверждён.

## Restore

Restore — разрушительная операция относительно текущего состояния, поэтому приложение должно быть остановлено. Project-local PID lock блокирует restore и purge при любом экземпляре, запущенном через `npm run dev/start/preview`, независимо от выбранного порта; дополнительные health-probes покрывают стандартные порты `3000/3001`:

```powershell
npm run ops:restore -- --from backups/<имя>.sql --apply
```

Перед заменой текущей D1 команда:

1. проверяет выбранный backup;
2. создаёт и проверяет pre-restore backup;
3. переносит текущий state в `backups/rollback-state-*`;
4. импортирует SQL, немедленно применяет 24-часовую privacy/abandoned policy и запускает integrity checks;
5. автоматически возвращает прежний state при ошибке retention или проверки.

После restore запустить приложение и проверить live, ready, leaderboard и одну тестовую попытку с отключённым Telegram.

`ops:restore` намеренно применяет privacy/retention и потому не используется для переноса toolchain с точным сохранением всех строк. Для SDK 5 экспортировать актуальный application SQL, инициализировать fresh target нужным SDK, импортировать напрямую в SQLite и сравнить `--scope application`, включая sequence; процедура находится в `docs/security-toolchain-upgrade.md`. При rollback к May Miniflare 4 direct reader несовместим; это также доказано для рассмотренного July SDK 4. Простое переключение старого кода на state нового SDK запрещено независимо от неизменной managed schema 19.

Rollback-state предназначен только для немедленного отката и автоматически удаляется по тому же 24-часовому TTL. Если откат нужен, его следует выполнить до истечения этого окна; превращать state-каталог в архив нельзя.

## Диагностика outbox

Разрешено смотреть только агрегаты через локальные инструменты. Не выводить `payload_text` и `candidate_name`.

Искать нужно:

- рост `pending` — Telegram недоступен, cooldown группы или нет flush-трафика;
- рост `dead` — неверный token/chat ID, бот удалён из группы или Telegram вернул постоянную ошибку;
- `telegram_root_missing` — не удалось доставить корневую карточку, поэтому зависимое обновление или ответ безопасно пропущены;
- `superseded` — промежуточное обновление прогресса заменено более свежим, это штатное состояние;
- `attempt_count >= 10` — событие исчерпало retry budget;
- readiness `telegram_misconfigured` — файл отсутствует, содержит неоднозначные значения или Worker не получил bindings.

Maintenance endpoint закрыт случайным server-only token, который создаётся при каждом локальном запуске и не записывается на диск. Не публиковать endpoint отдельно и не проксировать его без access-control. Для будущего Cloudflare deploy потребуются отдельный secret `MAINTENANCE_TOKEN`, несекретный `TELEGRAM_CONFIG_STATUS=ready` и Cron/внешний scheduler; локальная Node-обёртка в cloud runtime не работает.

## Критерии штатного состояния

- live и ready отвечают 200;
- `npm run verify` проходит;
- удалённый required check `verify` для текущего commit в `main` зелёный;
- `npm run questions:validate` проходит на текущем банке;
- последний backup проходит verify;
- pending outbox не растёт после завершённых тестов;
- token отсутствует в Git, client bundle, логах и API-ответах.
