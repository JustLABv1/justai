CREATE TABLE transcription_summary_templates (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 created_by UUID REFERENCES users(id) ON DELETE SET NULL,
 settings JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (id, organization_id)
);
CREATE INDEX transcription_summary_templates_organization ON transcription_summary_templates(organization_id);

CREATE TABLE transcription_summary_template_choices (
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 template_id UUID,
 PRIMARY KEY (organization_id, user_id),
 FOREIGN KEY (template_id, organization_id) REFERENCES transcription_summary_templates(id, organization_id) ON DELETE CASCADE
);
