import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sourcePath = process.argv[2];
if (!sourcePath) {
  throw new Error('Укажите путь к Markdown: npm run questions:import-markdown -- <path>');
}

const root = process.cwd();
const bankPath = path.join(root, 'db', 'questions.json');
const importPath = path.join(root, 'db', 'questions.import-2026-09-01.json');
const reportPath = path.join(root, 'docs', 'question-bank-import-2026-09-01.md');

const SECTION_TOPICS = {
  '02': 'Сети',
  '03': 'Информационная безопасность',
  '04': 'Информационная безопасность',
  '05': 'Информационная безопасность',
  '06': 'Информационная безопасность',
  '07': 'Информационная безопасность',
  '08': 'Информационная безопасность',
  '09': 'Информационная безопасность',
  '10': 'Информационная безопасность',
  '11': 'Информационная безопасность',
  '12': 'Информационная безопасность',
  '13': 'Информационная безопасность',
  '14': 'Информационная безопасность',
  '15': 'Информационная безопасность',
};

const LINUX_QUESTION_NUMBERS = new Set([3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 27, 34]);

const EXCLUDED = new Map(Object.entries({
  '01.14': 'Формулировка зависит от дистрибутива: демон называется cron или crond.',
  '01.19': 'Вопрос просит перечислить типы параметров реестра, но правильный вариант содержит только неполное подмножество.',
  '01.24': 'Не указана ОС, а ожидаемый netstat является legacy-вариантом и конкурирует с современными средствами.',
  '06.6': 'Эталон фактически неверен: OEP — точка передачи управления загрузчиком, а не обязательно адрес main().',
  '10.3': 'Правило «защита не дороже актива» чрезмерно упрощает оценку риска и может приводить к неверным решениям.',
  '10.5': 'Проверяется запоминание устаревающей vendor-аббревиатуры CARTA без практического инженерного сигнала.',
  '11.1': 'Определение киберинцидента ошибочно сужено до внутреннего нарушения политики.',
  '11.2': 'Расследование сведено только к исключению ложных срабатываний; определение неполно.',
  '11.3': 'Цели расследования и уголовной атрибуции зависят от мандата команды; единственного устойчивого ответа нет.',
  '11.9': 'Эталон смешивает Eradication и Recovery, включая восстановление данных в этап ликвидации.',
  '11.11': 'Цифровая криминалистика ошибочно сведена к доказательству компьютерных преступлений.',
}));

const DUPLICATES = new Map(Object.entries({
  '01.3': 'действующий вопрос #8102',
  '01.8': 'действующий вопрос #8206',
  '01.9': 'действующий вопрос #5032',
  '01.11': 'действующий вопрос #8103',
  '01.12': 'действующие редакции #2012/#8104',
  '02.12': 'действующий вопрос #5020',
  '04.10': 'действующий сценарный вопрос #6303',
  '08.2': 'действующий вопрос #5049',
  '08.10': 'действующий вопрос #5050',
  '10.13': 'действующий вопрос #8301',
  '10.27': 'действующий вопрос #8302',
  '12.2': 'вопрос 14.1 из того же импортируемого банка',
}));

const EXPERT = new Set([
  '01.34', '02.21', '03.32', '07.18', '09.22', '10.42', '11.25', '13.21', '14.17', '15.22',
]);

const HARD = new Set([
  '01.34', '02.21', '05.17', '06.20', '08.18', '12.22',
  '01.7', '01.13', '01.16', '01.20', '01.25', '01.27',
  '02.5', '02.6', '02.8', '02.10',
  '03.3', '03.12', '03.15', '03.16', '03.17', '03.18', '03.20', '03.25',
  '06.7', '06.9', '06.13', '07.2', '07.6', '07.10', '07.11',
  '09.6', '09.7', '09.9', '09.11', '09.14',
  '10.16', '10.19', '10.22', '10.23', '10.24', '10.25',
  '11.6', '11.7', '11.8', '11.12', '11.15', '11.18',
  '12.5', '12.6', '12.10', '12.12', '12.15',
  '13.5', '13.6', '13.8', '13.9', '13.10', '13.11', '13.12', '13.13', '13.14',
  '14.4', '14.7', '14.8', '14.9', '14.10',
  '15.2', '15.3', '15.5', '15.10', '15.11', '15.13', '15.14', '15.15',
]);

