import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DbService } from '../db/db.service';
import { AuthUser, Role, VerifiedUser } from './auth.types';
import { IS_PUBLIC, ROLES } from './decorators';
import { TokenVerifier } from './token-verifier';

/**
 * Global guard:
 *  1. requires a valid Supabase access token (Authorization: Bearer ...),
 *  2. loads the caller's role from the profiles table (never from the token),
 *  3. enforces @Roles(...) metadata.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly db: DbService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const verified = await this.verifier.verify(token);
    if (!verified) throw new UnauthorizedException('Invalid or expired session');

    const user = await this.loadProfile(verified);
    req.user = user;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles?.length && !roles.includes(user.role)) {
      throw new ForbiddenException(`This action requires the ${roles.join(' or ')} role`);
    }
    return true;
  }

  /**
   * On Supabase a trigger creates the profile at sign-up. The insert here is a
   * fallback (e.g. the trigger was not installed). Role comes from sign-up
   * metadata only on first creation; afterwards the stored row wins.
   */
  private async loadProfile(v: VerifiedUser): Promise<AuthUser> {
    const metaRole = v.metadata['role'] === 'teacher' ? 'teacher' : 'student';
    const metaName = typeof v.metadata['display_name'] === 'string' ? (v.metadata['display_name'] as string).trim() : '';
    const row = await this.db.one<{ id: string; email: string; display_name: string; role: Role }>(
      `with ins as (
         insert into profiles (id, email, display_name, role)
         values ($1, $2, $3, $4)
         on conflict (id) do nothing
         returning id, email, display_name, role
       )
       select * from ins
       union all
       select id, email, display_name, role from profiles where id = $1
       limit 1`,
      [v.id, v.email, (metaName || v.email.split('@')[0] || 'User').slice(0, 80), metaRole],
    );
    if (!row) throw new UnauthorizedException('Profile not found');
    return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
  }
}
