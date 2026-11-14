# JoraIQ.AI: quiz-based learning and analytics

Two repositories: [joralq-backend](https://github.com/raaaaz123/joralq-backend) (NestJS API, database migrations, tests) and [joralq-frontend](https://github.com/raaaaz123/joralq-frontend) (Next.js app). Clone both side by side as `backend/` and `frontend/` to follow the paths below.

Teachers create multiple-choice quizzes and assign them to students. Students take each quiz once, get a server-graded score and see where they rank. Teachers watch completion and accuracy per quiz and per student.

| | |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| Backend | NestJS 11, TypeScript, `pg` (raw SQL) |
| Auth | Supabase Auth (email + password) |
| Database | Supabase PostgreSQL |
| Tests | Jest + Supertest against a real Postgres |

```
.
├── backend/                 NestJS REST API (all business logic + DB access)
│   ├── src/
│   │   ├── auth/            token verification, global guard, @Roles/@CurrentUser
│   │   ├── quizzes/         quiz CRUD, assignment, analytics, ownership checks
│   │   ├── attempts/        submission + grading, results, leaderboard
│   │   ├── profiles/        /me, /students, /me/assignments, /health
│   │   ├── common/          global error filter (one error shape)
│   │   └── db/              pg pool + transaction helper
│   ├── scripts/             migrate.ts, seed.ts
│   ├── supabase/migrations/ 001_schema.sql (portable), 002_supabase_auth.sql (trigger + RLS)
│   └── test/                e2e + unit tests
└── frontend/                Next.js app (teacher + student UIs)
```

## Architecture

```
Browser (Next.js) ──signUp / signIn / refresh──▶ Supabase Auth
       │
       │  REST + "Authorization: Bearer <supabase access token>"
       ▼
NestJS API ──auth.getUser(token)──▶ Supabase Auth      (who is this?)
       │
       └──SQL over a pooled connection──▶ Supabase Postgres   (role, ownership, data)
```

* **The browser only talks to Supabase for auth.** Every quiz, assignment, submission and analytics call goes to NestJS. The frontend holds only the public anon key.
* **NestJS validates every request.** A global `AuthGuard` verifies the bearer token with Supabase Auth (`auth.getUser`, cached for 60 s per token), then loads the caller's **role from the `profiles` table**, never from the token. `@Roles('teacher')` / `@Roles('student')` on routes enforces role-based access.
* **Ownership and assignment checks** live in one place (`QuizAccessService`): 404 if the quiz does not exist, 403 if a teacher does not own it or a student is not assigned to it.
* **Tables are locked away from PostgREST.** Migration 002 enables RLS with no policies, so the anon key in the browser cannot read or write quiz data directly. NestJS connects as the database owner and bypasses RLS.
* **Grading is server-side only.** The student quiz endpoint never selects `is_correct`; the answer key is returned only in the result review, which exists only after an attempt is stored.

### Data model (normalized)

```
profiles (id = auth.users.id, email, display_name, role teacher|student)
quizzes (id, teacher_id → profiles, title, description)
questions (id, quiz_id → quizzes, position, prompt)          unique (quiz_id, position)
question_options (id, question_id → questions, position 0-3, label, is_correct)
                                                             unique (question_id, position)
                                                             unique (question_id) where is_correct  ← one correct answer
assignments (id, quiz_id → quizzes, student_id → profiles)   unique (quiz_id, student_id)
attempts (id, assignment_id → assignments UNIQUE, total_questions, correct_count, accuracy, submitted_at)
attempt_answers (attempt_id, question_id) PK, selected_option_id, is_correct
```

`attempts` stores the score computed at submit time (`correct_count`, `accuracy`). This is a deliberate snapshot: analytics and leaderboards read it directly instead of re-grading on every view, and quizzes are immutable after creation so it cannot drift.

### Key behaviours

| Rule | How |
|---|---|
| One submission per assignment | Transaction locks the assignment row (`FOR UPDATE`) and checks for an attempt → **409**. `attempts.assignment_id UNIQUE` is the backstop for races (also mapped to 409). Covered by a concurrent-submit test. |
| Answer all questions | Submission must answer every question exactly once with an option belonging to that question, else **400** listing the problems. A rejected submission does not consume the attempt. |
| Leaderboard ranking | `RANK() OVER (ORDER BY accuracy DESC)`: equal accuracy shares a rank and the next rank is skipped (1, 2, 2, 4). Only rows in `attempts` (completed) appear. Ties are listed by submission time. |
| Leaderboard access | Assigned students and the owning teacher only (403 otherwise). |
| Role cannot be self-promoted | Role is copied from sign-up metadata into `profiles` once (DB trigger, with a guard fallback). Later edits to a user's own auth metadata do not change it. |
| Errors | Global filter returns `{ statusCode, error, message, details?, path, timestamp }`. Validation errors are 400 with `details[]`; Postgres unique/check/FK errors map to 409/400; unexpected errors are 500 with no internals. |

## API

All routes except `/health` need `Authorization: Bearer <Supabase access token>`.

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/health` | public | Liveness |
| GET | `/me` | any | Authenticated user's profile and role |
| GET | `/students` | teacher | All students (for assignment) |
| POST | `/quizzes` | teacher | Create quiz `{ title, description?, questions: [{ prompt, options[4], correctIndex }] }` |
| GET | `/quizzes` | teacher | Own quizzes with question count, assigned, completed, average accuracy |
| GET | `/quizzes/:id` | owner teacher / assigned student | Teacher gets the answer key; student gets questions without it plus `status` |
| POST | `/quizzes/:id/assignments` | owner teacher | `{ studentIds: uuid[] }` → `{ assigned, alreadyAssigned }` (idempotent) |
| GET | `/quizzes/:id/analytics` | owner teacher | Assigned/completed/pending counts, average accuracy, per-student score, accuracy, status |
| GET | `/me/assignments` | student | Assigned quizzes with question count, status and score |
| POST | `/quizzes/:id/attempts` | assigned student | `{ answers: [{ questionId, optionId }] }` → graded result (201), 409 on resubmit |
| GET | `/quizzes/:id/result` | assigned student | Result + per-question review (404 before submitting) |
| GET | `/quizzes/:id/leaderboard` | assigned student / owner teacher | Ranked entries, `me`, participant count |

## Local setup

Requirements: Node 22+, a Supabase project (free tier is fine). For tests: a local Postgres 14+.

### 1. Database

In the Supabase dashboard → SQL editor, run `backend/supabase/migrations/001_schema.sql` then `002_supabase_auth.sql`. Or from `backend/` with `DATABASE_URL` set:

```bash
npm run migrate      # applies both files; 002 is skipped on a non-Supabase Postgres
```

For a smooth demo, turn off **Authentication → Providers → Email → Confirm email** (otherwise new sign-ups get a confirmation link first; the UI handles both).

### 2. Backend

```bash
cd backend
cp .env.example .env   # fill in values, see below
npm install
npm run seed           # optional: demo accounts + a sample quiz with attempts
npm run dev            # http://localhost:4000
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres connection string (session pooler or direct) |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | Used to verify access tokens |
| `SUPABASE_SERVICE_ROLE_KEY` | **Seed script only, optional.** Without it the seed creates the demo logins directly in SQL. Never used by the running API or the frontend |
| `CORS_ORIGINS` | Comma-separated allowed origins, e.g. `http://localhost:3000` |
| `PORT` | Defaults to 4000 |

### 3. Frontend

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev            # http://localhost:3000
```

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key |
| `NEXT_PUBLIC_API_URL` | NestJS base URL, e.g. `http://localhost:4000` |

### Demo accounts (`npm run seed`)

Password for all: `Demo@1234`

| Role | Email |
|---|---|
| Teacher | `teacher@demo.jora` |
| Student | `student@demo.jora` (has a pending quiz to take) |
| Students | `aisha@demo.jora`, `leo@demo.jora`, `maya@demo.jora` (already completed), `noah@demo.jora` (pending) |

The login page has one-click buttons that fill the teacher and student demo credentials.

## Tests

The e2e suite boots the real Nest app (same validation pipe, guard and error filter as production) against a real Postgres. Only the Supabase token check is replaced with a fake verifier (`test:<userId>` tokens), so everything after authentication (profiles, roles, ownership, grading, ranking) is the production code path.

```bash
# one-time: local Postgres + empty test database
brew install postgresql@17 && brew services start postgresql@17
createdb quiz_test

cd backend
npm test                                   # uses postgresql://localhost:5432/quiz_test
TEST_DATABASE_URL=postgres://... npm test  # or point at any disposable database (it is wiped)
```

| Requirement | Test (`backend/test/quiz.e2e.spec.ts`) |
|---|---|
| 1. Successful submission + score | `accepts a submission and scores it on the server` (2/3 → 66.67%) |
| 2. Second submission rejected | `rejects a second submission for the same assignment (409)` + `allows only one of two concurrent submissions` |
| 3. Unassigned quiz rejected | `rejects a student attempting an unassigned quiz (403)` |
| 4. Teacher-only operation rejected | `rejects students calling teacher-only operations (403)` |
| 5. Equal scores, equal rank | `ranks equal accuracy with equal rank and skips the next rank` (1, 2, 2, 4) |

Also covered: 401 without a session, answer key never sent before submission, teachers blocked from quizzes they do not own, validation error shape, incomplete submissions, completed-only leaderboard, analytics counts. `accuracy.spec.ts` unit-tests the rounding.

## Assumptions and trade-offs

* **Self-selected role at sign-up.** Anyone can register as a teacher. A real deployment would invite teachers or require admin approval. The role is still fixed server-side after creation.
* **All students are visible to every teacher** when assigning. There is no class/school grouping; a `classes` table would scope this.
* **Quizzes are immutable** once created (no edit/delete in the UI or API). This keeps stored scores consistent with the questions they were graded against.
* **Raw SQL with `pg`** instead of an ORM: the analytics and leaderboard queries are aggregate/window queries that are clearer in SQL, and every endpoint runs a fixed small number of queries (no N+1).
* **Token verification calls Supabase Auth** (`auth.getUser`) instead of verifying the JWT locally. It works with any Supabase signing-key setup and rejects deleted users; the 60 s per-token cache keeps it to about one round trip per page.
* **Leaderboard shows display names** of all finishers to every assigned student, as the brief asks. Emails are only shown to teachers.
* **Accuracy** is `correct / total × 100`, rounded to 2 decimals and stored as `numeric(5,2)`; ranking compares the stored value.
* **Client-side session** (Supabase JS in local storage) with client-rendered pages. Server-side rendering with cookie sessions (`@supabase/ssr`) would avoid the brief loading state on first paint.

## Known limitations

* No quiz editing, deletion, time limits, question shuffling or draft saving mid-attempt (answers live in page state until submit).
* No pagination on student or quiz lists (fine for class-sized data).
* No password reset flow in the UI (Supabase supports it; not wired up).
* After logout, the API can keep accepting that access token for up to 60 s because of the token-check cache. Lowering `TTL_MS` in `token-verifier.ts` trades this window for more calls to Supabase Auth.
* No rate limiting on the API; put it behind the hosting platform's limits or add `@nestjs/throttler` before real traffic.
* No frontend tests; the automated tests cover the API.
