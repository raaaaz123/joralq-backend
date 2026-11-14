import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { DbService } from '../db/db.service';
import { SubmitAttemptDto } from '../quizzes/dto';
import { QuizAccessService } from '../quizzes/quiz-access.service';

/** Accuracy as a percentage with two decimals, e.g. 2/3 -> 66.67. */
export function accuracyOf(correct: number, total: number): number {
  return total === 0 ? 0 : Math.round((correct * 10000) / total) / 100;
}

@Injectable()
export class AttemptsService {
  constructor(private readonly db: DbService, private readonly access: QuizAccessService) {}

  /** Student dashboard: assigned quizzes with question count and status. */
  async myAssignments(studentId: string) {
    const rows = await this.db.query(
      `select q.id, q.title, q.description, a.assigned_at, p.display_name as teacher_name,
              (select count(*) from questions where quiz_id = q.id)::int as question_count,
              at.correct_count, at.total_questions, at.accuracy, at.submitted_at
         from assignments a
         join quizzes q on q.id = a.quiz_id
         join profiles p on p.id = q.teacher_id
         left join attempts at on at.assignment_id = a.id
        where a.student_id = $1
        order by (at.id is not null), a.assigned_at desc`,
      [studentId],
    );
    return rows.map((r) => ({
      quizId: r.id,
      title: r.title,
      description: r.description,
      teacherName: r.teacher_name,
      assignedAt: r.assigned_at,
      questionCount: r.question_count,
      status: r.submitted_at ? 'completed' : 'pending',
      result: r.submitted_at
        ? { correctAnswers: r.correct_count, totalQuestions: r.total_questions, accuracy: Number(r.accuracy), submittedAt: r.submitted_at }
        : null,
    }));
  }

  /**
   * Grades on the server inside one transaction. The assignment row is locked
   * (FOR UPDATE) so two concurrent submits serialize; the second sees the first
   * attempt and gets 409. attempts.assignment_id is UNIQUE as a backstop.
   */
  async submit(quizId: string, studentId: string, dto: SubmitAttemptDto) {
    const attemptId = await this.db.tx(async (c) => {
      const { assignmentId } = await this.access.assertAssigned(quizId, studentId, c, true);

      const existing = await c.query('select 1 from attempts where assignment_id = $1', [assignmentId]);
      if (existing.rowCount) throw new ConflictException('You have already submitted this quiz');

      const { rows: opts } = await c.query<{ question_id: string; option_id: string; is_correct: boolean }>(
        `select qu.id as question_id, o.id as option_id, o.is_correct
           from questions qu join question_options o on o.question_id = qu.id
          where qu.quiz_id = $1`,
        [quizId],
      );
      const questionIds = new Set(opts.map((o) => o.question_id));
      const optionToQuestion = new Map(opts.map((o) => [o.option_id, o]));

      const errors: string[] = [];
      const seen = new Set<string>();
      for (const a of dto.answers) {
        if (!questionIds.has(a.questionId)) errors.push(`Question ${a.questionId} is not part of this quiz`);
        else if (seen.has(a.questionId)) errors.push(`Question ${a.questionId} was answered more than once`);
        else if (optionToQuestion.get(a.optionId)?.question_id !== a.questionId)
          errors.push(`Option ${a.optionId} does not belong to question ${a.questionId}`);
        seen.add(a.questionId);
      }
      const missing = [...questionIds].filter((id) => !seen.has(id));
      if (missing.length) errors.push(`Answer every question before submitting (${missing.length} unanswered)`);
      if (errors.length) throw new BadRequestException({ message: errors });

      const total = questionIds.size;
      const graded = dto.answers.map((a) => ({ ...a, correct: optionToQuestion.get(a.optionId)!.is_correct }));
      const correct = graded.filter((g) => g.correct).length;

      let id: string;
      try {
        const { rows } = await c.query<{ id: string }>(
          `insert into attempts (assignment_id, total_questions, correct_count, accuracy)
           values ($1, $2, $3, $4) returning id`,
          [assignmentId, total, correct, accuracyOf(correct, total)],
        );
        id = rows[0].id;
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException('You have already submitted this quiz');
        throw e;
      }
      await c.query(
        `insert into attempt_answers (attempt_id, question_id, selected_option_id, is_correct)
         select $1, * from unnest($2::uuid[], $3::uuid[], $4::boolean[])`,
        [id, graded.map((g) => g.questionId), graded.map((g) => g.optionId), graded.map((g) => g.correct)],
      );
      return id;
    });
    return this.resultByAttempt(attemptId);
  }

