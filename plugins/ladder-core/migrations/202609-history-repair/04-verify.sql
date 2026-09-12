SELECT
  (SELECT COUNT(*)::int FROM ladder_match_game) AS rebuilt_rows,
  (SELECT COUNT(*)::int FROM ladder_match_game_legacy_202609) AS archived_rows,
  (SELECT COUNT(DISTINCT ("matchId", "duelCount"))::int FROM ladder_match_game) AS physical_duels,
  (SELECT COUNT(*)::int FROM ladder_match WHERE "duelLogId" IS NOT NULL) AS linked_matches,
  (SELECT COUNT(*)::int FROM ladder_user WHERE "displayName" IS NULL OR "displayName" = '') AS missing_display_names,
  (SELECT COUNT(*)::int FROM ladder_match WHERE "matchKey" IS NULL OR "matchKey" = '') AS missing_match_keys,
  (SELECT COUNT(*)::int FROM (
    SELECT "matchId", "duelCount"
    FROM ladder_match_game
    GROUP BY "matchId", "duelCount"
    HAVING COUNT(*) <> 2
       OR COUNT(DISTINCT LOWER("playerName")) <> 2
       OR SUM("isFirst") <> 1
       OR COUNT(*) FILTER (WHERE LOWER("winnerName") = LOWER("playerName")) <> 1
       OR SUM("isMain") <> CASE WHEN "duelCount" = 1 THEN 2 ELSE 0 END
  ) invalid) AS invalid_duels,
  (SELECT COUNT(*)::int FROM ladder_match_game g LEFT JOIN ladder_match m ON m.id = g."matchId" WHERE m.id IS NULL) AS orphan_games,
  (SELECT COUNT(*)::int FROM ladder_match_game g LEFT JOIN duel_log d ON d.id = g."duelLogId" WHERE g."duelLogId" IS NOT NULL AND d.id IS NULL) AS orphan_logs,
  (SELECT COUNT(*)::int
    FROM ladder_match_game g JOIN ladder_match m ON m.id = g."matchId"
    WHERE NOT (
      (LOWER(g."playerName") = LOWER(m."playerAName") AND LOWER(g."opponentName") = LOWER(m."playerBName"))
      OR
      (LOWER(g."playerName") = LOWER(m."playerBName") AND LOWER(g."opponentName") = LOWER(m."playerAName"))
    )
    OR g."deckTypeId" IS DISTINCT FROM CASE
      WHEN LOWER(g."playerName") = LOWER(m."playerAName") THEN m."playerADeckTypeId" ELSE m."playerBDeckTypeId" END
    OR g."opponentDeckTypeId" IS DISTINCT FROM CASE
      WHEN LOWER(g."opponentName") = LOWER(m."playerAName") THEN m."playerADeckTypeId" ELSE m."playerBDeckTypeId" END
  ) AS deck_type_mismatches,
  (SELECT COUNT(*)::int FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN ('uq_ladder_month_name_key', 'uq_ladder_match_match_key', 'uq_ladder_game_identity')
      AND indexdef LIKE 'CREATE UNIQUE INDEX%') AS required_unique_indexes,
  (SELECT COUNT(*)::int FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ladder_match_game'
      AND column_name IN ('opponentDeckTypeId', 'duelCount', 'isFirst', 'isMain')) AS required_game_columns,
  (SELECT COUNT(*)::int FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ladder_match_game'
      AND column_name IN ('gNumber', 'isSide')) AS retired_game_columns,
  (SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ladder_match' AND column_name = 'matchKey') AS match_key_nullable;
