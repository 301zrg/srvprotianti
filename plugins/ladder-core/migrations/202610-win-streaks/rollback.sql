\set ON_ERROR_STOP on
BEGIN;
DROP INDEX IF EXISTS ix_ladder_user_current_win_streak;
ALTER TABLE ladder_user DROP COLUMN IF EXISTS "lastMatchId";
ALTER TABLE ladder_user DROP COLUMN IF EXISTS "currentWinStreak";
COMMIT;
