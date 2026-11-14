/**
 * Creates demo accounts in Supabase Auth plus a sample quiz with a few
 * completed attempts, so the leaderboard and analytics have data.
 * Safe to re-run. Needs DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo@1234';
const USERS = [
  { email: 'teacher@demo.jora', name: 'Ms. Rivera', role: 'teacher' },
  { email: 'student@demo.jora', name: 'Sam Student', role: 'student' },
  { email: 'aisha@demo.jora', name: 'Aisha Khan', role: 'student' },
  { email: 'leo@demo.jora', name: 'Leo Park', role: 'student' },
  { email: 'maya@demo.jora', name: 'Maya Chen', role: 'student' },
  { email: 'noah@demo.jora', name: 'Noah Smith', role: 'student' },
] as const;

const QUIZ = {
  title: 'Solar System Basics',
  description: 'Five quick questions on the planets.',
  questions: [
    { prompt: 'Which planet is closest to the Sun?', options: ['Venus', 'Mercury', 'Mars', 'Earth'], correct: 1 },
    { prompt: 'Which planet is known as the Red Planet?', options: ['Mars', 'Jupiter', 'Saturn', 'Neptune'], correct: 0 },
    { prompt: 'What is the largest planet?', options: ['Saturn', 'Earth', 'Uranus', 'Jupiter'], correct: 3 },
    { prompt: 'How many planets are in the Solar System?', options: ['7', '9', '8', '10'], correct: 2 },
    { prompt: 'Which planet has the most famous rings?', options: ['Saturn', 'Mars', 'Venus', 'Mercury'], correct: 0 },
  ],
};
// Pre-completed attempts (number of correct answers). Sam and Noah stay pending.
const DONE: Record<string, number> = { 'aisha@demo.jora': 5, 'leo@demo.jora': 4, 'maya@demo.jora': 4 };

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL) throw new Error('Missing env, see .env.example');
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const existing = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (existing.error) throw existing.error;
  const ids: Record<string, string> = {};
  for (const u of USERS) {
    let id = existing.data.users.find((x) => x.email === u.email)?.id;
    if (!id) {
      const { data, error } = await admin.auth.admin.createUser({
        email: u.email, password: PASSWORD, email_confirm: true,
        user_metadata: { role: u.role, display_name: u.name },
      });
      if (error) throw error;
      id = data.user.id;
      console.log(`created ${u.email}`);
    }
    ids[u.email] = id;
    await db.query(
      `insert into profiles (id, email, display_name, role) values ($1, $2, $3, $4)
       on conflict (id) do update set display_name = excluded.display_name, role = excluded.role`,
      [id, u.email, u.name, u.role],
    );
  }

  const teacherId = ids['teacher@demo.jora'];
  const has = await db.query('select id from quizzes where teacher_id = $1 and title = $2', [teacherId, QUIZ.title]);
  if (has.rowCount) {
    console.log('sample quiz already present');
  } else {
    await db.query('begin');
    const quizId = (await db.query('insert into quizzes (teacher_id, title, description) values ($1,$2,$3) returning id',
      [teacherId, QUIZ.title, QUIZ.description])).rows[0].id;
    const qIds: { id: string; correct: string; wrong: string }[] = [];
    for (const [i, q] of QUIZ.questions.entries()) {
      const qid = (await db.query('insert into questions (quiz_id, position, prompt) values ($1,$2,$3) returning id', [quizId, i, q.prompt])).rows[0].id;
      const opts: string[] = [];
      for (const [j, label] of q.options.entries()) {
        opts.push((await db.query('insert into question_options (question_id, position, label, is_correct) values ($1,$2,$3,$4) returning id',
          [qid, j, label, j === q.correct])).rows[0].id);
      }
      qIds.push({ id: qid, correct: opts[q.correct], wrong: opts[(q.correct + 1) % 4] });
    }
    for (const u of USERS.filter((u) => u.role === 'student')) {
      const aid = (await db.query('insert into assignments (quiz_id, student_id) values ($1,$2) returning id', [quizId, ids[u.email]])).rows[0].id;
      const n = DONE[u.email];
      if (n === undefined) continue;
      const total = qIds.length;
      const att = (await db.query('insert into attempts (assignment_id, total_questions, correct_count, accuracy) values ($1,$2,$3,$4) returning id',
        [aid, total, n, Math.round((n * 10000) / total) / 100])).rows[0].id;
      for (const [i, q] of qIds.entries()) {
        const right = i < n;
        await db.query('insert into attempt_answers values ($1,$2,$3,$4)', [att, q.id, right ? q.correct : q.wrong, right]);
      }
    }
    await db.query('commit');
    console.log('sample quiz created and assigned');
  }
  await db.end();
  console.log(`\nDemo password for all accounts: ${PASSWORD}`);
  USERS.forEach((u) => console.log(`  ${u.role.padEnd(7)} ${u.email}`));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
