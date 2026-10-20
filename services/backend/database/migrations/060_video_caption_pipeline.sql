ALTER TABLE transcription_video_uploads
    ADD COLUMN caption_options JSONB,
    ADD COLUMN caption_run_id UUID REFERENCES transcription_speaker_caption_runs(id) ON DELETE SET NULL;
