# ИБ-челлендж: согласованная спецификация и план внедрения

## Статус

Продуктовые правила согласованы и реализованы 2026-09-01 в релизе `v1.6.0`.
Документ остаётся контрактом additive-внедрения без изменения поведения кандидатского
теста. Перед эксплуатационным пилотом требуется содержательная SME-проверка ИБ-вопросов:
автоматические проверки подтверждают структуру и алгоритмы, но не заменяют экспертную
валидацию формулировок и правильных ответов.

## Цель

Добавить отдельный внутренний режим для специалистов по информационной безопасности:

- 15 минут на попытку;
- 60 секунд на вопрос;
- фиксированного количества вопросов нет;
- используются только вопросы ИБ;
- результат можно завершить вручную;
- показывается полный разбор отвеченных вопросов;
- ведутся отдельные рейтинг и административная аналитика.

Режим предназначен для запуска из одного доверенного места и не публикуется в общий доступ.

## Зафиксированные продуктовые решения

- Участник вводит свободный ник без OIDC, invite-кода и корпоративной идентификации.
- Повторные попытки не ограничиваются; cooldown и attempt cap отсутствуют.
- В рейтинге хранится лучший результат нормализованного ника внутри одной когорты.
- Для попадания в рейтинг требуется не менее 5 разрешённых вопросов.
- Ручное завершение с 5 и более разрешёнными вопросами участвует в рейтинге.
- Показанный, но не отправленный вопрос при ручном завершении не считается ошибкой.
- Таймаут вопроса и текущего вопроса при общем deadline считается неправильным ответом.
- Demo-вопрос обязателен, не влияет на счёт и не запускает общий deadline.
- Telegram для челленджа полностью отключён.
- Аналитика челленджа добавляется в admin отдельным контуром и не смешивается с кандидатской.
- После завершения доступен полный разбор всех разрешённых вопросов.
- Вопросы не повторяются внутри попытки ни по `question_id`, ни по `dedupe_key`.

Свободный ник не является идентичностью: одинаковые нормализованные ники считаются одним
участником, а подмена ника технически возможна. Для доверенного single-location запуска этот
риск принят явно.

## Scoring v1

### Веса сложности

| Сложность | Вес `w` |
|---|---:|
| `easy` | 1 |
| `medium` | 2 |
| `hard` | 3 |
| `expert` | 4 |

Кандидатский вес `expert=10` не используется: в коротком случайном челлендже один такой вопрос
слишком сильно влиял бы на рейтинг.

### Защита от угадывания

Для вопроса с `n` вариантами:

```text
правильный ответ:  +3 × w
ошибка или timeout: −3 × w / (n − 1)
```

Математическое ожидание случайного выбора равно нулю. Быстрый перебор вариантов поэтому не
даёт систематического преимущества.

В БД используется целочисленный `score_units`:

```text
правильный ответ:  +300 × w
ошибка или timeout: −300 × w / (n − 1)
отображаемые очки: score_units / 100
```

Число 300 делится на `1..5`, поэтому для допустимых 2–6 вариантов округление не требуется.
Score может быть отрицательным и не ограничивается нулём: clamp снова сделал бы угадывание
выгодным. Speed bonus отсутствует.

### Порядок рейтинга

1. `score_units DESC`;
2. `correct_count DESC`;
3. `(incorrect_count + timeout_count) ASC`;
4. `timeout_count ASC`;
5. `completed_at ASC`.

Длительность не является tie-breaker: ручное раннее завершение не должно получать скрытый бонус.

## Выбор вопросов

Источник — зафиксированная при старте ревизия банка. Предикат выбора:

```sql
membership.revision_hash = :bank_revision
AND membership.active = 1
AND category.selection_key = 'Информационная безопасность'
```

Нельзя использовать отображаемое имя категории, `LIKE` или текущую ревизию вместо frozen
revision.

Сложности выдаются повторяющимися блоками:

```text
3 easy + 3 medium + 3 hard + 1 expert
```

Порядок десяти слотов внутри каждого блока перемешивается. Внутри сложности вопросы выбираются
случайно с приоритетом менее показанных. Ответы детерминированно перемешиваются для сочетания
attempt/question; canonical mapping остаётся только на сервере.

Если следующий полный блок собрать без повторов нельзя, попытка завершается с
`completion_reason=pool_exhausted`. Повторный цикл уже показанных вопросов не запускается.

## Таймеры и состояния

Сервер является единственным источником истины:

```text
total_deadline_at = started_at + 900 секунд
question_deadline_at = min(question_started_at + 60 секунд, total_deadline_at)
```

Demo выполняется до создания серверной попытки. После demo пользователь подтверждает старт,
проходит отсчёт `3 → 2 → 1`, и только затем создаётся attempt.

Целевая state machine:

```text
intro → demo → countdown → starting → active
active → submitting → active(next)
active → question_timeout → active(next)
active → finish_confirm → completed(manual)
active → total_timeout → completed(total_timeout)
active → completed(pool_exhausted)
```

`answer`, `finish` и timeout используют единый CAS-механизм. Повторный запрос идемпотентен;
гонка не может создать второй ответ или второй следующий вопрос. Закрытые вкладки завершаются
фоновым maintenance settlement.

## Полный разбор

До terminal-состояния API не возвращает:

- правильный индекс;
- `isCorrect`;
- delta очков;
- running score, из которого можно вывести правильность.

После завершения token-authenticated endpoint с `Cache-Control: no-store` возвращает для каждого
разрешённого вопроса:

- формулировку и контекст;
- варианты в реально показанном порядке;
- выбранный и правильный ответ;
- outcome, сложность и изменение score;
- затраченное время.

Текущий `manual_finish_unanswered` показывается как «не учитывался», но правильный ответ для него
не раскрывается: бесплатная остановка не должна выдавать ключ следующего вопроса.

