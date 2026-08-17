-- Keep failed assistant turns in the conversation history instead of dropping
-- them when the provider rejects a request or a stream fails.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_run_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_run_status_check
  CHECK (run_status IN ('running', 'requires-action', 'complete', 'incomplete', 'error'));
