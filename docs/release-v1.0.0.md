# Candidate Check v1.0.0

## Итог релиза

Релиз завершает локальный analytics roadmap без публикации и внешней BI-инфраструктуры. Candidate flow остаётся server-authoritative; SQLite/D1 хранит точную identity модели, operational ledger и analytics facts.

## Основные изменения

- exact `attempt_questions` ledger для base/additional assignment и server presentation;
- answer origin, canonical choice index и фактически начисленный score;
- cohort identity и immutable snapshots test config / bank revision membership;
- локальный PIN-protected admin dashboard для вопросов, кандидатов, тем, сложностей, trends и revisions;
- base-only candidate classification и детерминированные рекомендации интервьюеру;
- calibration gates, distractor distribution, discrimination, partial Question Quality Score и review history;
- balanced selection profile с shadow rollout, Coverage Score и legacy fallback;
- агрегированные CSV/JSON и printable candidate report;
- бессрочное completed retention, 24-часовая очистка abandoned, ПДн и raw backup-артефактов,
  manual purge с verified backup;
- synthetic `10 000 / 300 000` benchmark, query-plan audit и WebKit iPad E2E.

## Совместимость

- старые 50-балльные попытки остаются legacy scoring v1;
- завершённые 100-балльные попытки сохраняются в совместимом leaderboard, но получают facts version 0;
- legacy facts не backfill-ятся и не входят в analytics API;
- старая активная попытка получает `409 attempt_version_unsupported`, после чего клиент предлагает начать заново.

## Rollback

Миграции не откатываются разрушительно. Analytics, calibration, export и balanced selection отключаются соответствующими runtime flags. Candidate flow и уже сохранённые facts продолжают работать.

## Release gate

Для `main` рекомендуется branch protection с обязательным GitHub status check `verify`. Публикация commit и релиз считаются завершёнными только после зелёного удалённого check; локальный `npm run verify` остаётся обязательной предварительной проверкой, но не заменяет результат CI.

На контрольном security-прогоне 2026-08-28 `npm audit --omit=dev` не обнаружил production vulnerabilities. Advisories полного `npm audit` относятся к build/test toolchain и требуют отдельного совместимого обновления с полным regression gate; `npm audit fix --force` не применяется.

## Предлагаемое сообщение коммита

```text
feat(analytics): завершить локальную аналитику Candidate Check v1.0
```
