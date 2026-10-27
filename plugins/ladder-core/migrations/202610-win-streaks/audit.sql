\set ON_ERROR_STOP on
BEGIN READ ONLY;
-- Optional connection/schema check only. No historical matches are scanned.
SELECT current_database(), current_schema(), current_setting('search_path') AS search_path,
  to_regclass('ladder_user') AS "userTable", to_regclass('ladder_match') AS "matchTable";
SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type,
  a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS column_default
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = to_regclass('ladder_user') AND NOT a.attisdropped
  AND a.attname IN ('currentWinStreak', 'lastMatchId') ORDER BY a.attname;
ROLLBACK;
