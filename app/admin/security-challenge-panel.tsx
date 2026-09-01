'use client';

import { useEffect, useState } from 'react';
import { adminErrorMessage, adminRequest } from './admin-client.ts';
import { appPath } from '@/lib/app-path.ts';
import styles from './admin.module.css';

type ChallengeAdminReport = {
  overview: {
    starts?: number;
    active?: number;
    completed?: number;
    participants?: number;
    averageScore?: number;
    medianScore?: number;
    p90Score?: number;
    repeatAttempts?: number;
    medianDurationSeconds?: number;
    p90DurationSeconds?: number;
    average_duration_seconds?: number;
    correct_count?: number;
    incorrect_count?: number;
    timeout_count?: number;
    manual_count?: number;
    total_timeout_count?: number;
    pool_exhausted_count?: number;
  };
  attempts: Array<{
    id: string;
    nickname: string;
    status: string;
    completion_reason: string | null;
    score: number;
    correct_count: number;
    incorrect_count: number;
    timeout_count: number;
    started_at: number;
    completed_at: number | null;
  }>;
  questions: Array<{
    question_id: number;
    prompt: string;
    difficulty: string;
    presentations: number;
    correct_count: number;
    incorrect_count: number;
    timeout_count: number;
    average_seconds: number | null;
    netScore: number;
    first_exposure_count: number;
    first_exposure_correct: number;
  }>;
  difficulties: Array<{
    difficulty: string;
    presentations: number;
    correct_count: number;
    incorrect_count: number;
    timeout_count: number;
    average_seconds: number | null;
    netScore: number;
    first_exposure_count: number;
    first_exposure_correct: number;
  }>;
  feedback: Array<{
    id: string;
    comment: string;
    status: string;
    resolution_note: string | null;
    created_at: number;
    nickname: string;
    question_id: number;
    prompt: string;
  }>;
};

type ChallengeAttemptDetail = {
  attemptId: string;
  nickname: string;
  status: string;
  completionReason: string | null;
  score: number;
  correctCount: number;
  incorrectCount: number;
  timeoutCount: number;
  resolvedCount: number;
  review: Array<{
    eventId: number;
    ordinal: number;
    prompt: string;
    outcome: string;
    scoreDelta: number;
    selectedIndex: number | null;
    correctIndex: number | null;
    choices: string[];
  }>;
};

function number(value: number | undefined | null, digits = 0) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value ?? 0);
}

function date(value: number | null) {
  return value ? new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short',
  }).format(value) : '—';
}

