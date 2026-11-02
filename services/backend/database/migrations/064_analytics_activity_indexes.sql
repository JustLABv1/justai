-- Platform analytics filters across workspaces by time and actor.
CREATE INDEX IF NOT EXISTS chat_runs_started_user_analytics_idx ON chat_runs(started_at, user_id, organization_id);
CREATE INDEX IF NOT EXISTS agent_runs_created_analytics_idx ON agent_runs(created_at, user_id, organization_id);
CREATE INDEX IF NOT EXISTS transcription_sessions_created_analytics_idx ON transcription_sessions(created_at, user_id, organization_id);
CREATE INDEX IF NOT EXISTS audit_events_actor_created_analytics_idx ON audit_events(user_id, created_at DESC);
