import { queryLocalD1 } from './local-d1.ts';

const includePrompts = process.argv.includes('--include-prompts');
const promptColumn = includePrompts ? ', q.prompt' : '';
const rows = queryLocalD1<Record<string, string | number | null>>(`
  SELECT q.id, q.topic, q.difficulty${promptColumn},
    COUNT(a.id) AS answered_count,
    COALESCE(SUM(a.is_correct), 0) AS correct_count,
    CASE WHEN COUNT(a.id) = 0 THEN NULL
      ELSE ROUND(100.0 * SUM(a.is_correct) / COUNT(a.id)) END AS correct_rate
  FROM questions q
  LEFT JOIN answers a ON a.question_id = q.id
  WHERE q.active = 1
  GROUP BY q.id, q.topic, q.difficulty${includePrompts ? ', q.prompt' : ''}
  ORDER BY answered_count DESC, q.id ASC
`);

console.table(rows);
console.log(
  includePrompts
    ? 'Тексты показаны по явному флагу --include-prompts.'
    : 'Тексты вопросов скрыты. Для локальной диагностики добавьте --include-prompts.',
);
