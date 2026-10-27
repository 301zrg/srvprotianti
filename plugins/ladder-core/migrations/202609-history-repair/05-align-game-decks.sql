-- Safe post-migration correction for databases that were rebuilt before the
-- G1-only deck-type rule was enforced. Run with psql ON_ERROR_STOP=1.
BEGIN;
LOCK TABLE ladder_match, ladder_match_game IN ACCESS EXCLUSIVE MODE;

DO $validate$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ladder_match_game g
    JOIN ladder_match m ON m.id = g."matchId"
    WHERE NOT (
      (LOWER(g."playerName") = LOWER(m."playerAName") AND LOWER(g."opponentName") = LOWER(m."playerBName"))
      OR
      (LOWER(g."playerName") = LOWER(m."playerBName") AND LOWER(g."opponentName") = LOWER(m."playerAName"))
    )
  ) THEN
    RAISE EXCEPTION 'A game row does not match the two players on its LadderMatch.';
  END IF;
END
$validate$;

WITH corrected AS (
  UPDATE ladder_match_game g
  SET
    "deckTypeId" = CASE
      WHEN LOWER(g."playerName") = LOWER(m."playerAName") THEN m."playerADeckTypeId"
      ELSE m."playerBDeckTypeId"
    END,
    "opponentDeckTypeId" = CASE
      WHEN LOWER(g."opponentName") = LOWER(m."playerAName") THEN m."playerADeckTypeId"
      ELSE m."playerBDeckTypeId"
    END
  FROM ladder_match m
  WHERE m.id = g."matchId"
    AND (
      g."deckTypeId" IS DISTINCT FROM CASE
        WHEN LOWER(g."playerName") = LOWER(m."playerAName") THEN m."playerADeckTypeId"
        ELSE m."playerBDeckTypeId"
      END
      OR g."opponentDeckTypeId" IS DISTINCT FROM CASE
        WHEN LOWER(g."opponentName") = LOWER(m."playerAName") THEN m."playerADeckTypeId"
        ELSE m."playerBDeckTypeId"
      END
    )
  RETURNING g.id
)
SELECT COUNT(*) AS corrected_game_rows FROM corrected;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ladder_match_game g
    JOIN ladder_match m ON m.id = g."matchId"
    WHERE g."deckTypeId" IS DISTINCT FROM CASE
        WHEN LOWER(g."playerName") = LOWER(m."playerAName") THEN m."playerADeckTypeId"
        ELSE m."playerBDeckTypeId"
      END
      OR g."opponentDeckTypeId" IS DISTINCT FROM CASE
        WHEN LOWER(g."opponentName") = LOWER(m."playerAName") THEN m."playerADeckTypeId"
        ELSE m."playerBDeckTypeId"
      END
  ) THEN
    RAISE EXCEPTION 'Deck-type alignment verification failed.';
  END IF;
END
$verify$;

COMMIT;