В разборе добавляется действие «Отметить спорным» с коротким комментарием. Обращение попадает
в отдельную admin-очередь; исправление вопроса выполняется штатной immutable-редакцией банка.
Подробное rationale/source выводится только если соответствующие versioned-поля будут добавлены
в модель вопроса. Без них экран честно называется «Разбор ответов», а не «Объяснение».

Полный review вместе с неограниченными повторными попытками позволяет постепенно выучить банк.
Для доверенного внутреннего режима этот продуктовый риск принят. В calibration-аналитику поэтому
попадает только первая встреча пары `participant_key + question + pool_revision`.

## Ник и когорта

Ник:

- Unicode NFKC;
- trim и сворачивание пробелов;
- 2–32 символа;
- отклонение control и bidi-control символов;
- сравнение в lowercase `ru-RU`;
- React escaping обязателен.

`participant_key` вычисляется как SHA-256 от namespaced нормализованного ника. В API и UI ключ
не возвращается.

Когорта рейтинга определяется сочетанием:

```text
challenge_config_id + scoring_version + pool_revision
```

`pool_revision` является SHA-256 только ИБ-пула, поэтому изменение Linux-вопроса не сбрасывает
ИБ-рейтинг. Изменение формулы или состава ИБ-пула начинает новую когорту; история сохраняется.

## Архитектура хранения и API

Рекомендуемый отдельный bounded context:

- `security_challenge_configs`;
- `security_challenge_attempts`;
- `security_challenge_question_events`;
- `security_challenge_feedback`;
- отдельные агрегаты challenge analytics.

Общими остаются только управляемый question bank, bank revisions, category selection identity,
token/start-key helpers и детерминированная permutation вариантов.

API:

```text
POST /api/challenges/infosec/attempts
GET  /api/challenges/infosec/attempts/:id
POST /api/challenges/infosec/attempts/:id/answer
POST /api/challenges/infosec/attempts/:id/finish
GET  /api/challenges/infosec/attempts/:id/review
POST /api/challenges/infosec/attempts/:id/feedback
GET  /api/challenges/infosec/leaderboard?period=today|all
```

Product rate limit, cooldown и attempt cap не добавляются. При этом обязательны body limits,
schema validation, token hash, idempotency, CAS и безопасные SQL bindings: это инварианты
целостности, а не ограничения пользователя.

## Отдельная admin-аналитика

### Overview

- starts/completed/active;
- причины завершения;
- уникальные ники и повторные попытки;
- mean/median/p90 score;
- correct/incorrect/timeout/answered/accuracy;
- response time и duration;
- число попыток на ник.

### Рейтинг и попытки

- best/all attempts;
- фильтры по нику, дате, config и pool revision;
- карточка попытки и полный review;
- CSV/JSON export без bearer token и внутренних participant keys.

### Вопросы и сложность

- presentations и first-exposure outcomes;
- correct/incorrect/timeout;
- median/p90 response time;
- net score contribution;
- selection distribution;
- discrimination после достаточной выборки;
- очередь спорных вопросов и статус resolution.

Operational-срез использует все попытки. Calibration-срез использует только первую встречу
вопроса участником внутри когорты, иначе unlimited retries и review исказят качество вопросов.

## Этапы внедрения

### P0 — данные и контракты

- Добавить challenge readiness и scoped pool revision.
- Провести SME-review активного ИБ-пула.
- Разобрать повторяющиеся `dedupe_key`-группы.
- Зафиксировать config/scoring/selection identity тестами.

### P1 — backend

- Additive migration новых таблиц и индексов.
- Реализовать selector, engine, CAS и settlement.
- Добавить start/get/answer/finish/review/feedback API.
- Реализовать отдельный leaderboard.
- Подключить backup/restore/retention/integrity checks.

### P2 — frontend

- Добавить CTA и отдельный маршрут `/challenge`.
- Вынести общие timer/dialog/question primitives из монолитной страницы кандидата.
- Реализовать demo, countdown, active state, finish, result, review и leaderboard.
- Разделить persisted sessions candidate/challenge.
- Добавить challenge-вкладку и feedback queue в admin.

### P3 — аналитика и rollout

- Реализовать operational/calibration агрегаты и refresh.
- Добавить unit, D1 integration и WebKit E2E.
- Deploy с выключенным `SECURITY_CHALLENGE_ENABLED`.
- Проверить backup, migration, hidden smoke и только затем включить CTA.

## Критерии приёмки

- Candidate flow, scoring, analytics, Telegram и leaderboard не изменились.
- Сервер применяет ровно 900/60 секунд и не доверяет клиентскому времени.
- Выбираются только ИБ-вопросы frozen revision.
- В попытке нет повторов `question_id` и `dedupe_key`.
- Anti-guess score имеет нулевое ожидание случайного выбора для 2–6 вариантов.
- `answer/answer`, `answer/finish`, `finish/timeout` проходят race-тесты.
- Manual unanswered не штрафуется и не раскрывает correct answer.
- Timeout штрафуется ровно один раз.
- Рейтинг хранит лучший eligible-результат ника только внутри challenge cohort.
- Review недоступен до terminal state и доступен только по attempt token.
- Challenge rows не попадают в candidate analytics или Telegram outbox.
- Admin operational и first-exposure calibration дают разные воспроизводимые срезы.
- Backup/restore/retention и полный `npm run verify` проходят.

## Rollback

- Выключить `SECURITY_CHALLENGE_ENABLED` и скрыть CTA.
- Новые старты блокируются; активные попытки штатно завершаются или settle-ятся maintenance.
- Additive-таблицы и накопленные данные не удаляются.
- Candidate runtime продолжает работать без down migration.
