# Candidate Check Analytics: статус v1.0 и следующий цикл

## Что завершено

- `v0.7.1`: immutable model identity, `attempt_questions`, exact answer facts, revision membership, полный base/additional breakdown и cohort-aware leaderboard.
- `v0.8.0`: локальный admin PIN, HttpOnly-сессия, rate limit, CSRF и первая страница качества вопросов.
- `v0.9.0`: профиль кандидата по темам, base-only классификация и воспроизводимые рекомендации интервьюеру.
- `v0.10.0`: overview, кандидаты, темы, сложности, score histogram и trends.
- `v0.11.0`: профиль `general-balanced-v2`, frequency/recency-aware выборка, Coverage Score, shadow mode и безопасный fallback.
- `v0.12.0`: distractor distribution, point-biserial discrimination, Question Quality Score и immutable review history.
- `v0.13.0`: когортные фильтры и сравнение ревизий банка.
- `v0.14.0`: агрегированные CSV/JSON и печатный admin-отчёт кандидата без answer keys.
- `v1.0.0`: migration/backup/restore/retention проверки, synthetic benchmark, `EXPLAIN`, WebKit iPad E2E и единый quality gate.

Analytics cutover начинается только для `ANALYTICS_FACTS_VERSION=1`. Legacy-попытки остаются читаемыми, но не backfill-ятся приблизительными фактами и не участвуют в аналитических API.

## Feature flags и rollout

| Флаг | Default | Назначение |
|---|---:|---|
| `ANALYTICS_ENABLED` | `1` | Admin analytics API/UI |
| `CALIBRATION_ENABLED` | `1` | quality/discrimination расчёты |
| `ANALYTICS_EXPORT_ENABLED` | `1` | агрегированные CSV/JSON |
| `BALANCED_SELECTION_SHADOW` | `1` | расчёт shadow Coverage Score без влияния на тест |
| `BALANCED_SELECTION_ENABLED` | `0` | включение `general-balanced-v2` после пилота |

Rollback не разрушает данные: соответствующий флаг выключается, миграции и exact facts сохраняются. Автоматическое изменение difficulty, verdict или `active` по статистике запрещено.

## Следующий практический цикл

### P0 — пилот

- накопить минимум 30 предъявлений на ключевой вопрос в закрытом пилоте;
- сравнить shadow Coverage Score и тематическое покрытие с legacy selector;
- проверить Telegram-профиль интервьюера на реальных, но разрешённых данных;
- выполнять и проверять backup перед каждым обновлением банка.

### P1 — после накопления выборки

- на `n≥50` провести первый review quality status;
- на `n≥100` проверить discrimination и качество дистракторов;
- решения `disable_requested` реализовывать только новой ревизией банка и новым question ID при смысловой правке;
- включить balanced selector только после сравнения распределений и зелёного E2E.

### P2 — эксплуатация

- следить за размером D1 при бессрочном хранении completed facts;
- повторять synthetic benchmark после существенного роста банка или изменения SQL;
- сохранять persisted daily aggregates: direct baseline на `10 000 / 300 000` уже превысил
  лимит 500 мс (`847,9` мс для overview и `3 590` мс для question-list);
- расписание backup в Windows Task Scheduler оформлять отдельно от runtime приложения.

## Сохраняемые границы

- только локальная разработка; deployment и внешняя инфраструктура не входят в текущий контур;
- SQLite/D1 остаётся единственным хранилищем;
- admin UI не показывает полное имя, answer key, raw selected answer или Telegram payload;
- кандидату не показываются сильные/слабые темы и рекомендации интервьюеру;
- Telegram остаётся копией ПДн и правильных ответов, поэтому группа должна быть закрытой;
- Service Worker, полноценный offline, SSO/RBAC, ATS, proctoring и AI-оценка не входят в v1.0.
