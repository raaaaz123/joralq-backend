import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { DbService } from '../db/db.service';
import { CreateQuizDto } from './dto';
import { QuizAccessService } from './quiz-access.service';

const num = (v: string | number | null) => (v === null ? null : Number(v));

@Injectable()
export class QuizzesService {
  constructor(private readonly db: DbService, private readonly access: QuizAccessService) {}

  async create(teacherId: string, dto: CreateQuizDto) {
    const quizId = await this.db.tx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        'insert into quizzes (teacher_id, title, description) values ($1, $2, $3) returning id',
        [teacherId, dto.title, dto.description ?? ''],
      );
      const id = rows[0].id;

      // Bulk insert questions, then options, in two statements total.
      const qs = await c.query<{ id: string; position: number }>(
        `insert into questions (quiz_id, position, prompt)
         select $1, p - 1, prompt from unnest($2::text[]) with ordinality as t(prompt, p)
         returning id, position`,
        [id, dto.questions.map((q) => q.prompt)],
      );
      const qid = new Map(qs.rows.map((r) => [r.position, r.id]));

      const optQ: string[] = [], optPos: number[] = [], optLabel: string[] = [], optCorrect: boolean[] = [];
      dto.questions.forEach((q, i) =>
        q.options.forEach((label, j) => {
          optQ.push(qid.get(i)!);
          optPos.push(j);
          optLabel.push(label);
          optCorrect.push(j === q.correctIndex);
        }),
      );
      await c.query(
        `insert into question_options (question_id, position, label, is_correct)
         select * from unnest($1::uuid[], $2::smallint[], $3::text[], $4::boolean[])`,
        [optQ, optPos, optLabel, optCorrect],
      );
      return id;
    });
    return this.detail(quizId, true);
  }

  /** Teacher dashboard: own quizzes with headline stats, one query. */
  async listForTeacher(teacherId: string) {
    const rows = await this.db.query(
      `select q.id, q.title, q.description, q.created_at,
              (select count(*) from questions where quiz_id = q.id)::int as question_count,
              count(a.id)::int  as assigned_count,
              count(at.id)::int as completed_count,
              round(avg(at.accuracy), 2) as average_accuracy
         from quizzes q
         left join assignments a on a.quiz_id = q.id
         left join attempts at on at.assignment_id = a.id
        where q.teacher_id = $1
        group by q.id
        order by q.created_at desc`,
      [teacherId],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      createdAt: r.created_at,
      questionCount: r.question_count,
      assignedCount: r.assigned_count,
      completedCount: r.completed_count,
      averageAccuracy: num(r.average_accuracy),
    }));
  }

  /**
   * Teachers (owners) get the answer key. Students get questions and options
   * only: is_correct is never selected for them, so it cannot leak.
   */
  async getForUser(quizId: string, user: AuthUser) {
    if (user.role === 'teacher') {
      await this.access.assertOwner(quizId, user.id);
      return this.detail(quizId, true);
    }
    const { assignmentId } = await this.access.assertAssigned(quizId, user.id);
    const quiz = await this.detail(quizId, false);
    const attempt = await this.db.one('select id from attempts where assignment_id = $1', [assignmentId]);
    return { ...quiz, status: attempt ? 'completed' : 'pending' };
  }

  async detail(quizId: string, withAnswers: boolean) {
    const quiz = await this.access.getQuiz(quizId);
    const rows = await this.db.query(
      `select qu.id as question_id, qu.position as qpos, qu.prompt,
              o.id as option_id, o.position as opos, o.label
              ${withAnswers ? ', o.is_correct' : ''}
         from questions qu
         join question_options o on o.question_id = qu.id
        where qu.quiz_id = $1
        order by qu.position, o.position`,
      [quizId],
    );
    const questions: any[] = [];
    for (const r of rows) {
      let q = questions[questions.length - 1];
      if (!q || q.id !== r.question_id) {
        q = { id: r.question_id, position: r.qpos, prompt: r.prompt, options: [] };
        questions.push(q);
      }
      q.options.push({ id: r.option_id, label: r.label, ...(withAnswers ? { isCorrect: r.is_correct } : {}) });
    }
    return {
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      createdAt: quiz.created_at,
      questionCount: questions.length,
      questions,
    };
  }

  async assign(quizId: string, teacherId: string, studentIds: string[]) {
    await this.access.assertOwner(quizId, teacherId);

    const valid = await this.db.query<{ id: string }>(
      `select id from profiles where role = 'student' and id = any($1::uuid[])`,
      [studentIds],
    );
    const validIds = new Set(valid.map((r) => r.id));
    const invalid = studentIds.filter((id) => !validIds.has(id));
    if (invalid.length) {
      throw new BadRequestException({ message: ['These ids are not students: ' + invalid.join(', ')] });
    }

    const inserted = await this.db.query(
      `insert into assignments (quiz_id, student_id)
       select $1, unnest($2::uuid[])
       on conflict (quiz_id, student_id) do nothing
       returning student_id`,
      [quizId, studentIds],
    );
    return { assigned: inserted.length, alreadyAssigned: studentIds.length - inserted.length };
  }

  async analytics(quizId: string, teacherId: string) {
    const quiz = await this.access.assertOwner(quizId, teacherId);
    const [{ question_count }] = await this.db.query(
      'select count(*)::int as question_count from questions where quiz_id = $1',
      [quizId],
    );
    const rows = await this.db.query(
      `select p.id, p.display_name, p.email, a.assigned_at,
              at.correct_count, at.total_questions, at.accuracy, at.submitted_at
         from assignments a
         join profiles p on p.id = a.student_id
         left join attempts at on at.assignment_id = a.id
        where a.quiz_id = $1
        order by (at.id is null), at.accuracy desc nulls last, p.display_name`,
      [quizId],
    );
    const students = rows.map((r) => ({
      studentId: r.id,
      displayName: r.display_name,
      email: r.email,
      assignedAt: r.assigned_at,
      status: r.submitted_at ? 'completed' : 'pending',
      correctAnswers: r.correct_count ?? null,
      totalQuestions: r.total_questions ?? question_count,
      accuracy: num(r.accuracy),
      submittedAt: r.submitted_at ?? null,
    }));
    const done = students.filter((s) => s.status === 'completed');
    const avg = done.length ? Math.round((done.reduce((s, x) => s + x.accuracy!, 0) / done.length) * 100) / 100 : null;
    return {
      quiz: { id: quiz.id, title: quiz.title, description: quiz.description, questionCount: question_count },
      assignedCount: students.length,
      completedCount: done.length,
      pendingCount: students.length - done.length,
      averageAccuracy: avg,
      students,
    };
  }

  async listStudents() {
    const rows = await this.db.query(
      `select id, display_name, email from profiles where role = 'student' order by display_name, email`,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email }));
  }
}
