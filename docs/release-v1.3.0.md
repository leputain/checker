# Candidate Check v1.3.0 — пакетное управление банком

## Результат

Административная панель больше не ограничена правкой одного вопроса. Администратор может управлять справочником категорий, собирать и проверять пакет изменений, импортировать до 250 вопросов, публиковать пакет одной ревизией и сразу видеть покрытие банка.

## Основные изменения

- Unicode-aware категории с уникальным нормализованным именем и стабильным `selectionKey`;
- immutable rename/merge: актуальные вопросы получают successor-ID, historical facts не переписываются;
- массовые изменения темы, сложности и активности одной атомарной revision;
- read-only import preview, детерминированный diff и идемпотентное apply;
- атомарные change sets с `baseRevision`, собственной CAS-версией, preview, publish и conflict recovery;
- детерминированный bank export текущих leaf-вопросов;
- coverage matrix category × difficulty и readiness/deficit indicators;
- quality queue с deep-link к карточке вопроса;
- iPad portrait/landscape интерфейс без page-level horizontal overflow;
- backup/verify/restore для категорий и change sets.

## Совместимость

- схема расширяется миграцией `0018`; destructive rollback отсутствует;
- существующий D1 catalog строится при первом запуске из current leaf snapshot;
- старые question revisions, attempts и analytics facts остаются читаемыми;
- rename не меняет тематическую квоту благодаря стабильному selection key;
- frozen attempt продолжает отбор и remedial по своей bank revision;
- JSON-файл остаётся только bootstrap-источником пустой базы.

## Безопасность и атомарность

- все mutation endpoints требуют admin session и CSRF; операции банка дополнительно используют expected revision и idempotency key;
- category rename/merge и изменение/publish/discard черновика имеют собственные optimistic tokens, поэтому две вкладки не работают в режиме last-write-wins;
- preview endpoints не записывают вопросы, snapshots, аудит или mutation ledger;
- invalid item, stale revision или неизвестная/неактивная категория откатывают весь пакет;
- bank export доступен только администратору и не содержит PIN, cookie, Telegram credentials/payload или кандидатские данные;
- лимит 250 операций и единый предел 2 MB для одиночных и пакетных mutations защищают локальный Worker/D1 от неограниченного payload.

## Проверки релиза

- unit: Unicode normalization, category collision, coverage и deterministic import diff;
- API/E2E: category create/rename/merge, strict catalog, immutable bulk и atomic failure;
- import: 130-row preview/apply, no-write preview, stable diff и idempotent retry;
- change sets: preview, atomic publish, stale-version и транзакционные race-conflicts без частичной записи;
- export: current leaf only, stable ID order/revision timestamp и отсутствие секретов;
- selection: rename required category сохраняет coverage и balanced quota, frozen revision не ломается;
- ops: migration, backup manifest, integrity, restore и workflow tables;
- WebKit: iPad portrait/landscape, все пять разделов и отсутствие page overflow;
- полный `npm run verify`.

## Откат

До первой v1.3 mutation можно вернуть предыдущий код после остановки приложения. После появления категорий или change sets откат приложения поверх рабочей D1 запрещён: остановить процесс и восстановить проверенный pre-v1.3 backup. Удалять migration/table вручную нельзя.
