\set ON_ERROR_STOP on
BEGIN;
LOCK TABLE ladder_user IN SHARE ROW EXCLUSIVE MODE;
-- Deliberately fail on a second application: never reset live streaks or markers.
-- Every existing account starts at zero. Historical matches are not inspected.
ALTER TABLE ladder_user ADD COLUMN "currentWinStreak" integer NOT NULL DEFAULT 0;
ALTER TABLE ladder_user ADD COLUMN "lastMatchId" integer;
-- Only new settlements populate lastMatchId and become eligible for posts.
CREATE INDEX ix_ladder_user_current_win_streak ON ladder_user ("currentWinStreak");
COMMIT;
