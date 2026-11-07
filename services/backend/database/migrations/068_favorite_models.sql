-- Models a user starred in the chat model picker, as "<endpoint id>::<model id>".
ALTER TABLE users ADD COLUMN favorite_models JSONB NOT NULL DEFAULT '[]'::jsonb;
