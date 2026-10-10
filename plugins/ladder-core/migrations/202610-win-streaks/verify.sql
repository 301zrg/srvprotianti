\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'ladder_user'
  AND column_name IN ('currentWinStreak', 'lastMatchId') ORDER BY column_name;
SELECT COUNT(*) AS "invalidStreaks" FROM ladder_user
WHERE "currentWinStreak" IS NULL OR "currentWinStreak" < 0;
-- Before the first start of the new game code, every streak must be zero.
SELECT COUNT(*) AS "nonzeroStreaks" FROM ladder_user WHERE "currentWinStreak" <> 0;
SELECT COUNT(*) AS "invalidLatestMatches" FROM ladder_user u
LEFT JOIN ladder_match m ON m.id = u."lastMatchId"
WHERE u."lastMatchId" IS NOT NULL AND
  (m.id IS NULL OR (m."playerAName" <> u.name AND m."playerBName" <> u.name));
SELECT COUNT(*) AS "deliveryMarkers" FROM ladder_user WHERE "lastMatchId" IS NOT NULL;
ROLLBACK;
