'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import type { AdminSessionDto } from '@/lib/analytics-contract.ts';
import { appPath } from '@/lib/app-path.ts';
import {
  AdminRequestError,
  adminErrorMessage,
  adminRequest,
  analyticsPagePath,
} from '../admin-client.ts';
import styles from '../admin.module.css';

type LoginState = 'checking' | 'ready' | 'disabled' | 'unavailable';

export default function AdminLoginPage() {
  const [state, setState] = useState<LoginState>('checking');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    let focusFrame: number | null = null;
    void adminRequest<AdminSessionDto>('/api/admin/session')
      .then((session) => {
        if (cancelled) return;
        if (!session.enabled) {
          setState('disabled');
          return;
        }
        if (session.authenticated) {
          window.location.replace(analyticsPagePath());
          return;
        }
        setState('ready');
        const keyboardOrFinePointer = window.matchMedia(
          '(hover: hover) and (pointer: fine), (pointer: none)',
        ).matches;
        if (keyboardOrFinePointer) {
          focusFrame = window.requestAnimationFrame(() => pinRef.current?.focus());
        }
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        if (requestError instanceof AdminRequestError && requestError.code === 'admin_disabled') {
          setState('disabled');
        } else {
          setState('unavailable');
          setError(adminErrorMessage(requestError));
        }
      });
    return () => {
      cancelled = true;
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6,12}$/u.test(pin)) {
      setError('PIN должен содержать от 6 до 12 цифр.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const session = await adminRequest<AdminSessionDto>('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin.trim() }),
      });
      if (!session.enabled) {
        setState('disabled');
        return;
      }
      if (!session.authenticated) throw new AdminRequestError(401, 'unauthorized');
      window.location.replace(analyticsPagePath());
    } catch (requestError) {
      if (requestError instanceof AdminRequestError && requestError.code === 'admin_disabled') {
        setState('disabled');
      } else {
        setError(requestError instanceof AdminRequestError && requestError.code === 'unauthorized'
          ? 'Неверный PIN администратора.'
          : adminErrorMessage(requestError));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`${styles.shell} ${styles.loginShell}`}>
      <div className={styles.ambient} aria-hidden="true" />
      <section className={styles.loginCard} aria-labelledby="admin-login-title">
        <a className={styles.brand} href={appPath('/')} aria-label="Вернуться в Candidate Check">
          <span className={styles.brandMark} aria-hidden="true" />
          <span>Candidate Check</span>
        </a>
        <p className={styles.eyebrow}>Локальная аналитика</p>
        <h1 id="admin-login-title">Вход администратора</h1>
        {state === 'checking' ? (
          <p className={styles.stateMessage} role="status">Проверяем доступность раздела…</p>
        ) : state === 'disabled' ? (
          <AdminUnavailable
            title="Аналитика отключена"
            message="Локальный сервер запущен без административного доступа. Тестирование кандидатов продолжает работать."
          />
        ) : state === 'unavailable' ? (
          <AdminUnavailable
            title="Раздел пока недоступен"
            message={error || 'Не удалось проверить административную сессию.'}
            retry
          />
        ) : (
          <form className={styles.loginForm} onSubmit={submit}>
            <p>Введите локальный PIN. Он не встраивается в bundle и не сохраняется в браузере.</p>
            <label htmlFor="admin-pin">PIN администратора</label>
            <input
              ref={pinRef}
              id="admin-pin"
              name="pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/gu, '').slice(0, 12))}
              disabled={busy}
              minLength={6}
              maxLength={12}
              pattern="[0-9]{6,12}"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'admin-login-error' : undefined}
            />
            {error && <p id="admin-login-error" className={styles.error} role="alert">{error}</p>}
            <button className={styles.primaryButton} type="submit" disabled={busy || pin.length < 6}>
              {busy ? 'Проверяем…' : 'Открыть аналитику'}
              <span aria-hidden="true">→</span>
            </button>
          </form>
        )}
        <p className={styles.loginFootnote}>Только обезличенные агрегаты и локальные данные.</p>
      </section>
    </main>
  );
}

function AdminUnavailable({
  title,
  message,
  retry = false,
}: {
  title: string;
  message: string;
  retry?: boolean;
}) {
  return (
    <div className={styles.unavailable} role="status">
      <span aria-hidden="true">◇</span>
      <h2>{title}</h2>
      <p>{message}</p>
      <div className={styles.inlineActions}>
        {retry && <button className={styles.secondaryButton} onClick={() => window.location.reload()}>Повторить</button>}
        <a className={styles.textLink} href={appPath('/')}>На стартовую</a>
      </div>
    </div>
  );
}
