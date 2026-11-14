export type Role = 'teacher' | 'student';

/** What the token verifier returns: identity proven by Supabase Auth. */
export interface VerifiedUser {
  id: string;
  email: string;
  metadata: Record<string, unknown>;
}

/** What controllers see: identity plus the role stored in our profiles table. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}
