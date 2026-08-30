# Candidate Check Analytics

## Назначение

Analytics использует только попытки с `analytics_facts_version = 1`. Исторические попытки остаются доступны в обычном результате и рейтинге, но не смешиваются с точными фактами после cutover.

Когорта однозначно задаётся сочетанием:

```text
scoring_version + test_config_id + bank_revision + test_profile_id
```

`app_version` — диагностический фильтр, а не часть статистической модели. Для калибровки по умолчанию берётся последняя завершённая попытка каждого `candidate_key` внутри каждой когорты. Ранжирование выполняется до фильтра периода и `app_version`: старая попытка не становится «последней» только потому, что новая оказалась вне выбранного окна.

## Модель фактов

`attempt_questions` — журнал назначения и серверного предъявления:

- 20 базовых строк создаются атомарно со стартом попытки;
- `presented_at` означает, что сервер сделал вопрос текущим;
- дополнительный вопрос фиксируется в момент назначения и ссылается на ошибочный базовый через `source_question_id`;
- непоказанный дополнительный остаётся назначенным, но не получает answer;
- базовый вопрос, материализованный общим тайм-аутом, получает answer с `total_timeout_unshown`, сохраняя `presented_at = NULL`.

`answers.answer_origin` принимает только:

```text
submitted
question_timeout
total_timeout_presented
total_timeout_unshown
unknown
```

Качество вопросов считает только реальные предъявления. `total_timeout_unshown` участвует в итоговой accuracy кандидата, но не входит в calibration outcomes, timing или distractor analysis.

`canonical_selected_index` хранит индекс исходного варианта до детерминированного перемешивания UI. `awarded_score` хранит фактическую дельту score с учётом cap `100`.

## Версии конфигурации

`test_config_versions.id` — SHA-256 canonical JSON. В snapshot входят:

- difficulty plan и unit weights;
- base/additional multipliers;
- таймеры;
- verdict thresholds;
- remedial policy и лимит;
- selection policy.

Настройки отображения аналитики и sample gates в hash не входят.

Профили:

- `general-v1` — текущий selector по difficulty и dedupe;
- `general-balanced-v2` — по 5 вопросов из четырёх тем, difficulty `5/7/7/1`, exposure-aware Coverage Score.

Balanced selector выключен по умолчанию, shadow calculation включён. Если точный тематический набор собрать нельзя, применяется проверенный selector v1.

## Admin-доступ

Создайте в корне игнорируемый Git файл `admin_pin.txt` с одной строкой из 6–12 цифр и перезапустите dev-сервер. Node-обёртка передаёт Worker только PBKDF2-SHA256 hash, случайную salt и отдельный случайный session secret. Исходный PIN не попадает в Worker bindings, D1, bundle или логи.

Сессия:

- HttpOnly, `SameSite=Strict`, 8 часов;
- unsafe-запросы требуют same-origin и session-bound CSRF token;
- после пяти ошибок вход блокируется на 15 минут;
- отсутствие PIN отключает только `/admin`, candidate flow продолжает работать.

Runtime flags:

```text
ANALYTICS_ENABLED=1
BALANCED_SELECTION_ENABLED=0
BALANCED_SELECTION_SHADOW=1
CALIBRATION_ENABLED=1
ANALYTICS_EXPORT_ENABLED=1
```

## Метрики

Пользовательские определения, знаменатели, уровни достоверности и правила интерпретации зафиксированы в [`analytics-metrics.md`](analytics-metrics.md). Начиная с v1.1.0 факты и статистический вывод разделены: абсолютные счётчики и наблюдаемые доли видны при любой выборке, а статус и рекомендация ограничиваются sample gates.

Формулы вопроса:

```text
outcomes       = correct + incorrect + timeout
successRate    = correct / outcomes
timeoutRate    = timeout / outcomes
completionRate = outcomes / presentations
```

Timing использует только `answer_origin = submitted`. Порог предупреждений — `n >= 30`, индекс качества — `n >= 50`, point-biserial discrimination — `n >= 100` и только при ненулевой variance. В интерфейсе `n < 30` называется «Мало данных», `30–49` — «Первичный сигнал», `50–99` — «Рабочая оценка», `100+` — «Стабильная оценка».

Ожидаемые success ranges:

| Difficulty | Диапазон |
|---|---:|
| easy | 75–95% |
| medium | 55–80% |
| hard | 30–60% |
| expert | 10–40% |

Индекс качества не нормализует отсутствующие компоненты. API возвращает `earned`, `maxAvailable` и `partial`: например, `58/80` остаётся `58/80`, а не превращается в процент от 100. Статусы: `good >= 75` без critical warning, `observe 50–74`, `review < 50` либо critical warning; при `n < 50` — `insufficient`. Рекомендация `keep` при `n < 50` запрещена.

