
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_window_settings_user_id ON window_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_window_settings_created_at ON window_settings(created_at);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Table to store issued tokens (store token hashes, not raw tokens)
CREATE TABLE IF NOT EXISTS user_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  jti VARCHAR(255) UNIQUE, -- optional JWT ID claim
  token_hash VARCHAR(512) NOT NULL,
  type VARCHAR(20) DEFAULT 'access', -- access, refresh, admin, etc.
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP,
  revoked BOOLEAN DEFAULT FALSE,
  ip_address VARCHAR(45),
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_tokens_user_id ON user_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tokens_revoked ON user_tokens(revoked);
CREATE INDEX IF NOT EXISTS idx_user_tokens_expires_at ON user_tokens(expires_at);
