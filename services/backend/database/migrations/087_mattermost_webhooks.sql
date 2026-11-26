-- Mattermost incoming webhooks, with Markdown instead of Slack's link syntax.
ALTER TABLE notification_webhooks DROP CONSTRAINT notification_webhooks_format_check;
ALTER TABLE notification_webhooks ADD CONSTRAINT notification_webhooks_format_check
    CHECK (format IN ('json', 'slack', 'mattermost', 'teams', 'discord'));
