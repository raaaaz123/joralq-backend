import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AttemptsService } from '../attempts/attempts.service';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { AssignQuizDto, CreateQuizDto, SubmitAttemptDto } from './dto';
import { QuizzesService } from './quizzes.service';

const Id = () => Param('id', new ParseUUIDPipe());

@Controller('quizzes')
export class QuizzesController {
  constructor(private readonly quizzes: QuizzesService, private readonly attempts: AttemptsService) {}

  @Post() @Roles('teacher')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateQuizDto) {
    return this.quizzes.create(u.id, dto);
  }

  @Get() @Roles('teacher')
  list(@CurrentUser() u: AuthUser) {
    return this.quizzes.listForTeacher(u.id);
  }

  /** Teacher owner: full quiz with answer key. Assigned student: no answer key. */
  @Get(':id')
  get(@Id() id: string, @CurrentUser() u: AuthUser) {
    return this.quizzes.getForUser(id, u);
  }

  @Post(':id/assignments') @Roles('teacher') @HttpCode(200)
  assign(@Id() id: string, @CurrentUser() u: AuthUser, @Body() dto: AssignQuizDto) {
    return this.quizzes.assign(id, u.id, dto.studentIds);
  }

  @Get(':id/analytics') @Roles('teacher')
  analytics(@Id() id: string, @CurrentUser() u: AuthUser) {
    return this.quizzes.analytics(id, u.id);
  }

  @Post(':id/attempts') @Roles('student')
  submit(@Id() id: string, @CurrentUser() u: AuthUser, @Body() dto: SubmitAttemptDto) {
    return this.attempts.submit(id, u.id, dto);
  }

  @Get(':id/result') @Roles('student')
  result(@Id() id: string, @CurrentUser() u: AuthUser) {
    return this.attempts.result(id, u.id);
  }

  @Get(':id/leaderboard')
  leaderboard(@Id() id: string, @CurrentUser() u: AuthUser) {
    return this.attempts.leaderboard(id, u);
  }
}
