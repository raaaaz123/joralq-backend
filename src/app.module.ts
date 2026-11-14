import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AttemptsService } from './attempts/attempts.service';
import { AuthGuard } from './auth/auth.guard';
import { SupabaseTokenVerifier, TokenVerifier } from './auth/token-verifier';
import { DbService } from './db/db.service';
import { ProfilesController } from './profiles/profiles.controller';
import { QuizAccessService } from './quizzes/quiz-access.service';
import { QuizzesController } from './quizzes/quizzes.controller';
import { QuizzesService } from './quizzes/quizzes.service';

@Module({
  controllers: [ProfilesController, QuizzesController],
  providers: [
    DbService,
    QuizAccessService,
    QuizzesService,
    AttemptsService,
    { provide: TokenVerifier, useClass: SupabaseTokenVerifier },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