  async result(quizId: string, studentId: string) {
    const { assignmentId } = await this.access.assertAssigned(quizId, studentId);
    const row = await this.db.one('select id from attempts where assignment_id = $1', [assignmentId]);
    if (!row) throw new NotFoundException('You have not submitted this quiz yet');
    return this.resultByAttempt(row.id);
  }

  /** Includes the answer review: only reachable after an attempt exists. */
  private async resultByAttempt(attemptId: string) {
    const head = await this.db.one(
      `select at.*, q.id as quiz_id, q.title
         from attempts at join assignments a on a.id = at.assignment_id join quizzes q on q.id = a.quiz_id
        where at.id = $1`,
      [attemptId],
    );
    const rows = await this.db.query(
      `select qu.id as question_id, qu.prompt, o.id as option_id, o.label, o.is_correct,
              aa.selected_option_id
         from questions qu
         join question_options o on o.question_id = qu.id
         left join attempt_answers aa on aa.question_id = qu.id and aa.attempt_id = $1
        where qu.quiz_id = $2
        order by qu.position, o.position`,
      [attemptId, head.quiz_id],
    );
    const review: any[] = [];
    for (const r of rows) {
      let q = review[review.length - 1];
      if (!q || q.questionId !== r.question_id) {
        q = { questionId: r.question_id, prompt: r.prompt, selectedOptionId: r.selected_option_id, isCorrect: false, options: [] };
        review.push(q);
      }
      q.options.push({ id: r.option_id, label: r.label, isCorrect: r.is_correct });
      if (r.is_correct && r.option_id === r.selected_option_id) q.isCorrect = true;
    }
    return {
      quizId: head.quiz_id,
      title: head.title,
      status: 'completed' as const,
      totalQuestions: head.total_questions,
      correctAnswers: head.correct_count,
      incorrectAnswers: head.total_questions - head.correct_count,
      accuracy: Number(head.accuracy),
      submittedAt: head.submitted_at,
      review,
    };
  }

  /**
   * Standard competition ranking via RANK(): equal accuracy -> equal rank,
   * next rank skips (1, 1, 3). Only completed attempts exist in this join.
   */
  async leaderboard(quizId: string, user: AuthUser) {
    const quiz = await this.access.assertCanView(quizId, user);
    const rows = await this.db.query(
      `select p.id as student_id, p.display_name, at.correct_count, at.total_questions, at.accuracy, at.submitted_at,
              rank() over (order by at.accuracy desc)::int as rank
         from attempts at
         join assignments a on a.id = at.assignment_id
         join profiles p on p.id = a.student_id
        where a.quiz_id = $1
        order by rank, at.submitted_at, p.display_name`,
      [quizId],
    );
    const [{ assigned }] = await this.db.query('select count(*)::int as assigned from assignments where quiz_id = $1', [quizId]);
    const entries = rows.map((r) => ({
      rank: r.rank,
      displayName: r.display_name,
      correctAnswers: r.correct_count,
      totalQuestions: r.total_questions,
      accuracy: Number(r.accuracy),
      submittedAt: r.submitted_at,
      isCurrentUser: r.student_id === user.id,
    }));
    return {
      quiz: { id: quiz.id, title: quiz.title },
      assignedCount: assigned,
      participantCount: entries.length,
      me: entries.find((e) => e.isCurrentUser) ?? null,
      entries,
    };
  }
}
