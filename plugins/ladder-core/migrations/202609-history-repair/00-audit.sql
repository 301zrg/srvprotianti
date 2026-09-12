WITH log_base AS (
  SELECT
    l.id,
    l.name,
    l.time,
    l."duelCount",
    LEAST(LOWER(MAX(p.name) FILTER (WHERE p.pos = 0)), LOWER(MAX(p.name) FILTER (WHERE p.pos = 1))) AS p1,
    GREATEST(LOWER(MAX(p.name) FILTER (WHERE p.pos = 0)), LOWER(MAX(p.name) FILTER (WHERE p.pos = 1))) AS p2,
    LOWER(MAX(p.name) FILTER (WHERE p.pos IN (0, 1) AND p.winner = 1)) AS duel_winner,
    COUNT(*) FILTER (WHERE p.pos IN (0, 1)) = 2 AS players_valid,
    COUNT(DISTINCT LOWER(p.name)) FILTER (WHERE p.pos IN (0, 1)) = 2 AS names_valid,
    COUNT(*) FILTER (WHERE p.pos IN (0, 1) AND p.winner = 1) = 1 AS winner_valid,
    COUNT(*) FILTER (WHERE p.pos IN (0, 1) AND p."isFirst" = 1) = 1 AS first_valid,
    COUNT(p."currentDeckBuffer") FILTER (WHERE p.pos IN (0, 1)) = 2 AS decks_valid
  FROM duel_log l
  JOIN duel_log_player p ON p."duelLogId" = l.id
  GROUP BY l.id, l.name, l.time, l."duelCount"
), tagged AS (
  SELECT *,
    SUM(CASE WHEN "duelCount" = 1 THEN 1 ELSE 0 END)
      OVER (PARTITION BY name ORDER BY time, id) AS session_no
  FROM log_base
), sessions AS (
  SELECT
    name,
    session_no,
    MAX(time) AS end_time,
    MIN(p1) AS p1,
    MIN(p2) AS p2,
    COUNT(*) AS logs,
    MIN("duelCount") AS min_duel,
    MAX("duelCount") AS max_duel,
    COUNT(DISTINCT (p1, p2)) AS pair_count,
    BOOL_AND(players_valid AND names_valid AND winner_valid AND first_valid AND decks_valid) AS data_valid,
    (ARRAY_AGG(duel_winner ORDER BY time DESC, id DESC))[1] AS final_winner
  FROM tagged
  GROUP BY name, session_no
), candidates AS (
  SELECT
    m.id AS match_id,
    s.name,
    s.session_no,
    s.logs,
    COUNT(*) OVER (PARTITION BY m.id) AS candidates_for_match,
    COUNT(*) OVER (PARTITION BY s.name, s.session_no) AS candidates_for_session
  FROM ladder_match m
  JOIN sessions s
    ON s.p1 = LEAST(LOWER(m."playerAName"), LOWER(m."playerBName"))
   AND s.p2 = GREATEST(LOWER(m."playerAName"), LOWER(m."playerBName"))
   AND s.final_winner = LOWER(m."winnerName")
   AND ABS(EXTRACT(EPOCH FROM (s.end_time - m."createTime"))) <= 30
  WHERE s.data_valid
    AND s.pair_count = 1
    AND s.min_duel = 1
    AND s.max_duel = s.logs
    AND s.logs BETWEEN 1 AND 3
), reliable AS (
  SELECT * FROM candidates
  WHERE candidates_for_match = 1 AND candidates_for_session = 1
)
SELECT
  (SELECT COUNT(*)::int FROM ladder_user) AS ladder_users,
  (SELECT COUNT(*)::int FROM ladder_month_record) AS month_rows,
  (SELECT COUNT(*)::int FROM ladder_match) AS matches,
  (SELECT COUNT(*)::int FROM ladder_match_game) AS legacy_game_rows,
  (SELECT COUNT(*)::int FROM duel_log) AS duel_logs,
  (SELECT COUNT(*)::int FROM sessions) AS replay_sessions,
  (SELECT COUNT(*)::int FROM reliable) AS recoverable_matches,
  (SELECT COALESCE(SUM(logs), 0)::int FROM reliable) AS recoverable_duels,
  (SELECT COALESCE(SUM(logs), 0)::int * 2 FROM reliable) AS rebuilt_game_rows,
  (SELECT COUNT(*)::int FROM ladder_match m WHERE NOT EXISTS (SELECT 1 FROM reliable r WHERE r.match_id = m.id)) AS match_only_rows,
  (SELECT COUNT(*)::int FROM ladder_user) -
    (SELECT COUNT(DISTINCT LOWER(name))::int FROM ladder_user) AS duplicate_normalized_users,
  (SELECT COUNT(*)::int FROM ladder_month_record) -
    (SELECT COUNT(DISTINCT (LOWER(name), "monthKey"))::int FROM ladder_month_record) AS duplicate_month_rows,
  (SELECT COUNT(*)::int FROM log_base WHERE NOT (players_valid AND names_valid AND winner_valid AND first_valid AND decks_valid)) AS invalid_duel_logs;
