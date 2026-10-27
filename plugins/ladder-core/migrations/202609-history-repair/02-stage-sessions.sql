CREATE TEMP TABLE ladder_repair_log_base ON COMMIT DROP AS
SELECT
  l.id AS log_id,
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
  l."duelCount" <> 1 OR
    COUNT(COALESCE(p."startDeckBuffer", p."currentDeckBuffer")) FILTER (WHERE p.pos IN (0, 1)) = 2 AS decks_valid
FROM duel_log l
JOIN duel_log_player p ON p."duelLogId" = l.id
GROUP BY l.id, l.name, l.time, l."duelCount";

CREATE TEMP TABLE ladder_repair_tagged ON COMMIT DROP AS
SELECT *,
  SUM(CASE WHEN "duelCount" = 1 THEN 1 ELSE 0 END)
    OVER (PARTITION BY name ORDER BY time, log_id) AS session_no
FROM ladder_repair_log_base;

CREATE TEMP TABLE ladder_repair_sessions ON COMMIT DROP AS
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
  (ARRAY_AGG(duel_winner ORDER BY time DESC, log_id DESC))[1] AS final_winner
FROM ladder_repair_tagged
GROUP BY name, session_no;

CREATE TEMP TABLE ladder_repair_candidates ON COMMIT DROP AS
SELECT
  m.id AS match_id,
  s.name,
  s.session_no,
  s.logs,
  COUNT(*) OVER (PARTITION BY m.id) AS candidates_for_match,
  COUNT(*) OVER (PARTITION BY s.name, s.session_no) AS candidates_for_session
FROM ladder_match m
JOIN ladder_repair_sessions s
  ON s.p1 = LEAST(LOWER(m."playerAName"), LOWER(m."playerBName"))
 AND s.p2 = GREATEST(LOWER(m."playerAName"), LOWER(m."playerBName"))
 AND s.final_winner = LOWER(m."winnerName")
 AND ABS(EXTRACT(EPOCH FROM (s.end_time - m."createTime"))) <= 30
WHERE s.data_valid
  AND s.pair_count = 1
  AND s.min_duel = 1
  AND s.max_duel = s.logs
  AND s.logs BETWEEN 1 AND 3;

CREATE TEMP TABLE ladder_repair_match_session ON COMMIT DROP AS
SELECT match_id, name, session_no, logs
FROM ladder_repair_candidates
WHERE candidates_for_match = 1 AND candidates_for_session = 1;

CREATE UNIQUE INDEX ON ladder_repair_match_session(match_id);
CREATE UNIQUE INDEX ON ladder_repair_match_session(name, session_no);

CREATE TEMP TABLE ladder_repair_session_log ON COMMIT DROP AS
SELECT m.match_id, t.log_id
FROM ladder_repair_match_session m
JOIN ladder_repair_tagged t ON t.name = m.name AND t.session_no = m.session_no;

CREATE UNIQUE INDEX ON ladder_repair_session_log(log_id);

WITH g1 AS (
  SELECT
    sl.match_id,
    l.id AS duel_log_id,
    l."roomId" AS room_id,
    LOWER(MAX(p.name) FILTER (WHERE p."isFirst" = 1)) AS first_player
  FROM ladder_repair_session_log sl
  JOIN duel_log l ON l.id = sl.log_id AND l."duelCount" = 1
  JOIN duel_log_player p ON p."duelLogId" = l.id AND p.pos IN (0, 1)
  GROUP BY sl.match_id, l.id, l."roomId"
)
UPDATE ladder_match m
SET
  "duelLogId" = g1.duel_log_id,
  "roomId" = g1.room_id,
  "g1FirstPlayer" = g1.first_player
FROM g1
WHERE m.id = g1.match_id;