const DEDUPE_GROUPS = new Map([
  [['03.5', '03.6', '03.8', '03.19', '03.23'], 'docker-cli-basics'],
  [['03.10', '03.11', '03.13', '03.22'], 'kubernetes-core-concepts'],
  [['07.8', '11.17'], 'md5-collision-resistance'],
  [['10.10', '10.30'], 'security-control-classification'],
  [['10.17', '10.19'], 'soc-operational-platforms'],
  [['12.1', '12.3', '14.1', '14.2'], 'security-risk-core-terms'],
  [['12.8', '12.9', '12.10'], 'risk-assessment-methods'],
  [['13.5', '13.6'], 'russian-security-regulators'],
  [['15.6', '15.7', '15.8'], 'appsec-testing-methods'],
  [['10.18', '15.9'], 'waf-basics'],
].flatMap(([keys, value]) => keys.map((key) => [key, value])));

const PROMPT_OVERRIDES = new Map(Object.entries({
  '02.14': 'Какова длина IPv4-адреса в битах?',
  '10.1': 'Согласно «пирамиде боли», какой элемент поведения атакующего труднее всего заменить после его блокировки защитником?',
}));

const CHOICE_OVERRIDES = new Map(Object.entries({
  '06.2:B': 'Динамический анализ запускает файл и наблюдает за его поведением.',
  '09.14:B': 'Усиленная квалифицированная электронная подпись на квалифицированном сертификате аккредитованного УЦ',
  '10.9:B': 'Люди, технологии и процессы',
  '14.4:A': 'Анализировать подмену, модификацию, отказ от действия, раскрытие данных, отказ в обслуживании и повышение привилегий',
  '15.1:B': 'Уязвимость можно использовать для нарушения безопасности; не каждый обычный дефект имеет такие последствия',
  '15.22:C': 'Проверить применимость, обновить или заменить компонент; исключение делать ограниченным по сроку и с компенсирующими мерами',
}));

function cleanInline(value) {
  return value
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\s+---\s+/gu, ' — ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function parseOptions(body) {
  const options = [];
  let current = null;
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^([A-F])\.\s+(.+)$/u.exec(line);
    if (match) {
      current = { letter: match[1], text: match[2].trim() };
      options.push(current);
    } else if (current && line && line !== '---' && !line.startsWith('>')) {
      current.text += ` ${line}`;
    } else if (line === '---' || line.startsWith('>')) {
      current = null;
    }
  }
  return options;
}

function parseMarkdown(markdown) {
  const sectionPattern = /^# (\d{2}) (.+)$/gmu;
  const sections = [...markdown.matchAll(sectionPattern)];
  const questions = [];
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex];
    const sectionStart = section.index + section[0].length;
    const sectionEnd = sections[sectionIndex + 1]?.index ?? markdown.length;
    const sectionBody = markdown.slice(sectionStart, sectionEnd);
    const answersHeading = /^## ОТВЕТЫ.*$/mu.exec(sectionBody);
    if (!answersHeading) throw new Error(`Не найден блок ответов раздела ${section[1]}`);
    const questionsPart = sectionBody.slice(0, answersHeading.index);
    const answersPart = sectionBody.slice(answersHeading.index + answersHeading[0].length);
    const closedAnswersPart = answersPart.split('**Ответы на открытые вопросы:**')[0];
    const answerMap = new Map(
      [...closedAnswersPart.matchAll(/(\d+)\s*-\s*([A-F])/gu)]
        .map((match) => [Number(match[1]), match[2]]),
    );
    const questionPattern = /^### (\d+)\. (.+?)\s*$/gmu;
    const matches = [...questionsPart.matchAll(questionPattern)];
    for (let questionIndex = 0; questionIndex < matches.length; questionIndex += 1) {
      const match = matches[questionIndex];
      const bodyStart = match.index + match[0].length;
      const bodyEnd = matches[questionIndex + 1]?.index ?? questionsPart.length;
      const body = questionsPart.slice(bodyStart, bodyEnd);
      const options = parseOptions(body);
      const prefix = questionsPart.slice(Math.max(0, match.index - 120), match.index);
      const markerPosition = prefix.lastIndexOf('ℹ️ Базовый');
      const separatorPosition = prefix.lastIndexOf('---');
      questions.push({
        section: section[1],
        sectionTitle: section[2].replace(/\s*\(Всего вопросов:.*$/u, '').trim(),
        number: Number(match[1]),
        prompt: match[2].trim(),
        options,
        answerLetter: answerMap.get(Number(match[1])) ?? null,
        basic: markerPosition >= 0 && markerPosition > separatorPosition,
      });
    }
  }
  return questions;
}

