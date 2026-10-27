ALTER TABLE ladder_match_game RENAME TO ladder_match_game_legacy_202609;
ALTER TABLE ladder_match_game_rebuild_202609 RENAME TO ladder_match_game;

ALTER TABLE ladder_match ALTER COLUMN "matchKey" SET NOT NULL;

-- A previous failed TypeORM synchronize may have created one of the intended
-- game index names on the old table. Preserve it with the archived table while
-- freeing the stable name for the replacement table.
ALTER INDEX IF EXISTS uq_ladder_game_identity RENAME TO uq_ladder_game_identity_legacy_202609;
ALTER INDEX IF EXISTS ix_ladder_game_match RENAME TO ix_ladder_game_match_legacy_202609;
ALTER INDEX IF EXISTS ix_ladder_game_player RENAME TO ix_ladder_game_player_legacy_202609;
ALTER INDEX IF EXISTS ix_ladder_game_month_query RENAME TO ix_ladder_game_month_query_legacy_202609;
ALTER INDEX IF EXISTS ix_ladder_game_duel_log RENAME TO ix_ladder_game_duel_log_legacy_202609;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ladder_month_name_key
  ON ladder_month_record(name, "monthKey");
CREATE UNIQUE INDEX IF NOT EXISTS uq_ladder_match_match_key
  ON ladder_match("matchKey");
CREATE INDEX IF NOT EXISTS ix_ladder_match_month_decks
  ON ladder_match("monthKey", "playerADeckTypeId", "playerBDeckTypeId");

CREATE UNIQUE INDEX uq_ladder_game_identity
  ON ladder_match_game("matchId", "duelCount", "playerName");
CREATE INDEX ix_ladder_game_match ON ladder_match_game("matchId");
CREATE INDEX ix_ladder_game_player ON ladder_match_game("playerName");
CREATE INDEX ix_ladder_game_month_query
  ON ladder_match_game("createTime", "deckTypeId", "opponentDeckTypeId");
CREATE INDEX ix_ladder_game_duel_log ON ladder_match_game("duelLogId");

-- Return the replacement table and its serial sequence to the owner of the
-- archived table. This lets a database administrator perform the migration
-- without changing the long-term privileges of the application role.
DO $ownership$
DECLARE
  old_owner name;
  sequence_name text;
BEGIN
  SELECT tableowner INTO old_owner
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'ladder_match_game_legacy_202609';

  EXECUTE format('ALTER TABLE public.ladder_match_game OWNER TO %I', old_owner);
  SELECT pg_get_serial_sequence('public.ladder_match_game', 'id') INTO sequence_name;
  IF sequence_name IS NOT NULL THEN
    EXECUTE format('ALTER SEQUENCE %s OWNER TO %I', sequence_name, old_owner);
  END IF;
END
$ownership$;

ANALYZE ladder_user;
ANALYZE ladder_month_record;
ANALYZE ladder_match;
ANALYZE ladder_match_game;
