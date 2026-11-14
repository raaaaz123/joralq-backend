import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { VerifiedUser } from '../src/auth/auth.types';
import { TokenVerifier } from '../src/auth/token-verifier';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/quiz_test';

/**
 * Stands in for Supabase Auth: a token "test:<uuid>" is valid for that user.
 * Everything after authentication (profiles, roles, ownership, grading) runs
 * the real code against a real Postgres.
 */
export class FakeVerifier extends TokenVerifier {
  users = new Map<string, VerifiedUser>();
  async verify(token: string) {
    return token.startsWith('test:') ? this.users.get(token.slice(5)) ?? null : null;
  }
}

export async function resetDb() {
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('drop schema public cascade; create schema public;');
  await c.query(readFileSync(join(__dirname, '../supabase/migrations/001_schema.sql'), 'utf8'));
  await c.end();
}

export async function createApp() {
  process.env.DATABASE_URL = TEST_DB;
  process.env.SUPABASE_URL ??= 'http://unused.local';
  process.env.SUPABASE_ANON_KEY ??= 'unused';
  const verifier = new FakeVerifier();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TokenVerifier)
    .useValue(verifier)
    .compile();
  const app: INestApplication = mod.createNestApplication();
  configureApp(app);
  await app.init();

  /** Registers a user the way Supabase sign-up would (role in metadata). */
  const user = (role: 'teacher' | 'student', name: string) => {
    const id = randomUUID();
    verifier.users.set(id, { id, email: `${name.toLowerCase()}@test.local`, metadata: { role, display_name: name } });
    return { id, name, auth: { Authorization: `Bearer test:${id}` } };
  };
  return { app, user };
}
