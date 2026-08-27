import { env } from 'cloudflare:workers';

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
export type QuestionRow = { id: number; difficulty: Difficulty; prompt: string; choices_json: string; correct_index: number; weight: number };
export type AttemptRow = { id: string; token_hash: string; public_alias: string; status: 'active' | 'completed'; started_at: number; total_deadline_at: number; question_deadline_at: number; current_question_id: number | null; pending_question_ids: string; asked_question_ids: string; score: number; correct_count: number; wrong_count: number; completed_at: number | null; duration_seconds: number | null };

const seedQuestions = [
  ['easy','Какой HTTP-метод обычно используют для чтения ресурса без изменения его состояния?',['POST','GET','PATCH','DELETE'],1,1],
  ['easy','Что из перечисленного лучше всего описывает переменную в программе?',['Именованное место для значения','Всегда отдельный файл','Запрос к базе данных','Сетевой порт'],0,1],
  ['easy','Какой формат чаще всего используют REST API для передачи структурированных данных?',['BMP','JSON','MP3','EXE'],1,1],
  ['easy','Что означает код ответа HTTP 404?',['Успешное создание','Требуется оплата','Ресурс не найден','Ошибка DNS'],2,1],
  ['medium','Какой индекс лучше поддержит запрос WHERE candidate_id = ? ORDER BY created_at?',['Только created_at','Составной (candidate_id, created_at)','Только id','Индекс не нужен'],1,2],
  ['medium','Почему секреты не следует хранить в Git-репозитории?',['Git замедляет шифрование','Они сохраняются в истории даже после удаления','Их нельзя читать из кода','Это запрещает TypeScript'],1,2],
  ['medium','Какой статус наиболее уместен при корректном запросе без прав доступа?',['401 или 403','200','301','503'],0,2],
  ['medium','Что даёт серверная проверка ответа в тесте?',['Уменьшает CSS','Не раскрывает правильный ответ в клиентском коде','Отключает сеть','Заменяет базу данных'],1,2],
  ['hard','Как безопаснее предотвратить повторное начисление баллов при двух одинаковых запросах?',['Увеличить таймаут','Добавить идемпотентность и уникальное ограничение','Скрыть кнопку CSS','Использовать GET'],1,3],
  ['hard','Что важнее всего при миграции схемы рабочей базы без простоя?',['Сразу удалить старые поля','Обратная совместимость этапов expand/migrate/contract','Переименовать все таблицы','Отключить журналирование'],1,3],
  ['hard','Какой подход снижает риск SQL-инъекции?',['Конкатенация строк','Подготовленные запросы с параметрами','Base64 для SQL','Скрытый endpoint'],1,3],
  ['expert','Сервис читает событие повторно после сбоя между записью в БД и подтверждением брокеру. Какое свойство обработчика требуется?',['Синхронный CSS','Идемпотентная обработка','Случайная задержка','Общий root-токен'],1,10],
  ['expert','Какой паттерн согласует запись в БД и последующую публикацию события без распределённой транзакции?',['Outbox pattern','Singleton UI','Round-robin DNS','Long polling'],0,10],
] as const;

let initialized: Promise<void> | null = null;
export function database() { if (!env.DB) throw new Error('SQLite binding DB is unavailable'); return env.DB; }
export function ensureDatabase() {
  if (initialized) return initialized;
  initialized = (async () => {
    const db = database();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard','expert')), prompt TEXT NOT NULL, choices_json TEXT NOT NULL, correct_index INTEGER NOT NULL, weight INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, public_alias TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', started_at INTEGER NOT NULL, total_deadline_at INTEGER NOT NULL, question_deadline_at INTEGER NOT NULL, current_question_id INTEGER, pending_question_ids TEXT NOT NULL, asked_question_ids TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0, wrong_count INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, duration_seconds INTEGER)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, question_id INTEGER NOT NULL, selected_index INTEGER, is_correct INTEGER NOT NULL, answered_at INTEGER NOT NULL, UNIQUE(attempt_id, question_id))`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_attempts_leaderboard ON attempts(status, score DESC, duration_seconds ASC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_questions_pool ON questions(active, difficulty)`),
    ]);
    const existing = await db.prepare('SELECT COUNT(*) AS count FROM questions').first<{ count: number }>();
    if ((existing?.count ?? 0) === 0) await db.batch(seedQuestions.map((q, index) => db.prepare('INSERT INTO questions (id, difficulty, prompt, choices_json, correct_index, weight, active) VALUES (?, ?, ?, ?, ?, ?, 1)').bind(index + 1, q[0], q[1], JSON.stringify(q[2]), q[3], q[4])));
  })().catch((error) => { initialized = null; throw error; });
  return initialized;
}

export async function sha256(value: string) { const bytes = new TextEncoder().encode(value); const digest = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
export function publicAlias(name: string) { const words = name.trim().replace(/\s+/g, ' ').split(' '); const first = words[0].slice(0, 30); return words.length > 1 ? `${first} ${words.at(-1)![0].toLocaleUpperCase('ru-RU')}.` : `${first[0].toLocaleUpperCase('ru-RU')}***`; }
export async function findAttempt(id: string) { return database().prepare('SELECT * FROM attempts WHERE id = ?').bind(id).first<AttemptRow>(); }
export async function findQuestion(id: number) { return database().prepare('SELECT id, difficulty, prompt, choices_json, correct_index, weight FROM questions WHERE id = ? AND active = 1').bind(id).first<QuestionRow>(); }
export async function verifyAttempt(id: string, token: string) { const attempt = await findAttempt(id); if (!attempt || !token || await sha256(token) !== attempt.token_hash) return null; return attempt; }
export async function attemptPayload(attempt: AttemptRow, token = '') {
  if (attempt.status === 'completed' || attempt.current_question_id === null) { const answeredCount = attempt.correct_count + attempt.wrong_count; return { attemptId: attempt.id, token, status: 'completed' as const, result: { score: attempt.score, correctCount: attempt.correct_count, wrongCount: attempt.wrong_count, answeredCount, accuracy: answeredCount ? Math.round((attempt.correct_count / answeredCount) * 100) : 0, durationSeconds: attempt.duration_seconds ?? 0 } }; }
  const question = await findQuestion(attempt.current_question_id); if (!question) throw new Error('Question not found');
  const plannedTotal = JSON.parse(attempt.asked_question_ids).length + JSON.parse(attempt.pending_question_ids).length;
  return { attemptId: attempt.id, token, status: 'active' as const, question: { id: question.id, prompt: question.prompt, choices: JSON.parse(question.choices_json), difficulty: question.difficulty, weight: question.weight, position: JSON.parse(attempt.asked_question_ids).length, plannedTotal, questionDeadlineAt: attempt.question_deadline_at, totalDeadlineAt: attempt.total_deadline_at } };
}
