-- srvprotianti PostgreSQL fresh-install schema, reviewed 2026-10-10.
-- Run through deployment/schema.js init, which adds a transaction, target
-- database confirmation, maintenance advisory lock, and runtime grants.
-- Never apply this file to a restored database or as a history migration.
SET LOCAL search_path = public, pg_catalog;
DO $empty$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') THEN RAISE EXCEPTION 'Bootstrap requires an empty database; restore/upgrade must use verify instead'; END IF; END $empty$;

CREATE TABLE public."ban" (
  "createTime" timestamp without time zone NOT NULL DEFAULT now(),
  "updateTime" timestamp without time zone NOT NULL DEFAULT now(),
  "id" bigserial NOT NULL,
  "ip" character varying(64),
  "name" character varying(20),
  PRIMARY KEY ("id"),
  CONSTRAINT "UQ_618822f5c03bdedff3eae5ca5a8" UNIQUE ("ip", "name")
);

CREATE TABLE public."cloud_replay" (
  "createTime" timestamp without time zone NOT NULL DEFAULT now(),
  "updateTime" timestamp without time zone NOT NULL DEFAULT now(),
  "id" bigint NOT NULL,
  "data" text NOT NULL,
  "date" timestamp without time zone NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."cloud_replay_player" (
  "createTime" timestamp without time zone NOT NULL DEFAULT now(),
  "updateTime" timestamp without time zone NOT NULL DEFAULT now(),
  "id" bigserial NOT NULL,
  "name" character varying(20) NOT NULL,
  "pos" smallint NOT NULL,
  "key" character varying(128) NOT NULL,
  "cloudReplayId" bigint,
  PRIMARY KEY ("id")
);

CREATE TABLE public."duel_log" (
  "createTime" timestamp without time zone NOT NULL DEFAULT now(),
  "updateTime" timestamp without time zone NOT NULL DEFAULT now(),
  "id" bigserial NOT NULL,
  "time" timestamp without time zone NOT NULL,
  "name" character varying(20) NOT NULL,
  "roomId" integer NOT NULL,
  "cloudReplayId" bigint NOT NULL,
  "replayFileName" character varying(256) NOT NULL,
  "roomMode" smallint NOT NULL,
  "duelCount" smallint NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."duel_log_player" (
  "createTime" timestamp without time zone NOT NULL DEFAULT now(),
  "updateTime" timestamp without time zone NOT NULL DEFAULT now(),
  "id" bigserial NOT NULL,
  "name" character varying(20) NOT NULL,
  "pos" smallint NOT NULL,
  "realName" character varying(20) NOT NULL,
  "ip" character varying(64),
  "isFirst" smallint NOT NULL,
  "score" smallint NOT NULL,
  "lp" integer,
  "cardCount" smallint,
  "startDeckBuffer" text,
  "currentDeckBuffer" text,
  "winner" smallint NOT NULL,
  "duelLogId" bigint,
  PRIMARY KEY ("id")
);

CREATE TABLE public."ladder_deck_card_fact" (
  "id" bigserial NOT NULL,
  "sampleId" bigint NOT NULL,
  "cardId" integer NOT NULL,
  "zone" character varying(12) NOT NULL,
  "copies" smallint NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."ladder_match" (
  "id" serial NOT NULL,
  "matchKey" character varying(96) NOT NULL,
  "roomId" integer,
  "monthKey" character varying(8),
  "winnerName" character varying(64),
  "loserName" character varying(64),
  "playerAName" character varying(64),
  "playerBName" character varying(64),
  "playerADisplayName" character varying(64),
  "playerBDisplayName" character varying(64),
  "playerADeckTypeId" integer NOT NULL DEFAULT '4095',
  "playerBDeckTypeId" integer NOT NULL DEFAULT '4095',
  "playerADuelPointsDelta" integer NOT NULL DEFAULT '0',
  "playerBDuelPointsDelta" integer NOT NULL DEFAULT '0',
  "playerADuelPointsBefore" integer NOT NULL DEFAULT '1000',
  "playerBDuelPointsBefore" integer NOT NULL DEFAULT '1000',
  "playerADuelPointsAfter" integer NOT NULL DEFAULT '1000',
  "playerBDuelPointsAfter" integer NOT NULL DEFAULT '1000',
  "g1FirstPlayer" character varying(64),
  "coinWinner" character varying(64),
  "duelLogId" bigint,
  "createTime" timestamp without time zone NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."ladder_match_game" (
  "id" bigserial NOT NULL,
  "matchId" bigint NOT NULL,
  "duelLogId" bigint,
  "playerName" character varying(64) NOT NULL,
  "playerDisplayName" character varying(64),
  "opponentName" character varying(64) NOT NULL,
  "opponentDisplayName" character varying(64),
  "deckTypeId" integer NOT NULL DEFAULT '4095',
  "opponentDeckTypeId" integer NOT NULL DEFAULT '4095',
  "winnerName" character varying(64),
  "duelCount" smallint NOT NULL DEFAULT '1',
  "isFirst" smallint NOT NULL DEFAULT '0',
  "isMain" smallint NOT NULL DEFAULT '1',
  "createTime" timestamp without time zone NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "ck_ladder_game_duel_count" CHECK ("duelCount" BETWEEN 1 AND 3),
  CONSTRAINT "ck_ladder_game_is_first" CHECK ("isFirst" IN (0, 1)),
  CONSTRAINT "ck_ladder_game_is_main" CHECK ("isMain" IN (0, 1)),
  CONSTRAINT "ck_ladder_game_main_count" CHECK ("isMain" = CASE WHEN "duelCount" = 1 THEN 1 ELSE 0 END)
);

CREATE TABLE public."ladder_month_record" (
  "id" serial NOT NULL,
  "name" character varying(64) NOT NULL,
  "monthKey" character varying(8) NOT NULL,
  "duelPoints" integer NOT NULL DEFAULT '1000',
  "wins" integer NOT NULL DEFAULT '0',
  "losses" integer NOT NULL DEFAULT '0',
  "scoreDiff" integer NOT NULL DEFAULT '0',
  PRIMARY KEY ("id")
);

CREATE TABLE public."ladder_usage_daily_card" (
  "id" bigserial NOT NULL,
  "dayKey" character varying(8) NOT NULL,
  "zone" character varying(12) NOT NULL,
  "cardId" integer NOT NULL,
  "deckCount" integer NOT NULL DEFAULT '0',
  "copies1" integer NOT NULL DEFAULT '0',
  "copies2" integer NOT NULL DEFAULT '0',
  "copies3" integer NOT NULL DEFAULT '0',
  PRIMARY KEY ("id")
);

CREATE TABLE public."ladder_usage_daily_deck" (
  "id" bigserial NOT NULL,
  "dayKey" character varying(8) NOT NULL,
  "deckTypeId" integer NOT NULL,
  "deckCount" integer NOT NULL DEFAULT '0',
  PRIMARY KEY ("id")
);

CREATE TABLE public."ladder_usage_daily_sample" (
  "dayKey" character varying(8) NOT NULL,
  "allDecks" integer NOT NULL DEFAULT '0',
  "validCardDecks" integer NOT NULL DEFAULT '0',
  PRIMARY KEY ("dayKey")
);

CREATE TABLE public."ladder_usage_sample" (
  "id" bigserial NOT NULL,
  "matchId" bigint NOT NULL,
  "playerName" character varying(64) NOT NULL,
  "dayKey" character varying(8) NOT NULL,
  "monthKey" character varying(6) NOT NULL,
  "deckTypeId" integer NOT NULL DEFAULT '4095',
  "cardValid" integer NOT NULL DEFAULT '0',
  "status" character varying(16) NOT NULL DEFAULT 'missing',
  "reason" character varying(64),
  "algorithmVersion" character varying(32) NOT NULL DEFAULT '1',
  "catalogVersion" character varying(280),
  "projectedAt" timestamp without time zone NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."ladder_usage_total_card" (
  "id" bigserial NOT NULL,
  "zone" character varying(12) NOT NULL,
  "cardId" integer NOT NULL,
  "deckCount" integer NOT NULL DEFAULT '0',
  "copies1" integer NOT NULL DEFAULT '0',
  "copies2" integer NOT NULL DEFAULT '0',
  "copies3" integer NOT NULL DEFAULT '0',
  PRIMARY KEY ("id")
);

CREATE TABLE public."ladder_usage_total_deck" (
  "deckTypeId" integer NOT NULL,
  "deckCount" integer NOT NULL DEFAULT '0',
  PRIMARY KEY ("deckTypeId")
);

CREATE TABLE public."ladder_usage_total_sample" (
  "id" integer NOT NULL,
  "allDecks" integer NOT NULL DEFAULT '0',
  "validCardDecks" integer NOT NULL DEFAULT '0',
  PRIMARY KEY ("id")
);

CREATE TABLE public."ladder_user" (
  "name" character varying(64) NOT NULL,
  "displayName" character varying(64),
  "pass" character varying(128),
  "createdAt" timestamp without time zone,
  "wins" integer NOT NULL DEFAULT '0',
  "losses" integer NOT NULL DEFAULT '0',
  "monthWins" integer NOT NULL DEFAULT '0',
  "monthLosses" integer NOT NULL DEFAULT '0',
  "currentWinStreak" integer NOT NULL DEFAULT '0',
  "lastMatchId" integer,
  "duelPoints" integer NOT NULL DEFAULT '1000',
  "monthDuelPoints" integer NOT NULL DEFAULT '1000',
  "monthKey" character varying(8),
  PRIMARY KEY ("name")
);

CREATE TABLE public."random_duel_ban" (
  "createTime" timestamp without time zone NOT NULL DEFAULT now(),
  "updateTime" timestamp without time zone NOT NULL DEFAULT now(),
  "ip" character varying(64) NOT NULL,
  "time" timestamp without time zone NOT NULL,
  "count" smallint NOT NULL,
  "reasons" text NOT NULL,
  "needTip" smallint NOT NULL,
  PRIMARY KEY ("ip")
);

CREATE TABLE public."random_duel_score" (
  "createTime" timestamp without time zone NOT NULL DEFAULT now(),
  "updateTime" timestamp without time zone NOT NULL DEFAULT now(),
  "name" character varying(20) NOT NULL,
  "winCount" integer NOT NULL DEFAULT '0',
  "loseCount" integer NOT NULL DEFAULT '0',
  "fleeCount" integer NOT NULL DEFAULT '0',
  "winCombo" integer NOT NULL DEFAULT '0',
  PRIMARY KEY ("name")
);

CREATE TABLE public."user" (
  "createTime" timestamp without time zone NOT NULL DEFAULT now(),
  "updateTime" timestamp without time zone NOT NULL DEFAULT now(),
  "key" character varying(128) NOT NULL,
  "chatColor" character varying(16),
  PRIMARY KEY ("key")
);

CREATE INDEX "IDX_cbf8e2029d298db94d03259c56" ON public."ban" ("ip");
CREATE INDEX "IDX_37b0c9a28ebbb2de8b9894b2b4" ON public."ban" ("name");
CREATE INDEX "IDX_890a06ab28138cc3fbea4197cc" ON public."cloud_replay" ("date");
CREATE INDEX "IDX_cd18ab144cb60f1ad997413ccf" ON public."cloud_replay_player" ("key");
ALTER TABLE public."cloud_replay_player" ADD CONSTRAINT "FK_12397b5a77ed3a80333cc95fdcd" FOREIGN KEY ("cloudReplayId") REFERENCES public."cloud_replay" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "IDX_af4fc0edfb70680fd2890c8163" ON public."duel_log" ("time");
CREATE INDEX "IDX_3a4c16ad8209299e6f41cb6990" ON public."duel_log" ("name");
CREATE INDEX "IDX_ea4303493035f9d5363ecfe175" ON public."duel_log" ("duelCount");
CREATE INDEX "IDX_200eb70102362da85ee24220e2" ON public."duel_log_player" ("realName");
CREATE INDEX "IDX_687367e0a942d21fde5d9e9377" ON public."duel_log_player" ("score");
ALTER TABLE public."duel_log_player" ADD CONSTRAINT "FK_cd85a339bd617943fc37fafda7c" FOREIGN KEY ("duelLogId") REFERENCES public."duel_log" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "uq_ladder_card_fact" ON public."ladder_deck_card_fact" ("sampleId", "cardId", "zone");
CREATE INDEX "ix_ladder_card_fact_lookup" ON public."ladder_deck_card_fact" ("zone", "cardId");
ALTER TABLE public."ladder_deck_card_fact" ADD CONSTRAINT "fk_ladder_card_fact_sample" FOREIGN KEY ("sampleId") REFERENCES public."ladder_usage_sample" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "uq_ladder_match_match_key" ON public."ladder_match" ("matchKey");
CREATE INDEX "ix_ladder_match_month_decks" ON public."ladder_match" ("monthKey", "playerADeckTypeId", "playerBDeckTypeId");
CREATE INDEX "ix_ladder_match_player_a_time" ON public."ladder_match" ("playerAName", "createTime" DESC);
CREATE INDEX "ix_ladder_match_player_b_time" ON public."ladder_match" ("playerBName", "createTime" DESC);
CREATE UNIQUE INDEX "uq_ladder_game_identity" ON public."ladder_match_game" ("matchId", "duelCount", "playerName");
CREATE INDEX "ix_ladder_game_match" ON public."ladder_match_game" ("matchId");
CREATE INDEX "ix_ladder_game_player" ON public."ladder_match_game" ("playerName");
CREATE INDEX "ix_ladder_game_month_query" ON public."ladder_match_game" ("createTime", "deckTypeId", "opponentDeckTypeId");
CREATE INDEX "ix_ladder_game_duel_log" ON public."ladder_match_game" ("duelLogId");
ALTER TABLE public."ladder_match_game" ADD CONSTRAINT "FK_19c1d140e17984ba1624b86caba" FOREIGN KEY ("matchId") REFERENCES public."ladder_match" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "uq_ladder_month_name_key" ON public."ladder_month_record" ("name", "monthKey");
CREATE UNIQUE INDEX "uq_ladder_usage_daily_card" ON public."ladder_usage_daily_card" ("dayKey", "zone", "cardId");
CREATE UNIQUE INDEX "uq_ladder_usage_daily_deck" ON public."ladder_usage_daily_deck" ("dayKey", "deckTypeId");
CREATE UNIQUE INDEX "uq_ladder_usage_match_player" ON public."ladder_usage_sample" ("matchId", "playerName");
CREATE INDEX "ix_ladder_usage_sample_day" ON public."ladder_usage_sample" ("dayKey");
CREATE INDEX "ix_ladder_usage_sample_deck" ON public."ladder_usage_sample" ("deckTypeId", "dayKey");
CREATE UNIQUE INDEX "uq_ladder_usage_total_card" ON public."ladder_usage_total_card" ("zone", "cardId");
CREATE INDEX "ix_ladder_user_current_win_streak" ON public."ladder_user" ("currentWinStreak");
CREATE INDEX "IDX_1fd9007877da289efc76d90c20" ON public."random_duel_score" ("winCount");
CREATE INDEX "IDX_62d08b92a14fb771d02ed965f6" ON public."random_duel_score" ("loseCount");
CREATE INDEX "IDX_dbfc54de9e5d7c362be5f77ae3" ON public."random_duel_score" ("fleeCount");
