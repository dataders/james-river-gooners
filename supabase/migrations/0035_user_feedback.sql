-- User-submitted feedback from the in-app hamburger menu.
-- INSERT is open to any visitor (anon or authenticated); SELECT is blocked
-- for anon/auth roles — only the service role (used by the GitHub Action)
-- reads rows. The Action marks each row processed_at after creating an issue.
CREATE TABLE IF NOT EXISTS user_feedback (
  id                uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  message           text         NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  user_email        text,
  submitted_at      timestamptz  DEFAULT now(),
  github_issue_url  text,
  processed_at      timestamptz
);

ALTER TABLE user_feedback ENABLE ROW LEVEL SECURITY;

-- Any visitor (anon or signed-in) may INSERT feedback; nobody reads it via
-- the browser — the service-role Actions job reads it, bypassing RLS.
CREATE POLICY "Anyone can submit feedback"
  ON user_feedback FOR INSERT
  WITH CHECK (true);
