import { Controller, Get } from '@nestjs/common';
import { AttemptsService } from '../attempts/attempts.service';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { QuizzesService } from '../quizzes/quizzes.service';

@Controller()
export class ProfilesController {
  constructor(private readonly quizzes: QuizzesService, private readonly attempts: AttemptsService) {}

  @Get('health') @Public()
  health() {
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return u;
  }

  @Get('me/assignments') @Roles('student')
  myAssignments(@CurrentUser() u: AuthUser) {
    return this.attempts.myAssignments(u.id);
  }

  @Get('students') @Roles('teacher')
  students() {
    return this.quizzes.listStudents();
  }
}
