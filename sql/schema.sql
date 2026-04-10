CREATE TABLE IF NOT EXISTS settings (
    id SERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL UNIQUE,
    auto_message TEXT,
    auto_message_enabled BOOLEAN NOT NULL DEFAULT false,
    auto_message_interval_minutes INTEGER NOT NULL DEFAULT 30,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL UNIQUE,
    username VARCHAR(255),
    full_name VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS forbidden_words (
    id SERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL,
    word VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_offenses (
    id SERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    offense_type VARCHAR(50) NOT NULL,
    offense_count INTEGER NOT NULL DEFAULT 1,
    last_offense_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(group_id, user_id, offense_type)
);

CREATE TABLE IF NOT EXISTS broadcast_logs (
    id SERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL,
    admin_user_id BIGINT NOT NULL,
    message TEXT NOT NULL,
    sent_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO settings (group_id, auto_message, auto_message_enabled, auto_message_interval_minutes)
VALUES (-1001234567890, 'Partagez vos vidéos', false, 30)
ON CONFLICT (group_id) DO NOTHING;
