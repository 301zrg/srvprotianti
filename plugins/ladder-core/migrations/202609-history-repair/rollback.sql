-- Convenience rollback for the table swap. Run only while the server is
-- stopped. A complete rollback, including added nullable columns and indexes,
-- should use the pre-migration pg_dump archive documented in README.md.
BEGIN;
LOCK TABLE ladder_match_game, ladder_match_game_legacy_202609 IN ACCESS EXCLUSIVE MODE;
ALTER TABLE ladder_match_game RENAME TO ladder_match_game_repaired_202609;
ALTER TABLE ladder_match_game_legacy_202609 RENAME TO ladder_match_game;
COMMIT;