Список вопросов использует серверный поиск, сортировку, фильтры и пагинацию. `totalCount` и summary относятся ко всей отфильтрованной выборке, а не только к загруженной странице. По умолчанию вопросы сортируются по необходимости внимания.

Калибровка, discrimination и рекомендации применяются только к базовым вопросам и политике `latest`. Дополнительные вопросы показываются как recovery sample. При `questionKind=all` общие счётчики включают обе роли, а Quality Score рассчитывается только по базовому split.

## Persisted aggregates

Raw facts в `attempts`, `attempt_questions` и `answers` остаются источником истины. Быстрые отчёты читают идемпотентно перестраиваемые `analytics_candidate_aggregates`, `analytics_candidate_dimensions` и daily question/choice/timing aggregates.

Агрегаты строятся для политик `all` и global `latest`, с московской календарной датой и timing buckets `0..30`. После изменения завершённых попыток generation становится stale, API отвечает `409 analytics_refresh_required`, а admin UI сохраняет кнопку «Обновить аналитику». Фоновый maintenance выполняет controlled auto-refresh: debounce `30 секунд`, cooldown `3 минуты`, общий для auto/manual persisted lease `2 минуты`. Пересчёт атомарно заменяет projection одной D1-транзакцией; при ошибке или generation race предыдущий snapshot не повреждается, stale сохраняется до следующей допустимой попытки. Candidate flow пересчёт не вызывает и его результата не ждёт.

`allTime` в overview читает всю immutable cohort без ограничения выбранным 30-дневным окном. `last30Days` рассчитывается отдельно. История ревизий также не обрезается default-периодом, а A/B сравнение использует явно выбранное окно.

Overview показывает pilot-сравнение Coverage Score для legacy-планов: размер парной выборки, средний actual, средний shadow и среднюю дельту `shadow - actual`. В `fallback / нет shadow` объединены планы с actual score, но без shadow score. Это намеренно честная формулировка: текущая attempts-схема не различает fallback shadow-селектора и историческую запись, созданную до включения shadow mode. Balanced-попытки v2 в этот A/B показатель не смешиваются.

## Privacy и retention

- completed attempts, answers и exact ledger хранятся бессрочно;
- active/aborted старше 24 часов удаляются фоновым maintenance при работающем приложении,
  при restore и дополнительно управляемой командой retention;
- `candidate_name` очищается не позднее 24 часов;
- Telegram payload очищается после доставки и аварийно по retention;
- analytics API не возвращает полное имя, token hash, correct answer, текст вариантов, raw selected answer или Telegram payload;
- admin alias формируется из короткого opaque attempt ID; `public_alias` не копируется в derived tables;
- CSV/JSON export содержит только агрегаты и metadata фильтров.

## Эксплуатация

Перед изменением схемы:

```powershell
npm run ops:backup
npm run ops:backup:verify -- --from backups/<backup>.sql
```

Backup manifest и verify включают analytics tables и integrity invariants. Raw SQL, manifest и rollback-state содержат либо могут содержать ПДн, поэтому живут не более 24 часов и удаляются узким allowlist-cleanup при следующем локальном запуске/ops-вызове. Долговременный raw-архив запрещён; каталог до очистки требует шифрования диска и ограниченного ACL. Retention данных по умолчанию работает как dry-run. Ручной purge требует явного фильтра периода либо attempt ID, `--apply` и проверенный backup.

Основные проверки:

```powershell
npm run test:analytics
npm run analytics:explain
npm run test:analytics:performance
npm run verify
```

Benchmark создаёт изолированную D1 с `10 000 attempts / 300 000 answers`. До rebuild он сохраняет три raw/direct замера overview и худшего question-list на 300 000 фактах как негейтящее baseline-evidence. Затем один раз явно перестраивает persisted aggregates и измеряет API reads без warm JSON-cache. Порог каждого persisted-отчёта и A/B сравнения — p95 не более 500 мс; raw baseline и rebuild time выводятся отдельно. Такой контур не маскирует стоимость stale fallback и не подменяет atomic refresh тёплым report-cache.

Контрольный прогон 2026-08-28: direct overview `p95 847,9 мс`, direct question-list на 300 000 фактах `p95 3 590 мс`; rebuild `13,33 с`; persisted endpoints `p95 20,9–220,2 мс`. Поэтому stale API намеренно отвечает `409 analytics_refresh_required`: автоматический raw fallback нарушил бы SLA 500 мс и сделал latency панели непредсказуемой. Controlled maintenance обычно обновляет projection автоматически, а администратор может запустить тот же сериализованный atomic refresh вручную.
