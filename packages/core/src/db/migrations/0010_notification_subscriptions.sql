-- Notification subscriptions table
CREATE TABLE notification_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_login TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  event_types TEXT[] NOT NULL DEFAULT ARRAY['new_mission', 'claimed', 'resolved'],
  github_issue_number INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_login, repo_id)
);

-- Index for finding subscriptions by repo
CREATE INDEX idx_notification_subscriptions_repo_id ON notification_subscriptions(repo_id);
CREATE INDEX idx_notification_subscriptions_user_login ON notification_subscriptions(user_login);

-- Trigger for updated_at (using existing function)
-- Note: we only have created_at, no updated_at for subscriptions