export function SecurityChallengeAdminPanel({
  csrfToken,
  onAdminError,
}: {
  csrfToken: string;
  onAdminError: (error: unknown) => void;
}) {
  const [report, setReport] = useState<ChallengeAdminReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [attemptDetailId, setAttemptDetailId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void adminRequest<ChallengeAdminReport>('/api/admin/challenges/infosec')
      .then((payload) => { if (!cancelled) setReport(payload); })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        onAdminError(requestError);
        setError(adminErrorMessage(requestError));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onAdminError, revision]);

  function reload() {
    setLoading(true);
    setError('');
    setRevision((value) => value + 1);
  }

  if (loading) return <div className={styles.challengeAdminState}>Загружаем аналитику ИБ-челленджа…</div>;
  if (error || !report) return <div className={styles.challengeAdminState}><strong>Данные недоступны</strong><p>{error}</p><button className={styles.secondaryButton} onClick={reload}>Повторить</button></div>;
  const overview = report.overview;
  const resolved = (overview.correct_count ?? 0) + (overview.incorrect_count ?? 0) + (overview.timeout_count ?? 0);
  const accuracy = resolved ? (overview.correct_count ?? 0) / resolved * 100 : 0;
  return (
    <div className={styles.challengeAdmin}>
      <section className={styles.panelHeading}>
        <div><p className={styles.eyebrow}>Отдельный контур</p><h2>ИБ-челлендж</h2><p>Операционные попытки, first-exposure калибровка и очередь спорных вопросов.</p></div>
        <div className={styles.challengeAdminActions}>
          <a href={appPath('/api/admin/challenges/infosec/export?format=csv')} download>CSV</a>
          <a href={appPath('/api/admin/challenges/infosec/export?format=json')} download>JSON</a>
          <button className={styles.secondaryButton} onClick={reload}>Обновить</button>
        </div>
      </section>
      <section className={styles.challengeMetrics}>
        <Metric label="Стартов" value={number(overview.starts)} />
        <Metric label="Завершено" value={number(overview.completed)} />
        <Metric label="Активно" value={number(overview.active)} />
        <Metric label="Участников" value={number(overview.participants)} />
        <Metric label="Медиана баллов" value={number(overview.medianScore, 2)} />
        <Metric label="P90 баллов" value={number(overview.p90Score, 2)} />
        <Metric label="Повторных попыток" value={number(overview.repeatAttempts)} />
        <Metric label="Точность" value={`${number(accuracy, 1)}%`} />
      </section>
      <section className={styles.analyticsCard}>
        <div className={styles.challengeSectionHeading}><div><p className={styles.eyebrow}>Последние 100</p><h3>Попытки</h3></div><span>{overview.manual_count ?? 0} вручную · {overview.total_timeout_count ?? 0} по времени</span></div>
        <div className={styles.challengeTableWrap}><table className={styles.challengeTable}><thead><tr><th>Ник</th><th>Статус</th><th>Баллы</th><th>Верно</th><th>Ошибки</th><th>Тайм-ауты</th><th>Старт</th></tr></thead><tbody>{report.attempts.map((attempt) => <tr key={attempt.id}><td><button className={styles.challengeAttemptLink} onClick={() => setAttemptDetailId(attempt.id)}>{attempt.nickname}</button></td><td>{attempt.status === 'active' ? 'Активна' : attempt.completion_reason ?? 'Завершена'}</td><td>{number(attempt.score, 2)}</td><td>{attempt.correct_count}</td><td>{attempt.incorrect_count}</td><td>{attempt.timeout_count}</td><td>{date(attempt.started_at)}</td></tr>)}</tbody></table></div>
        {attemptDetailId && <AttemptDetail id={attemptDetailId} onClose={() => setAttemptDetailId(null)} onAdminError={onAdminError} />}
      </section>
      <section className={styles.analyticsCard}>
        <div className={styles.challengeSectionHeading}><div><p className={styles.eyebrow}>Сложность</p><h3>Распределение исходов</h3></div><span>Operational и first exposure рядом</span></div>
        <div className={styles.challengeTableWrap}><table className={styles.challengeTable}><thead><tr><th>Уровень</th><th>Показы</th><th>Верно</th><th>Ошибки</th><th>Тайм-ауты</th><th>Первое знакомство</th><th>Вклад</th></tr></thead><tbody>{report.difficulties.map((difficulty) => <tr key={difficulty.difficulty}><td>{difficulty.difficulty}</td><td>{difficulty.presentations}</td><td>{difficulty.correct_count}</td><td>{difficulty.incorrect_count}</td><td>{difficulty.timeout_count}</td><td>{difficulty.first_exposure_correct}/{difficulty.first_exposure_count}</td><td>{number(difficulty.netScore, 2)}</td></tr>)}</tbody></table></div>
      </section>
      <section className={styles.analyticsCard}>
        <div className={styles.challengeSectionHeading}><div><p className={styles.eyebrow}>Operational + calibration</p><h3>Вопросы</h3></div><span>First exposure не искажён повторными попытками</span></div>
        <div className={styles.challengeTableWrap}><table className={styles.challengeTable}><thead><tr><th>Вопрос</th><th>Сложность</th><th>Показы</th><th>Верно</th><th>Тайм-ауты</th><th>Первое знакомство</th><th>Вклад</th></tr></thead><tbody>{report.questions.map((question) => <tr key={question.question_id}><td><strong>#{question.question_id}</strong> {question.prompt}</td><td>{question.difficulty}</td><td>{question.presentations}</td><td>{question.correct_count}</td><td>{question.timeout_count}</td><td>{question.first_exposure_correct}/{question.first_exposure_count}</td><td>{number(question.netScore, 2)}</td></tr>)}</tbody></table></div>
      </section>
      <section className={styles.analyticsCard}>
        <div className={styles.challengeSectionHeading}><div><p className={styles.eyebrow}>Review queue</p><h3>Спорные вопросы</h3></div><span>{report.feedback.filter((item) => item.status === 'open').length} открыто</span></div>
        {report.feedback.length === 0 ? <p className={styles.challengeEmpty}>Обращений пока нет.</p> : <div className={styles.challengeFeedbackList}>{report.feedback.map((item) => <FeedbackItem key={item.id} item={item} csrfToken={csrfToken} onUpdated={() => setRevision((value) => value + 1)} onAdminError={onAdminError} />)}</div>}
      </section>
    </div>
  );
}

function AttemptDetail({ id, onClose, onAdminError }: {
  id: string;
  onClose: () => void;
  onAdminError: (error: unknown) => void;
}) {
  const [detail, setDetail] = useState<ChallengeAttemptDetail | null>(null);
  useEffect(() => {
    let cancelled = false;
    void adminRequest<ChallengeAttemptDetail>(`/api/admin/challenges/infosec/attempts/${id}`)
      .then((payload) => { if (!cancelled) setDetail(payload); })
      .catch((error: unknown) => { if (!cancelled) onAdminError(error); });
    return () => { cancelled = true; };
  }, [id, onAdminError]);
  return <div className={styles.challengeAttemptDetail}><header><div><p className={styles.eyebrow}>Карточка попытки</p><h4>{detail?.nickname ?? 'Загрузка…'}</h4></div><button className={styles.secondaryButton} onClick={onClose}>Закрыть</button></header>{detail && <><div className={styles.challengeDetailMetrics}><span>Баллы <strong>{number(detail.score, 2)}</strong></span><span>Верно <strong>{detail.correctCount}</strong></span><span>Ошибки <strong>{detail.incorrectCount}</strong></span><span>Тайм-ауты <strong>{detail.timeoutCount}</strong></span></div><div className={styles.challengeDetailReview}>{detail.review.map((item) => <details key={item.eventId}><summary>#{item.ordinal} · {item.outcome} · {item.scoreDelta > 0 ? '+' : ''}{number(item.scoreDelta, 2)}</summary><h5>{item.prompt}</h5><ol>{item.choices.map((choice, index) => <li key={`${index}-${choice}`} data-selected={index === item.selectedIndex || undefined} data-correct={index === item.correctIndex || undefined}>{choice}</li>)}</ol></details>)}</div></>}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <article className={styles.metricCard}><span>{label}</span><strong>{value}</strong></article>;
}

function FeedbackItem({ item, csrfToken, onUpdated, onAdminError }: {
  item: ChallengeAdminReport['feedback'][number];
  csrfToken: string;
  onUpdated: () => void;
  onAdminError: (error: unknown) => void;
}) {
  const [note, setNote] = useState(item.resolution_note ?? '');
  const [busy, setBusy] = useState(false);
  async function resolve(status: 'resolved' | 'rejected') {
    setBusy(true);
    try {
      await adminRequest(`/api/admin/challenges/infosec/feedback/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ status, resolutionNote: note }),
      });
      onUpdated();
    } catch (error) { onAdminError(error); } finally { setBusy(false); }
  }
  return <article className={styles.challengeFeedback} data-status={item.status}><header><div><strong>#{item.question_id} · {item.nickname}</strong><time>{date(item.created_at)}</time></div><span>{item.status === 'open' ? 'Открыто' : item.status}</span></header><h4>{item.prompt}</h4><blockquote>{item.comment}</blockquote>{item.status === 'open' ? <><textarea value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="Решение или комментарий проверяющего" /><div><button className={styles.secondaryButton} disabled={busy} onClick={() => void resolve('rejected')}>Отклонить</button><button className={styles.primaryButton} disabled={busy} onClick={() => void resolve('resolved')}>Решено</button></div></> : item.resolution_note && <p>{item.resolution_note}</p>}</article>;
}
