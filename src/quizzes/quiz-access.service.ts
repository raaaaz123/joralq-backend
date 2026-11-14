import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { DbService, Queryable } from '../db/db.service';

export interface QuizRow {
  id: string;
  teacher_id: string;
  title: string;
  description: string;
  created_at: Date;
}

/**
 * Central ownership / assignment checks so every endpoint applies the same rules:
 *   404 if the quiz does not exist,
 *   403 if a teacher does not own it or a student is not assigned to it.
 */
@Injectable()
export class QuizAccessService {
  constructor(private readonly db: DbService) {}

  async getQuiz(quizId: string, q: Queryable = this.db.pool): Promise<QuizRow> {
    const { rows } = await q.query<QuizRow>(
      'select id, teacher_id, title, description, created_at from quizzes where id = $1',
      [quizId],
    );
    if (!rows[0]) throw new NotFoundException('Quiz not found');
    return rows[0];
  }

  async assertOwner(quizId: string, teacherId: string): Promise<QuizRow> {
    const quiz = await this.getQuiz(quizId);
    if (quiz.teacher_id !== teacherId) throw new ForbiddenException('You do not own this quiz');
    return quiz;
  }

  /** Returns the assignment id for a student, or throws. */
  async assertAssigned(quizId: string, studentId: string, q: Queryable = this.db.pool, lock = false) {
    const quiz = await this.getQuiz(quizId, q);
    const { rows } = await q.query<{ id: string }>(
      `select id from assignments where quiz_id = $1 and student_id = $2 ${lock ? 'for update' : ''}`,
      [quizId, studentId],
    );
    if (!rows[0]) throw new ForbiddenException('This quiz is not assigned to you');
    return { quiz, assignmentId: rows[0].id };
  }

  /** Teacher-owner or assigned student. */
  async assertCanView(quizId: string, user: AuthUser): Promise<QuizRow> {
    if (user.role === 'teacher') return this.assertOwner(quizId, user.id);
    return (await this.assertAssigned(quizId, user.id)).quiz;
  }
}
