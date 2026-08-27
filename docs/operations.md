# Candidate Check v0.5.1: локальный runbook

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

## Обновление банка

1. Создать backup текущей D1.
2. Изменить `db/questions.json`.
3. Для смысловой новой редакции назначить новый `id`; старую сделать `active: false`.
4. Альтернативным формулировкам одной концепции назначить одинаковый `dedupeKey`.
5. Выполнить `npm run questions:validate`.
6. Перезапустить dev-сервер.
7. Проверить `/api/health/ready` и локальную `npm run questions:stats`.

Если новый банк повреждён, не исправлять D1 вручную. Вернуть предыдущий JSON, перезапустить приложение и повторить readiness. Активные попытки используют уже сохранённые вопросы и не должны быть потеряны.

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

Каталог `backups/` игнорируется Git и содержит чувствительные данные. Хранить его нужно на зашифрованном диске с ограниченным доступом.

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

- завершённые попытки удаляются через 180 дней;
- незавершённые попытки удаляются через 24 часа;
- оставшийся outbox payload и имя кандидата очищаются через 24 часа фоновым maintenance consumer (при выключенном компьютере — сразу после следующего запуска);
- до удаления автоматически создаётся и проверяется backup.

## Restore

Restore — разрушительная операция относительно текущего состояния, поэтому приложение должно быть остановлено:

```powershell
npm run ops:restore -- --from backups/<имя>.sql --apply
```

Перед заменой текущей D1 команда:

1. проверяет выбранный backup;
2. создаёт и проверяет pre-restore backup;
3. переносит текущий state в `backups/rollback-state-*`;
4. импортирует SQL и запускает `PRAGMA quick_check`;
5. автоматически возвращает прежний state при ошибке.

После restore запустить приложение и проверить live, ready, leaderboard и одну тестовую попытку с отключённым Telegram.

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
- `npm run questions:validate` проходит на текущем банке;
- последний backup проходит verify;
- pending outbox не растёт после завершённых тестов;
- token отсутствует в Git, client bundle, логах и API-ответах.
