ALTER TABLE ladder_user
  ADD COLUMN IF NOT EXISTS "displayName" varchar(64);

ALTER TABLE ladder_match
  ADD COLUMN IF NOT EXISTS "matchKey" varchar(96),
  ADD COLUMN IF NOT EXISTS "roomId" integer,
  ADD COLUMN IF NOT EXISTS "playerADisplayName" varchar(64),
  ADD COLUMN IF NOT EXISTS "playerBDisplayName" varchar(64);

-- DuelLog uses bigint on PostgreSQL. Keeping these references as integer would
-- eventually overflow and would prevent a future foreign-key-compatible type.
ALTER TABLE ladder_match
  ALTER COLUMN "duelLogId" TYPE bigint USING "duelLogId"::bigint;

UPDATE ladder_match
SET "matchKey" = 'legacy:' || id::text
WHERE "matchKey" IS NULL OR "matchKey" = '';

CREATE TABLE ladder_match_game_rebuild_202609 (
  id bigserial PRIMARY KEY,
  "matchId" bigint NOT NULL REFERENCES ladder_match(id) ON DELETE CASCADE,
  "duelLogId" bigint,
  "playerName" varchar(64) NOT NULL,
  "playerDisplayName" varchar(64),
  "opponentName" varchar(64) NOT NULL,
  "opponentDisplayName" varchar(64),
  "deckTypeId" integer NOT NULL DEFAULT 4095,
  "opponentDeckTypeId" integer NOT NULL DEFAULT 4095,
  "winnerName" varchar(64) NOT NULL,
  "duelCount" smallint NOT NULL,
  "isFirst" smallint NOT NULL,
  "isMain" smallint NOT NULL,
  "createTime" timestamp without time zone NOT NULL,
  CONSTRAINT ck_ladder_game_duel_count CHECK ("duelCount" BETWEEN 1 AND 3),
  CONSTRAINT ck_ladder_game_is_first CHECK ("isFirst" IN (0, 1)),
  CONSTRAINT ck_ladder_game_is_main CHECK ("isMain" IN (0, 1)),
  CONSTRAINT ck_ladder_game_main_count CHECK ("isMain" = CASE WHEN "duelCount" = 1 THEN 1 ELSE 0 END)
);
