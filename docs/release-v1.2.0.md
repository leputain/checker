# Candidate Check v1.2.0

## Результат

Административная панель перестаёт быть только экраном аналитики: администратор может просматривать полный банк, создавать вопросы, выпускать неизменяемые редакции, менять тему и сложность через новую редакцию, управлять активностью и просматривать историю.

## Изменения

- D1 становится источником истины после однократного bootstrap из локального JSON.
- Добавлены current bank state, связи редакций и журнал операций.
- Любое изменение canonical content получает новый question ID; старая редакция сохраняется неактивной.
- Каждая mutation атомарно создаёт SHA-256 revision и полный membership snapshot.
- Добавлены фильтры, поиск, карточка вопроса, создание, редакция, activation toggle и history в iPad-first admin UI.
- Добавлены optimistic concurrency и идемпотентный повтор mutation после сетевой неопределённости.
- Пагинация привязана к bank revision, а запросы редактора имеют 12-секундный deadline и безопасный повтор с тем же idempotency key.
- Старт и remedial читают membership сохранённой ревизии, поэтому административная правка не меняет уже активную попытку.
- Все mutation endpoints используют существующие HttpOnly admin session, same-origin check и CSRF token.
- Upgrade переносит в current state только membership последней дорелизной ревизии, не возвращая исторические orphan-строки.
- Backup/restore охватывает новые operational tables и проверяет state cardinality, canonical content hashes и bank revision hash.

## Совместимость

- Завершённые попытки, answers и analytics facts не пересчитываются.
- Старые question ID не удаляются и продолжают разрешаться в исторических отчётах.
- `db/questions.json` не перезаписывается из браузера и не используется как источник истины после bootstrap.
- Candidate flow и Telegram outbox не зависят от доступности admin UI.

## Проверки релиза

- unit/integration: create, revise, toggle, history, validation, conflicts и idempotency;
- security: auth, CSRF, безопасные ошибки и отсутствие секретов/ключей в analytics export;
- persistence: restart, backup, verify и restore;
- WebKit iPad portrait/landscape: просмотр, поиск, создание, редакция, смена темы/сложности, toggle и конфликт;
- полный `npm run verify`.

## Откат

До первого изменения через UI можно вернуть предыдущую версию приложения без преобразования данных. После появления D1-managed revision откат приложения не должен запускаться поверх рабочей базы: сначала остановить процесс и восстановить проверенный pre-v1.2 backup. Destructive downgrade migration не предусмотрена.