function topicFor(question) {
  if (question.section === '01') {
    return LINUX_QUESTION_NUMBERS.has(question.number) ? 'Linux' : 'Windows и AD';
  }
  return SECTION_TOPICS[question.section];
}

function difficultyFor(key, basic) {
  if (EXPERT.has(key)) return 'expert';
  if (HARD.has(key)) return 'hard';
  return basic ? 'easy' : 'medium';
}

function validateConverted(question, key) {
  const issues = [];
  if (!question.topic) issues.push('не определена категория');
  if (question.prompt.length > 280) issues.push(`prompt длиннее 280 (${question.prompt.length})`);
  if (question.choices.length < 2 || question.choices.length > 6) issues.push('нужно от 2 до 6 вариантов');
  question.choices.forEach((choice, index) => {
    if (choice.length > 160) issues.push(`вариант ${index + 1} длиннее 160 (${choice.length})`);
  });
  if (question.correctIndex < 0 || question.correctIndex >= question.choices.length) {
    issues.push('correctIndex вне диапазона');
  }
  if (new Set(question.choices.map((choice) => choice.toLocaleLowerCase('ru-RU'))).size !== question.choices.length) {
    issues.push('повторяющиеся варианты');
  }
  if (issues.length) throw new Error(`${key}: ${issues.join('; ')}`);
}

const markdown = readFileSync(path.resolve(sourcePath), 'utf8');
const existingBank = JSON.parse(readFileSync(bankPath, 'utf8'));
const parsed = parseMarkdown(markdown);
const closed = parsed.filter((question) => question.options.length > 0);
const open = parsed.filter((question) => question.options.length === 0);
const imported = [];
const excluded = [];
const duplicates = [];

for (const source of closed) {
  const key = `${source.section}.${source.number}`;
  if (EXCLUDED.has(key)) {
    excluded.push({ ...source, reason: EXCLUDED.get(key) });
    continue;
  }
  if (DUPLICATES.has(key)) {
    duplicates.push({ ...source, target: DUPLICATES.get(key) });
    continue;
  }
  const answerIndex = source.options.findIndex((option) => option.letter === source.answerLetter);
  const choices = source.options.map((option) => cleanInline(
    CHOICE_OVERRIDES.get(`${key}:${option.letter}`) ?? option.text,
  ));
  const question = {
    id: 1_000_000 + imported.length,
    difficulty: difficultyFor(key, source.basic),
    topic: topicFor(source),
    prompt: cleanInline(PROMPT_OVERRIDES.get(key) ?? source.prompt),
    choices,
    correctIndex: answerIndex,
    active: true,
    dedupeKey: DEDUPE_GROUPS.get(key) ?? `bank-2026:${source.section}:${String(source.number).padStart(2, '0')}`,
  };
  validateConverted(question, key);
  imported.push({ ...question, sourceKey: key, sectionTitle: source.sectionTitle });
}

