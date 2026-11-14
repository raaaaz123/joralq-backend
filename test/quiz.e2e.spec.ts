import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, resetDb } from './helpers';

type U = { id: string; name: string; auth: Record<string, string> };

describe('Quiz platform API (e2e)', () => {
  let app: INestApplication;
  let user: (role: 'teacher' | 'student', name: string) => U;
  let teacher: U, otherTeacher: U, s1: U, s2: U, s3: U, s4: U, outsider: U;
  let quiz: any;

  const http = () => request(app.getHttpServer());

  /** Answers the first `correct` questions right and the rest wrong. */
  const answers = (q: any, correct: number) =>
    q.questions.map((qu: any, i: number) => ({
      questionId: qu.id,
      optionId: qu.options.find((o: any) => o.isCorrect === i < correct).id,
    }));

  beforeAll(async () => {
    await resetDb();
    ({ app, user } = await createApp());
    teacher = user('teacher', 'Tara');
    otherTeacher = user('teacher', 'Omar');
    s1 = user('student', 'Ana');
    s2 = user('student', 'Ben');
    s3 = user('student', 'Cleo');
    s4 = user('student', 'Dev');
    outsider = user('student', 'Eve');
    // First authenticated call creates each profile (as the Supabase trigger would).
    for (const u of [teacher, otherTeacher, s1, s2, s3, s4, outsider]) await http().get('/me').set(u.auth).expect(200);

    const created = await http()
      .post('/quizzes')
      .set(teacher.auth)
      .send({
        title: 'Fractions',
        description: 'Basics',
        questions: [
          { prompt: '1/2 + 1/2?', options: ['1', '2', '1/4', '0'], correctIndex: 0 },
          { prompt: '1/4 of 8?', options: ['4', '2', '8', '1'], correctIndex: 1 },
          { prompt: '3/3 equals?', options: ['3', '0', '1/3', '1'], correctIndex: 3 },
        ],
      })
      .expect(201);
    quiz = created.body; // teacher view, includes isCorrect

    await http()
      .post(`/quizzes/${quiz.id}/assignments`)
      .set(teacher.auth)
      .send({ studentIds: [s1.id, s2.id, s3.id, s4.id] })
      .expect(200, { assigned: 4, alreadyAssigned: 0 });
  });

  afterAll(async () => app?.close());

  it('rejects requests without a valid session (401)', async () => {
    await http().get('/me').expect(401);
    const res = await http().get('/me').set({ Authorization: 'Bearer test:nope' }).expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, error: 'UNAUTHORIZED', path: '/me' });
  });

  it('never sends the answer key to a student before submission', async () => {
    const res = await http().get(`/quizzes/${quiz.id}`).set(s1.auth).expect(200);
    expect(res.body.status).toBe('pending');
    expect(JSON.stringify(res.body)).not.toContain('isCorrect');
  });

  // Requirement 1
  it('accepts a submission and scores it on the server', async () => {
    const res = await http().post(`/quizzes/${quiz.id}/attempts`).set(s1.auth).send({ answers: answers(quiz, 2) }).expect(201);
    expect(res.body).toMatchObject({ totalQuestions: 3, correctAnswers: 2, incorrectAnswers: 1, accuracy: 66.67, status: 'completed' });

    const result = await http().get(`/quizzes/${quiz.id}/result`).set(s1.auth).expect(200);
    expect(result.body.correctAnswers).toBe(2);
    const list = await http().get('/me/assignments').set(s1.auth).expect(200);
    expect(list.body[0]).toMatchObject({ quizId: quiz.id, questionCount: 3, status: 'completed' });
  });

  // Requirement 2
  it('rejects a second submission for the same assignment (409)', async () => {
    const res = await http().post(`/quizzes/${quiz.id}/attempts`).set(s1.auth).send({ answers: answers(quiz, 3) }).expect(409);
    expect(res.body.message).toMatch(/already submitted/);
    const result = await http().get(`/quizzes/${quiz.id}/result`).set(s1.auth).expect(200);
    expect(result.body.correctAnswers).toBe(2); // first score kept
  });

  it('allows only one of two concurrent submissions', async () => {
    const send = () => http().post(`/quizzes/${quiz.id}/attempts`).set(s4.auth).send({ answers: answers(quiz, 1) });
    const codes = (await Promise.all([send(), send()])).map((r) => r.status).sort();
    expect(codes).toEqual([201, 409]);
  });

  // Requirement 3
  it('rejects a student attempting an unassigned quiz (403)', async () => {
    await http().post(`/quizzes/${quiz.id}/attempts`).set(outsider.auth).send({ answers: answers(quiz, 3) }).expect(403);
    await http().get(`/quizzes/${quiz.id}`).set(outsider.auth).expect(403);
    await http().get(`/quizzes/${quiz.id}/leaderboard`).set(outsider.auth).expect(403);
  });

  // Requirement 4
  it('rejects students calling teacher-only operations (403)', async () => {
    const body = { title: 'x', questions: [{ prompt: 'q', options: ['a', 'b', 'c', 'd'], correctIndex: 0 }] };
    await http().post('/quizzes').set(s2.auth).send(body).expect(403);
    await http().get('/quizzes').set(s2.auth).expect(403);
    await http().get('/students').set(s2.auth).expect(403);
    await http().get(`/quizzes/${quiz.id}/analytics`).set(s2.auth).expect(403);
    await http().post(`/quizzes/${quiz.id}/assignments`).set(s2.auth).send({ studentIds: [s2.id] }).expect(403);
  });

  it('rejects teachers acting on quizzes they do not own (403)', async () => {
    await http().get(`/quizzes/${quiz.id}/analytics`).set(otherTeacher.auth).expect(403);
    await http().post(`/quizzes/${quiz.id}/assignments`).set(otherTeacher.auth).send({ studentIds: [outsider.id] }).expect(403);
  });

  it('validates input with a consistent error shape (400)', async () => {
    const res = await http()
      .post('/quizzes')
      .set(teacher.auth)
      .send({ title: '', questions: [{ prompt: 'q', options: ['a', 'b'], correctIndex: 7 }] })
      .expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: 'BAD_REQUEST', message: 'Validation failed' });
    expect(res.body.details.length).toBeGreaterThan(0);

    // Incomplete answers are refused and do not consume the attempt.
    await http().post(`/quizzes/${quiz.id}/attempts`).set(s2.auth).send({ answers: answers(quiz, 3).slice(0, 2) }).expect(400);
    // Assigning a teacher as a student is refused.
    await http().post(`/quizzes/${quiz.id}/assignments`).set(teacher.auth).send({ studentIds: [otherTeacher.id] }).expect(400);
  });

  // Requirement 5
  it('ranks equal accuracy with equal rank and skips the next rank', async () => {
    // s1 = 2/3 (above), s4 = 1/3 (concurrency test). Add s2 = 3/3, s3 = 2/3.
    await http().post(`/quizzes/${quiz.id}/attempts`).set(s2.auth).send({ answers: answers(quiz, 3) }).expect(201);
    await http().post(`/quizzes/${quiz.id}/attempts`).set(s3.auth).send({ answers: answers(quiz, 2) }).expect(201);

    const res = await http().get(`/quizzes/${quiz.id}/leaderboard`).set(s3.auth).expect(200);
    const board = res.body.entries.map((e: any) => [e.rank, e.displayName, e.accuracy]);
    expect(board).toEqual([
      [1, 'Ben', 100],
      [2, 'Ana', 66.67],
      [2, 'Cleo', 66.67],
      [4, 'Dev', 33.33],
    ]);
    expect(res.body.me).toMatchObject({ rank: 2, displayName: 'Cleo', isCurrentUser: true, correctAnswers: 2, totalQuestions: 3 });
    expect(res.body.entries.filter((e: any) => e.isCurrentUser)).toHaveLength(1);

    // Owner teacher can view it too.
    await http().get(`/quizzes/${quiz.id}/leaderboard`).set(teacher.auth).expect(200);
  });

  it('only completed attempts appear on the leaderboard; analytics shows everyone', async () => {
    const late = user('student', 'Finn');
    await http().get('/me').set(late.auth).expect(200);
    await http().post(`/quizzes/${quiz.id}/assignments`).set(teacher.auth).send({ studentIds: [late.id, s1.id] })
      .expect(200, { assigned: 1, alreadyAssigned: 1 });

    const lb = await http().get(`/quizzes/${quiz.id}/leaderboard`).set(late.auth).expect(200);
    expect(lb.body.entries.map((e: any) => e.displayName)).not.toContain('Finn');
    expect(lb.body.me).toBeNull();

    const a = await http().get(`/quizzes/${quiz.id}/analytics`).set(teacher.auth).expect(200);
    expect(a.body).toMatchObject({ assignedCount: 5, completedCount: 4, pendingCount: 1, averageAccuracy: 66.67 });
    expect(a.body.students.find((s: any) => s.displayName === 'Finn')).toMatchObject({ status: 'pending', accuracy: null });
  });
});
