CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password text NOT NULL
);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'student'
  CHECK (role IN ('student','teacher'));
CREATE TABLE IF NOT EXISTS login_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX IF NOT EXISTS login_sessions_user ON login_sessions(user_id);
CREATE INDEX IF NOT EXISTS login_sessions_expiry ON login_sessions(expires_at);
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Новый диалог',
  summary text NOT NULL DEFAULT '',
  summary_through bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_expiry ON conversations(updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS facts (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key IN ('group','course','subject')),
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS facts_expiry ON facts(expires_at);
CREATE TABLE IF NOT EXISTS confirmations (
  conversation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('group','course','subject','forget')),
  value text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS confirmations_expiry ON confirmations(expires_at);
CREATE TABLE IF NOT EXISTS manual_refreshes (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  refreshed_on date NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id text PRIMARY KEY,
  title text NOT NULL,
  url text NOT NULL,
  topic text NOT NULL,
  version text NOT NULL,
  body text NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  valid_from date,
  valid_until date,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian', title || ' ' || topic), 'A') ||
    setweight(to_tsvector('russian', body), 'B')
  ) STORED,
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);
CREATE INDEX IF NOT EXISTS documents_approved_search ON documents USING gin(search_vector) WHERE approved;