if (closed.length !== 257 || open.length !== 90) {
  throw new Error(`Неожиданная структура источника: closed=${closed.length}, open=${open.length}`);
}

const generatedIds = new Set(imported.map((question) => question.id));
const baseBank = existingBank.filter((question) => !generatedIds.has(question.id) && question.id < 1_000_000);
const bankQuestions = imported.map((question) => ({
  id: question.id,
  difficulty: question.difficulty,
  topic: question.topic,
  prompt: question.prompt,
  choices: question.choices,
  correctIndex: question.correctIndex,
  active: question.active,
  dedupeKey: question.dedupeKey,
}));
const nextBank = [...baseBank, ...bankQuestions];

const importDocument = {
  schemaVersion: 1,
  source: path.basename(sourcePath),
  generatedAt: '2026-09-01',
  questions: bankQuestions.map((question) => ({
    difficulty: question.difficulty,
    topic: question.topic,
    prompt: question.prompt,
    choices: question.choices,
    correctIndex: question.correctIndex,
    active: question.active,
    dedupeKey: question.dedupeKey,
  })),
};

function groupBy(items, keySelector) {
  return items.reduce((groups, item) => {
    const key = keySelector(item);
    (groups[key] ??= []).push(item);
    return groups;
  }, {});
}

const topicCounts = groupBy(imported, (question) => question.topic);
const difficultyCounts = groupBy(imported, (question) => question.difficulty);
const inactiveExisting = baseBank.filter((question) => question.active === false).length;
const report = `# Отчёт об интеграции банка вопросов от 01.09.2026

## Результат

- Исходный файл: \`${path.basename(sourcePath)}\`.
- Закрытых вопросов в источнике: **${closed.length}**.
- Добавлено в банк: **${imported.length}**.
- Открытых вопросов пропущено по требованию: **${open.length}**.
- Явных дублей пропущено: **${duplicates.length}**.
- Неподходящих закрытых вопросов исключено: **${excluded.length}**.
- Существующих архивных записей сохранено без изменений: **${inactiveExisting}**.

## Распределение добавленных вопросов

| Категория приложения | Количество |
|---|---:|
${Object.entries(topicCounts).sort(([left], [right]) => left.localeCompare(right, 'ru-RU')).map(([topic, items]) => `| ${topic} | ${items.length} |`).join('\n')}

| Сложность | Количество |
|---|---:|
${['easy', 'medium', 'hard', 'expert'].map((difficulty) => `| ${difficulty} | ${difficultyCounts[difficulty]?.length ?? 0} |`).join('\n')}

## Исключённые как неподходящие

${excluded.map((question) => `- **${question.section}.${question.number}. ${cleanInline(question.prompt)}** — ${question.reason}`).join('\n')}

## Пропущенные дубли

${duplicates.map((question) => `- **${question.section}.${question.number}. ${cleanInline(question.prompt)}** — дублирует ${question.target}.`).join('\n')}

## Архив и lifecycle

Существующие неактивные вопросы не удалялись и не реактивировались. Новые вопросы получили отдельные стабильные ID из диапазона \`1000000+\`. Дубли действующих вопросов не создавались, поэтому искусственно архивировать рабочие редакции не потребовалось.

## Артефакты

- \`db/questions.json\` — полный bootstrap-банк для чистого развёртывания.
- \`db/questions.import-2026-09-01.json\` — локальный пакет для штатного импорта в уже инициализированную D1. Файл содержит правильные ответы и исключён из Git.
`;

writeFileSync(bankPath, `${JSON.stringify(nextBank, null, 2)}\n`, 'utf8');
writeFileSync(importPath, `${JSON.stringify(importDocument, null, 2)}\n`, 'utf8');
writeFileSync(reportPath, report, 'utf8');

console.log(JSON.stringify({
  sourceClosed: closed.length,
  sourceOpen: open.length,
  imported: imported.length,
  duplicates: duplicates.length,
  excluded: excluded.length,
  finalBank: nextBank.length,
  active: nextBank.filter((question) => question.active).length,
}, null, 2));
