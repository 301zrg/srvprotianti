BEGIN;

CREATE TABLE IF NOT EXISTS ladder_usage_sample (
  id BIGSERIAL PRIMARY KEY,
  "matchId" BIGINT NOT NULL,
  "playerName" VARCHAR(64) NOT NULL,
  "dayKey" VARCHAR(8) NOT NULL,
  "monthKey" VARCHAR(6) NOT NULL,
  "deckTypeId" INTEGER NOT NULL DEFAULT 4095,
  "cardValid" INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'missing',
  reason VARCHAR(64),
  "algorithmVersion" VARCHAR(32) NOT NULL DEFAULT '1',
  "catalogVersion" VARCHAR(280),
  "projectedAt" TIMESTAMP NOT NULL,
  CONSTRAINT uq_ladder_usage_match_player UNIQUE ("matchId", "playerName")
);
CREATE INDEX IF NOT EXISTS ix_ladder_usage_sample_day ON ladder_usage_sample ("dayKey");
CREATE INDEX IF NOT EXISTS ix_ladder_usage_sample_deck ON ladder_usage_sample ("deckTypeId", "dayKey");

CREATE TABLE IF NOT EXISTS ladder_deck_card_fact (
  id BIGSERIAL PRIMARY KEY,
  "sampleId" BIGINT NOT NULL REFERENCES ladder_usage_sample(id) ON DELETE CASCADE,
  "cardId" INTEGER NOT NULL,
  zone VARCHAR(12) NOT NULL,
  copies SMALLINT NOT NULL,
  CONSTRAINT uq_ladder_card_fact UNIQUE ("sampleId", "cardId", zone)
);
CREATE INDEX IF NOT EXISTS ix_ladder_card_fact_lookup ON ladder_deck_card_fact (zone, "cardId");

CREATE TABLE IF NOT EXISTS ladder_usage_daily_sample (
  "dayKey" VARCHAR(8) PRIMARY KEY,
  "allDecks" INTEGER NOT NULL DEFAULT 0,
  "validCardDecks" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ladder_usage_daily_deck (
  id BIGSERIAL PRIMARY KEY,
  "dayKey" VARCHAR(8) NOT NULL,
  "deckTypeId" INTEGER NOT NULL,
  "deckCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_ladder_usage_daily_deck UNIQUE ("dayKey", "deckTypeId")
);
CREATE TABLE IF NOT EXISTS ladder_usage_daily_card (
  id BIGSERIAL PRIMARY KEY,
  "dayKey" VARCHAR(8) NOT NULL,
  zone VARCHAR(12) NOT NULL,
  "cardId" INTEGER NOT NULL,
  "deckCount" INTEGER NOT NULL DEFAULT 0,
  copies1 INTEGER NOT NULL DEFAULT 0,
  copies2 INTEGER NOT NULL DEFAULT 0,
  copies3 INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_ladder_usage_daily_card UNIQUE ("dayKey", zone, "cardId")
);
CREATE TABLE IF NOT EXISTS ladder_usage_total_sample (
  id INTEGER PRIMARY KEY,
  "allDecks" INTEGER NOT NULL DEFAULT 0,
  "validCardDecks" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ladder_usage_total_deck (
  "deckTypeId" INTEGER PRIMARY KEY,
  "deckCount" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ladder_usage_total_card (
  id BIGSERIAL PRIMARY KEY,
  zone VARCHAR(12) NOT NULL,
  "cardId" INTEGER NOT NULL,
  "deckCount" INTEGER NOT NULL DEFAULT 0,
  copies1 INTEGER NOT NULL DEFAULT 0,
  copies2 INTEGER NOT NULL DEFAULT 0,
  copies3 INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_ladder_usage_total_card UNIQUE (zone, "cardId")
);

CREATE INDEX IF NOT EXISTS ix_ladder_match_player_a_time ON ladder_match ("playerAName", "createTime" DESC);
CREATE INDEX IF NOT EXISTS ix_ladder_match_player_b_time ON ladder_match ("playerBName", "createTime" DESC);

COMMIT;
