import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { VerifiedUser } from './auth.types';

/** Swappable so tests can run without a Supabase project. */
export abstract class TokenVerifier {
  abstract verify(accessToken: string): Promise<VerifiedUser | null>;
}

/**
 * Validates a Supabase access token by asking Supabase Auth (auth.getUser).
 * This works for both legacy HS256 and asymmetric signing keys and rejects
 * tokens of users that were deleted. Results are cached briefly so a page
 * that fires several API calls only costs one round trip.
 */
@Injectable()
export class SupabaseTokenVerifier extends TokenVerifier {
  private readonly client: SupabaseClient;
  private readonly cache = new Map<string, { user: VerifiedUser; until: number }>();
  private static readonly TTL_MS = 60_000;

  constructor() {
    super();
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
    this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async verify(accessToken: string): Promise<VerifiedUser | null> {
    const now = Date.now();
    const hit = this.cache.get(accessToken);
    if (hit && hit.until > now) return hit.user;

    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error || !data.user) return null;

    const user: VerifiedUser = {
      id: data.user.id,
      email: data.user.email ?? '',
      metadata: (data.user.user_metadata ?? {}) as Record<string, unknown>,
    };
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(accessToken, { user, until: now + SupabaseTokenVerifier.TTL_MS });
    return user;
  }
}
