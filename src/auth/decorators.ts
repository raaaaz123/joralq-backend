import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { AuthUser, Role } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

/** Skip authentication (health check only). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restrict a route or controller to the given roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
