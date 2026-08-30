# Candidate Check v1.0.0: локальный runbook

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

## Admin PIN и analytics

Admin-раздел не влияет на readiness candidate flow. Для его включения создать локальный `admin_pin.txt` с одной строкой из 6–12 цифр и перезапустить процесс. Файл игнорируется Git; PIN, его hash/salt и session secret запрещено выводить в логи или передавать через `VITE_*`.

Проверки после запуска:

1. `/admin/login` принимает корректный PIN и создаёт HttpOnly-сессию.
2. `/api/admin/analytics/overview` без cookie отвечает `401`.
3. До накопления выборки UI показывает «Недостаточно данных», а не искусственные метрики.
4. Logout инвалидирует локальную cookie; смена PIN требует перезапуска и автоматически инвалидирует старые сессии.

После нового завершённого теста analytics generation помечается устаревшим. Панель до пересчёта получает `409 analytics_refresh_required` и сохраняет кнопку «Обновить аналитику» как ручной fallback. Фоновый maintenance ждёт debounce `30 секунд`, объединяет несколько завершений и запускает не более одного rebuild за cooldown `3 минуты`. Auto и manual refresh используют общий persisted lease на `2 минуты`, поэтому два тяжёлых пересчёта не стартуют параллельно. Сам rebuild одной D1-транзакцией заменяет persisted aggregates; на наборе 10 000 / 300 000 он занимает примерно 12–16 секунд. Ошибка или generation race оставляет projection stale и последний целостный snapshot, а следующий допустимый maintenance-проход повторяет попытку. Candidate API пересчёт не вызывает и его результата не ждёт.

## Обновление банка

1. Создать backup текущей D1.
2. Открыть `/admin/analytics`, вкладки «Вопросы» → «Банк вопросов».
3. Для нового материала выбрать «Новый вопрос»; для изменения текста, темы, сложности,
   контекста, вариантов или правильного ответа — «Создать новую редакцию».
4. Для временного исключения без изменения содержания использовать переключатель активности.
5. Проверить readiness в результате операции и `/api/health/ready`.
6. Создать и проверить контрольный backup после завершения серии изменений.

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

Команда создаёт SQL export и manifest с SHA-256, версией схемы и агрегированными счётчиками. Verify импортирует backup во временную изолированную D1, выполняет `PRAGMA quick_check` и сравнивает счётчики.

Каталог `backups/` игнорируется Git и содержит чувствительные данные: свежий SQL export может включать имя кандидата и ещё не доставленный Telegram payload. Поэтому raw backup и `rollback-state-*` имеют жёсткий TTL 24 часа. Manifest явно содержит `containsSensitiveData=true` и `expiresAt`.

Очистка выполняется best-effort перед и после `ops:backup`, а также до запуска локального Worker. Она удаляет только строго распознанные артефакты `candidate-check-<UTC>-<id>.sql`/`.manifest.json`, аварийные orphan-файлы того же точного формата и `rollback-state-<UTC>-<id>` непосредственно внутри `<workspace>/backups`. Symlink/junction, выход за разрешённый root и нестандартные имена не удаляются автоматически. Автоматическая очистка не выводит имена файлов.

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
- оставшийся outbox payload и имя кандидата очищаются через 24 часа фоновым maintenance consumer (при выключенном компьютере — сразу после следующего запуска);
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

Workflow использует `actions/checkout@v7` и `actions/setup-node@v7`: это актуальные стабильные major с внутренним Node.js 24 runtime. Версия Node.js приложения и quality gate намеренно остаётся зафиксированной на `22.13.0` — runtime самой Action и тестируемый runtime проекта являются разными контурами.

Production security gate:

```powershell
npm audit --omit=dev
```

На контрольном прогоне 2026-08-28 результат: `0` production vulnerabilities. Полный `npm audit` дополнительно сообщает advisories в локальном build/test toolchain (`Cloudflare/Vite`, `vinext`, `react-server-dom-webpack` и legacy loader внутри `drizzle-kit`). Они отсутствуют в production dependency graph, поэтому не исправляются через `npm audit fix --force`: такой вызов предлагает несовместимый downgrade/широкое обновление инструментов и создаёт больший риск для проверенного runtime. Их нужно пересматривать отдельным совместимым toolchain upgrade с полным `npm run verify`; production advisory, если появится в `--omit=dev`, является блокером релиза.

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
