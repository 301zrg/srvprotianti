"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataManager = void 0;
const moment_1 = __importDefault(require("moment"));
const typeorm_1 = require("typeorm");
const CloudReplay_1 = require("./entities/CloudReplay");
const CloudReplayPlayer_1 = require("./entities/CloudReplayPlayer");
const Ban_1 = require("./entities/Ban");
const RandomDuelBan_1 = require("./entities/RandomDuelBan");
const underscore_1 = __importDefault(require("underscore"));
const DuelLog_1 = require("./entities/DuelLog");
const DuelLogPlayer_1 = require("./entities/DuelLogPlayer");
const User_1 = require("./entities/User");
const RandomDuelScore_1 = require("./entities/RandomDuelScore");
const jszip_1 = __importDefault(require("jszip"));
const fs = __importStar(require("fs"));
require("reflect-metadata");
const LadderUser_1 = require("./entities/LadderUser");
const LadderMatch_1 = require("./entities/LadderMatch");
const LadderMatchGame_1 = require("./entities/LadderMatchGame");
const LadderMonthRecord_1 = require("./entities/LadderMonthRecord");
const ygopro_deck_encode_1 = __importDefault(require("ygopro-deck-encode"));
const path = __importStar(require("path"));
class DataManager {
    constructor(config, log) {
        this.config = config;
        this.log = log;
        this.ready = false;
    }
    async transaction(fun) {
        try {
            // @ts-ignore
            if (this.config.type !== 'sqlite' && this.config.type !== 'sqljs') {
                await this.db.transaction(async (mdb) => {
                    const result = await fun(mdb);
                    if (!result) {
                        throw new Error('Rollback requested.');
                    }
                });
            }
            else {
                await fun(this.db.manager);
            }
        }
        catch (e) {
            this.log.warn(`Transaction failed: ${e.toString()}`);
        }
    }
    async init() {
        const dbType = this.config.type || "mysql";
        const common = {
            synchronize: true,
            entities: ["./data-manager/entities/*.js"],
            ...this.config
        };
        if (dbType === "postgres") {
            this.db = await (0, typeorm_1.createConnection)({
                type: "postgres",
                ...common
            });
        }
        else if (dbType === "sqlite" || dbType === "sqljs") {
            this.db = await (0, typeorm_1.createConnection)({
                type: dbType,
                ...common
            });
        }
        else {
            this.db = await (0, typeorm_1.createConnection)({
                type: "mysql",
                supportBigNumbers: true,
                bigNumberStrings: false,
                ...common
            });
        }
        this.ready = true;
    }
    async getCloudReplaysFromKey(key) {
        try {
            const replaysQuery = this.db.createQueryBuilder(CloudReplay_1.CloudReplay, "replay");
            const sqb = replaysQuery.subQuery()
                .select('splayer.id')
                .from(CloudReplayPlayer_1.CloudReplayPlayer, 'splayer')
                .where('splayer.cloudReplayId = replay.id')
                .andWhere('splayer.key = :key');
            const replays = await replaysQuery.where(`exists ${sqb.getQuery()}`, { key })
                .orderBy("replay.date", "DESC")
                .limit(10)
                .leftJoinAndSelect("replay.players", "player")
                .getMany();
            return replays;
        }
        catch (e) {
            this.log.warn(`Failed to load replay of ${key}: ${e.toString()}`);
            return [];
        }
    }
    async getCloudReplayFromId(id) {
        try {
            return await this.db.getRepository(CloudReplay_1.CloudReplay).findOne(id, { relations: ["players"] });
        }
        catch (e) {
            this.log.warn(`Failed to load replay R#${id}: ${e.toString()}`);
            return null;
        }
    }
    async getRandomCloudReplay() {
        try {
            const [minQuery, maxQuery] = await Promise.all(["min", "max"].map(minOrMax => this.db.createQueryBuilder()
                .select(`${minOrMax}(id)`, "value")
                .from(CloudReplay_1.CloudReplay, "replay")
                .getRawOne()));
            if (!minQuery || !maxQuery) {
                return null;
            }
            const [minId, maxId] = [minQuery, maxQuery].map(query => parseInt(query.value));
            const targetId = Math.floor((maxId - minId) * Math.random()) + minId;
            return await this.db.createQueryBuilder(CloudReplay_1.CloudReplay, "replay")
                .where("replay.id >= :targetId", { targetId })
                .orderBy("replay.id", "ASC")
                .limit(4) //there may be 4 players
                .leftJoinAndSelect("replay.players", "player")
                .getOne();
        }
        catch (e) {
            this.log.warn(`Failed to load random replay: ${e.toString()}`);
            return null;
        }
    }
    async saveCloudReplay(id, buffer, playerInfos) {
        const replay = new CloudReplay_1.CloudReplay();
        replay.id = id;
        replay.fromBuffer(buffer);
        replay.date = (0, moment_1.default)().toDate();
        const players = playerInfos.map(p => {
            const player = CloudReplayPlayer_1.CloudReplayPlayer.fromPlayerInfo(p);
            return player;
        });
        await this.transaction(async (mdb) => {
            try {
                const nreplay = await mdb.save(replay);
                for (let player of players) {
                    player.cloudReplay = nreplay;
                }
                await mdb.save(players);
                return true;
            }
            catch (e) {
                this.log.warn(`Failed to save replay R#${replay.id}: ${e.toString()}`);
                return false;
            }
        });
    }
    async checkBan(field, value) {
        const banQuery = {};
        banQuery[field] = value;
        try {
            return await this.db.getRepository(Ban_1.Ban).findOne(banQuery);
        }
        catch (e) {
            this.log.warn(`Failed to load ban ${field} ${value}: ${e.toString()}`);
            return null;
        }
    }
    async checkBanWithNameAndIP(name, ip) {
        try {
            return await this.db.getRepository(Ban_1.Ban).findOne({ name, ip });
        }
        catch (e) {
            this.log.warn(`Failed to load ban ${name} ${ip}: ${e.toString()}`);
            return null;
        }
    }
    getBan(name, ip) {
        const ban = new Ban_1.Ban();
        ban.ip = ip;
        ban.name = name;
        return ban;
    }
    async banPlayer(ban) {
        try {
            const repo = this.db.getRepository(Ban_1.Ban);
            if (await repo.findOne({
                ip: ban.ip,
                name: ban.name
            })) {
                return;
            }
            return await repo.save(ban);
        }
        catch (e) {
            this.log.warn(`Failed to update ban ${JSON.stringify(ban)}: ${e.toString()}`);
            return null;
        }
    }
    async getRandomDuelBan(ip) {
        const repo = this.db.getRepository(RandomDuelBan_1.RandomDuelBan);
        try {
            const ban = await repo.findOne(ip);
            //console.log(ip, ban);
            return ban;
        }
        catch (e) {
            this.log.warn(`Failed to fetch random duel ban ${ip}: ${e.toString()}`);
            return null;
        }
    }
    async updateRandomDuelBan(ban) {
        const repo = this.db.getRepository(RandomDuelBan_1.RandomDuelBan);
        try {
            await repo.save(ban);
        }
        catch (e) {
            this.log.warn(`Failed to update random duel ban ${ban.ip}: ${e.toString()}`);
        }
    }
    async randomDuelBanPlayer(ip, reason, countadd) {
        const count = countadd || 1;
        const repo = this.db.getRepository(RandomDuelBan_1.RandomDuelBan);
        try {
            let ban = await repo.findOne(ip);
            if (ban) {
                ban.count += count;
                const banTime = ban.count > 3 ? Math.pow(2, ban.count - 3) * 2 : 0;
                const banDate = (0, moment_1.default)(ban.time);
                if ((0, moment_1.default)().isAfter(banDate)) {
                    ban.time = (0, moment_1.default)().add(banTime, 'm').toDate();
                }
                else {
                    ban.time = (0, moment_1.default)(banDate).add(banTime, 'm').toDate();
                }
                if (!underscore_1.default.contains(ban.reasons, reason)) {
                    ban.reasons.push(reason);
                }
                ban.needTip = 1;
            }
            else {
                ban = new RandomDuelBan_1.RandomDuelBan();
                ban.ip = ip;
                ban.time = (0, moment_1.default)().toDate();
                ban.count = count;
                ban.reasons = [reason];
                ban.needTip = 1;
            }
            return await repo.save(ban);
        }
        catch (e) {
            this.log.warn(`Failed to update random duel ban ${ip}: ${e.toString()}`);
            return null;
        }
    }
    async getAllDuelLogs() {
        const repo = this.db.getRepository(DuelLog_1.DuelLog);
        try {
            const allDuelLogs = await repo.find({ relations: ["players"] });
            return allDuelLogs;
        }
        catch (e) {
            this.log.warn(`Failed to fetch duel logs: ${e.toString()}`);
            return [];
        }
    }
    getEscapedString(text) {
        return text.replace(/\\/g, "").replace(/_/g, "\\_").replace(/%/g, "\\%") + "%";
    }
    async getDuelLogFromCondition(data) {
        //console.log(data);
        if (!data) {
            return this.getAllDuelLogs();
        }
        const { roomName, duelCount, playerName, playerScore } = data;
        const repo = this.db.getRepository(DuelLog_1.DuelLog);
        try {
            const queryBuilder = repo.createQueryBuilder("duelLog")
                .where("1");
            if (roomName != null && roomName.length) {
                //const escapedRoomName = this.getEscapedString(roomName);
                queryBuilder.andWhere("duelLog.name = :roomName", { roomName });
            }
            if (duelCount != null && !isNaN(duelCount)) {
                queryBuilder.andWhere("duelLog.duelCount = :duelCount", { duelCount });
            }
            if (playerName != null && playerName.length || playerScore != null && !isNaN(playerScore)) {
                const sqb = queryBuilder.subQuery()
                    .select('splayer.id')
                    .from(DuelLogPlayer_1.DuelLogPlayer, 'splayer')
                    .where('splayer.duelLogId = duelLog.id');
                //let innerQuery = "select id from duel_log_player where duel_log_player.duelLogId = duelLog.id";
                const innerQueryParams = {};
                if (playerName != null && playerName.length) {
                    //const escapedPlayerName = this.getEscapedString(playerName);
                    sqb.andWhere('splayer.realName = :playerName');
                    //innerQuery += " and duel_log_player.realName = :playerName";
                    innerQueryParams.playerName = playerName;
                }
                if (playerScore != null && !isNaN(playerScore)) {
                    //innerQuery += " and duel_log_player.score = :playerScore";
                    sqb.andWhere('splayer.score = :playerScore');
                    innerQueryParams.playerScore = playerScore;
                }
                queryBuilder.andWhere(`exists ${sqb.getQuery()}`, innerQueryParams);
            }
            queryBuilder.orderBy("duelLog.id", "DESC")
                .leftJoinAndSelect("duelLog.players", "player");
            // console.log(queryBuilder.getSql());
            const duelLogs = await queryBuilder.getMany();
            return duelLogs;
        }
        catch (e) {
            this.log.warn(`Failed to fetch duel logs: ${e.toString()}`);
            return [];
        }
    }
    async getDuelLogFromId(id) {
        const repo = this.db.getRepository(DuelLog_1.DuelLog);
        try {
            const duelLog = await repo.findOne(id, { relations: ["players"] });
            return duelLog;
        }
        catch (e) {
            this.log.warn(`Failed to fetch duel logs: ${e.toString()}`);
            return null;
        }
    }
    async getDuelLogFromRecoverSearch(realName) {
        const repo = this.db.getRepository(DuelLog_1.DuelLog);
        try {
            const duelLogsQuery = repo.createQueryBuilder("duelLog")
                .where('startDeckBuffer is not null')
                .andWhere('currentDeckBuffer is not null')
                .andWhere('roomMode != 2');
            const sqb = duelLogsQuery.subQuery()
                .select('splayer.id')
                .from(DuelLogPlayer_1.DuelLogPlayer, 'splayer')
                .andWhere('splayer.duelLogId = duelLog.id')
                .andWhere('splayer.realName = :realName');
            const duelLogs = await duelLogsQuery.andWhere(`exists ${sqb.getQuery()}`, { realName })
                .orderBy("duelLog.id", "DESC")
                .limit(10)
                .leftJoinAndSelect("duelLog.players", "player")
                .getMany();
            return duelLogs;
        }
        catch (e) {
            this.log.warn(`Failed to fetch duel logs: ${e.toString()}`);
            return null;
        }
    }
    async getDuelLogJSON(tournamentModeSettings) {
        const allDuelLogs = await this.getAllDuelLogs();
        return allDuelLogs.map(duelLog => duelLog.getViewJSON(tournamentModeSettings));
    }
    async getDuelLogJSONFromCondition(tournamentModeSettings, data) {
        const allDuelLogs = await this.getDuelLogFromCondition(data);
        return allDuelLogs.map(duelLog => duelLog.getViewJSON(tournamentModeSettings));
    }
    async getAllReplayFilenames() {
        const allDuelLogs = await this.getAllDuelLogs();
        return allDuelLogs.map(duelLog => duelLog.replayFileName);
    }
    async getReplayFilenamesFromCondition(data) {
        const allDuelLogs = await this.getDuelLogFromCondition(data);
        return allDuelLogs.map(duelLog => duelLog.replayFileName);
    }
    async getReplayDeckBuffers(replayFileNames) {
        if (!replayFileNames.length) {
            return {};
        }
        const repo = this.db.getRepository(DuelLog_1.DuelLog);
        try {
            const duelLogs = await repo.createQueryBuilder("duelLog")
                .leftJoinAndSelect("duelLog.players", "player")
                .where("duelLog.replayFileName IN (:...replayFileNames)", { replayFileNames })
                .getMany();
            const result = {};
            for (const duelLog of duelLogs) {
                result[duelLog.replayFileName] = duelLog.players
                    .sort((player1, player2) => player1.pos - player2.pos)
                    .slice(0, 2)
                    .map(player => ({ id: player.name, deckbuffer: player.currentDeckBuffer }));
            }
            return result;
        }
        catch (e) {
            this.log.warn(`Failed to fetch replay deck buffers: ${e.toString()}`);
            return {};
        }
    }
    async getReplayArchiveStreamFromCondition(rootPath, data) {
        const filenames = await this.getReplayFilenamesFromCondition(data);
        if (!filenames.length) {
            return null;
        }
        try {
            const zip = new jszip_1.default();
            for (let fileName of filenames) {
                const filePath = `${rootPath}${fileName}`;
                try {
                    await fs.promises.access(filePath);
                    zip.file(fileName, fs.promises.readFile(filePath));
                }
                catch (e) {
                    this.log.warn(`Errored archiving ${filePath}: ${e.toString()}`);
                    continue;
                }
            }
            return zip.generateNodeStream({
                compression: "DEFLATE",
                compressionOptions: {
                    level: 9
                }
            });
        }
        catch (e2) {
            this.log.warn(`Errored creating archive: ${e2.toString()}`);
            return null;
        }
    }
    async clearDuelLog() {
        const runner = this.db.createQueryRunner();
        try {
            await runner.connect();
            await runner.startTransaction();
            if (this.config.type === "postgres") {
                // PostgreSQL has no FOREIGN_KEY_CHECKS switch; truncate both tables in one statement
                await runner.query("TRUNCATE TABLE duel_log_player, duel_log");
            }
            else {
                await runner.query("SET FOREIGN_KEY_CHECKS = 0; ");
                await runner.clearTable("duel_log_player");
                await runner.clearTable("duel_log");
                await runner.query("SET FOREIGN_KEY_CHECKS = 1; ");
            }
            await runner.commitTransaction();
        }
        catch (e) {
            await runner.rollbackTransaction();
            this.log.warn(`Failed to clear duel logs: ${e.toString()}`);
        }
        await runner.release();
    }
    async saveDuelLog(name, roomId, cloudReplayId, replayFilename, roomMode, duelCount, playerInfos) {
        const duelLog = new DuelLog_1.DuelLog();
        duelLog.name = name;
        duelLog.time = (0, moment_1.default)().toDate();
        duelLog.roomId = roomId;
        duelLog.cloudReplayId = cloudReplayId;
        duelLog.replayFileName = replayFilename;
        duelLog.roomMode = roomMode;
        duelLog.duelCount = duelCount;
        const players = playerInfos.map(p => DuelLogPlayer_1.DuelLogPlayer.fromDuelLogPlayerInfo(p));
        await this.transaction(async (mdb) => {
            try {
                const savedDuelLog = await mdb.save(duelLog);
                for (let player of players) {
                    player.duelLog = savedDuelLog;
                }
                await mdb.save(players);
                return true;
            }
            catch (e) {
                this.log.warn(`Failed to save duel log ${name}: ${e.toString()}`);
                return false;
            }
        });
    }
    async getUser(key) {
        const repo = this.db.getRepository(User_1.User);
        try {
            const user = await repo.findOne(key);
            return user;
        }
        catch (e) {
            this.log.warn(`Failed to fetch user: ${e.toString()}`);
            return null;
        }
    }
    async getOrCreateUser(key) {
        const user = await this.getUser(key);
        if (user) {
            return user;
        }
        const newUser = new User_1.User();
        newUser.key = key;
        return await this.saveUser(newUser);
    }
    async saveUser(user) {
        const repo = this.db.getRepository(User_1.User);
        try {
            return await repo.save(user);
        }
        catch (e) {
            this.log.warn(`Failed to save user: ${e.toString()}`);
            return null;
        }
    }
    async getUserChatColor(key) {
        const user = await this.getUser(key);
        return user ? user.chatColor : null;
    }
    async setUserChatColor(key, color) {
        let user = await this.getOrCreateUser(key);
        user.chatColor = color;
        return await this.saveUser(user);
    }
    async migrateChatColors(data) {
        await this.transaction(async (mdb) => {
            try {
                const users = [];
                for (let key in data) {
                    const chatColor = data[key];
                    let user = await mdb.findOne(User_1.User, key);
                    if (!user) {
                        user = new User_1.User();
                        user.key = key;
                    }
                    user.chatColor = chatColor;
                    users.push(user);
                }
                await mdb.save(users);
                return true;
            }
            catch (e) {
                this.log.warn(`Failed to migrate chat color data: ${e.toString()}`);
                return false;
            }
        });
    }
    async getRandomDuelScore(name) {
        const repo = this.db.getRepository(RandomDuelScore_1.RandomDuelScore);
        try {
            const score = await repo.findOne(name);
            return score;
        }
        catch (e) {
            this.log.warn(`Failed to fetch random duel score ${name}: ${e.toString()}`);
            return null;
        }
    }
    async saveRandomDuelScore(score) {
        const repo = this.db.getRepository(RandomDuelScore_1.RandomDuelScore);
        try {
            return await repo.save(score);
        }
        catch (e) {
            this.log.warn(`Failed to save random duel score: ${e.toString()}`);
            return null;
        }
    }
    async getOrCreateRandomDuelScore(name) {
        const score = await this.getRandomDuelScore(name);
        if (score) {
            return score;
        }
        const newScore = new RandomDuelScore_1.RandomDuelScore();
        newScore.name = name;
        return await this.saveRandomDuelScore(newScore);
    }
    async getRandomDuelScoreDisplay(name, displayName) {
        const score = await this.getRandomDuelScore(name);
        if (!score) {
            return `${displayName} \${random_score_blank}`;
        }
        return score.getScoreText(displayName);
    }
    async randomDuelPlayerWin(name) {
        const score = await this.getOrCreateRandomDuelScore(name);
        if (!score) {
            return;
        }
        score.win();
        await this.saveRandomDuelScore(score);
    }
    async randomDuelPlayerLose(name) {
        const score = await this.getOrCreateRandomDuelScore(name);
        if (!score) {
            return;
        }
        score.lose();
        await this.saveRandomDuelScore(score);
    }
    async randomDuelPlayerFlee(name) {
        const score = await this.getOrCreateRandomDuelScore(name);
        if (!score) {
            return;
        }
        score.flee();
        await this.saveRandomDuelScore(score);
    }
    async getRandomScoreTop10() {
        try {
            const scores = await this.db.getRepository(RandomDuelScore_1.RandomDuelScore)
                .createQueryBuilder("score")
                .orderBy("score.win", "DESC")
                .addOrderBy("score.lose", "ASC")
                .addOrderBy("score.flee", "ASC")
                .limit(10)
                .getMany();
            return scores.map(score => [score.getDisplayName(), {
                    win: score.winCount,
                    lose: score.loseCount,
                    flee: score.fleeCount,
                    combo: score.winCombo
                }]);
        }
        catch (e) {
            this.log.warn(`Failed to fetch random duel score ${name}: ${e.toString()}`);
            return [];
        }
    }
    // ===== Ladder (天梯) =====
    normalizeMonthKey(monthKey) {
        if (!monthKey) {
            return (0, moment_1.default)().format("YYYYMM");
        }
        const compact = String(monthKey).replace(/[^0-9]/g, "");
        if (compact.length === 6) {
            return compact;
        }
        const parsed = (0, moment_1.default)(monthKey, ["YYYY-MM", "YYYYMM", "YYYY/MM", "YYYY-MM-DD"], true);
        if (parsed.isValid()) {
            return parsed.format("YYYYMM");
        }
        return (0, moment_1.default)().format("YYYYMM");
    }
    loadLadderScoreConfig() {
        const configPath = require("path").join(process.cwd(), "plugins", "ladder_score", "ladder_score_config.json");
        try {
            if (!fs.existsSync(configPath)) {
                return { useDynamic: true, minDelta: 8, maxDelta: 15, fixedDelta: 12, K: 20, rankingBasis: "points" };
            }
            const source = JSON.parse(fs.readFileSync(configPath, "utf8"));
            return { useDynamic: true, minDelta: 8, maxDelta: 15, fixedDelta: 12, K: 20, rankingBasis: "points", ...source };
        }
        catch (e) {
            return { useDynamic: true, minDelta: 8, maxDelta: 15, fixedDelta: 12, K: 20, rankingBasis: "points" };
        }
    }
    getLadderRankingBasis(rankingBasis) {
        const requested = rankingBasis || this.loadLadderScoreConfig().rankingBasis;
        return requested === "diff" || requested === "winRate" || requested === "points" ? requested : "points";
    }
    getLadderDeltaForMatch(playerPoints, opponentPoints, isWin) {
        const config = this.loadLadderScoreConfig();
        const minDelta = Number(config.minDelta ?? 8);
        const maxDelta = Number(config.maxDelta ?? 15);
        const K = Number(config.K ?? 20); // 建议新增配置项，默认20
        // 1. 计算当前玩家的预期胜率（Elo公式）
        const expected = 1 / (1 + Math.pow(10, (opponentPoints - playerPoints) / 400));
        // 2. 实际得分：赢=1，输=0
        const actualScore = isWin ? 1 : 0;
        // 3. 计算原始Elo变化值
        const rawDelta = K * (actualScore - expected);
        // 4. 取绝对值后限制在 [minDelta, maxDelta] 区间，再根据胜负赋予正负
        const absDelta = Math.min(maxDelta, Math.max(minDelta, Math.round(Math.abs(rawDelta))));
        const delta = isWin ? absDelta : -absDelta;
        return delta;
    }
    normalizeDeckInput(deck) {
        if (!deck) {
            return { main: [], side: [] };
        }
        if (Buffer.isBuffer(deck)) {
            try {
                const decoded = ygopro_deck_encode_1.default.fromUpdateDeckPayload(deck);
                return { main: decoded.main || [], side: decoded.side || [] };
            }
            catch (e) {
                return { main: [], side: [] };
            }
        }
        if (typeof deck === "string") {
            try {
                const decoded = ygopro_deck_encode_1.default.fromYdkString(deck);
                return { main: decoded.main || [], side: decoded.side || [] };
            }
            catch (e) {
                return { main: [], side: [] };
            }
        }
        return {
            main: Array.isArray(deck.main) ? deck.main.map((id) => Number(id)) : [],
            side: Array.isArray(deck.side) ? deck.side.map((id) => Number(id)) : []
        };
    }
    async detectDeckTemplateId(deck) {
        const normalized = this.normalizeDeckInput(deck);
        const deckCards = new Set((normalized.main || []).map((id) => Number(id)));
        const templatesPath = path.join(process.cwd(), "plugins", "deck_analysis", "deck_templates");
        if (!fs.existsSync(templatesPath)) {
            return 4095;
        }
        let bestId = 4095;
        let bestMatch = 0;
        for (const filename of fs.readdirSync(templatesPath)) {
            if (!/^\d+\.ydk$/.test(filename)) {
                continue;
            }
            const templateId = Number(filename.replace(/\.ydk$/, ""));
            try {
                const templateDeck = ygopro_deck_encode_1.default.fromYdkString(fs.readFileSync(path.join(templatesPath, filename), "utf8"));
                const templateCards = (templateDeck.main || []).map((id) => Number(id));
                if (!templateCards.length) {
                    continue;
                }
                const matchCount = templateCards.filter((id) => deckCards.has(id)).length;
                if (matchCount === templateCards.length) {
                    return templateId;
                }
                if (matchCount > bestMatch) {
                    bestMatch = matchCount;
                    bestId = templateId;
                }
            }
            catch (e) {
                continue;
            }
        }
        return bestId;
    }
    async getLadderDeckStats(monthKey) {
        const repo = this.db.getRepository(LadderMatch_1.LadderMatch);
        const targetMonth = this.normalizeMonthKey(monthKey || (0, moment_1.default)().format("YYYYMM"));
        const matches = await repo.find({ where: { monthKey: targetMonth } });
        const matchIds = new Set(matches.map((match) => match.id));
        const games = (await this.db.getRepository(LadderMatchGame_1.LadderMatchGame).find()).filter((game) => matchIds.has(game.matchId));
        const matrix = {};
        const ensure = (key) => matrix[key] || (matrix[key] = { matches: 0, matchWins: 0, firstMatches: 0, firstWins: 0, secondMatches: 0, secondWins: 0, games: 0, gameWins: 0, firstGames: 0, firstGameWins: 0, secondGames: 0, secondGameWins: 0, mainGames: 0, mainGameWins: 0, mainFirstGames: 0, mainFirstGameWins: 0, mainSecondGames: 0, mainSecondGameWins: 0, sideGames: 0, sideGameWins: 0, sideFirstGames: 0, sideFirstGameWins: 0, sideSecondGames: 0, sideSecondGameWins: 0 });
        const addMatch = (deckId, opponentId, playerName, firstPlayer, winnerName) => {
            const item = ensure(`${deckId}::${opponentId}`);
            const won = !!winnerName && winnerName === playerName;
            const isFirst = !!firstPlayer && firstPlayer === playerName;
            item.matches += 1;
            if (won) {
                item.matchWins += 1;
            }
            if (isFirst) {
                item.firstMatches += 1;
                if (won) {
                    item.firstWins += 1;
                }
            }
            else if (firstPlayer) {
                item.secondMatches += 1;
                if (won) {
                    item.secondWins += 1;
                }
            }
        };
        for (const match of matches) {
            addMatch(match.playerADeckTypeId, match.playerBDeckTypeId, match.playerAName, match.g1FirstPlayer, match.winnerName);
            addMatch(match.playerBDeckTypeId, match.playerADeckTypeId, match.playerBName, match.g1FirstPlayer, match.winnerName);
        }
        const matchById = new Map(matches.map((match) => [match.id, match]));
        for (const game of games) {
            const match = matchById.get(game.matchId);
            if (!match) {
                continue;
            }
            const opponentId = game.playerName === match.playerAName ? match.playerBDeckTypeId : match.playerADeckTypeId;
            const item = ensure(`${game.deckTypeId}::${opponentId}`);
            const won = !!game.winnerName && game.winnerName === game.playerName;
            const first = Number(game.isFirst) === 1;
            item.games += 1;
            if (won) {
                item.gameWins += 1;
            }
            if (first) {
                item.firstGames += 1;
                if (won) {
                    item.firstGameWins += 1;
                }
            }
            else {
                item.secondGames += 1;
                if (won) {
                    item.secondGameWins += 1;
                }
            }
            if (Number(game.isMain) === 1) {
                item.mainGames += 1;
                if (won) {
                    item.mainGameWins += 1;
                }
                if (first) {
                    item.mainFirstGames += 1;
                    if (won) {
                        item.mainFirstGameWins += 1;
                    }
                }
                else {
                    item.mainSecondGames += 1;
                    if (won) {
                        item.mainSecondGameWins += 1;
                    }
                }
            }
            if (Number(game.isSide) === 1) {
                item.sideGames += 1;
                if (won) {
                    item.sideGameWins += 1;
                }
                if (first) {
                    item.sideFirstGames += 1;
                    if (won) {
                        item.sideFirstGameWins += 1;
                    }
                }
                else {
                    item.sideSecondGames += 1;
                    if (won) {
                        item.sideSecondGameWins += 1;
                    }
                }
            }
        }
        return { monthKey: targetMonth, matrix };
    }
    async upsertLadderMonthRecord(name, monthKey, duelPoints, wins, losses) {
        const repo = this.db.getRepository(LadderMonthRecord_1.LadderMonthRecord);
        const normalizedKey = this.normalizeMonthKey(monthKey);
        const existing = await repo.findOne({ where: { name: name.toLowerCase(), monthKey: normalizedKey } });
        if (existing) {
            existing.duelPoints = duelPoints;
            existing.wins = wins;
            existing.losses = losses;
            existing.scoreDiff = wins - losses;
            await repo.save(existing);
            return existing;
        }
        const record = new LadderMonthRecord_1.LadderMonthRecord();
        record.name = name.toLowerCase();
        record.monthKey = normalizedKey;
        record.duelPoints = duelPoints;
        record.wins = wins;
        record.losses = losses;
        record.scoreDiff = wins - losses;
        await repo.save(record);
        return record;
    }
    async recordLadderMatchWithScore({ monthKey, playerA, playerB, winnerName, loserName, duelLogId, g1FirstPlayer, coinWinner }) {
        const repo = this.db.getRepository(LadderMatch_1.LadderMatch);
        const match = new LadderMatch_1.LadderMatch();
        match.monthKey = this.normalizeMonthKey(monthKey);
        match.playerAName = playerA.name.toLowerCase();
        match.playerBName = playerB.name.toLowerCase();
        match.winnerName = (winnerName || playerA.name).toLowerCase();
        match.loserName = (loserName || playerB.name).toLowerCase();
        match.playerADeckTypeId = Number(playerA.deckTypeId) || 4095;
        match.playerBDeckTypeId = Number(playerB.deckTypeId) || 4095;
        match.playerADuelPointsBefore = Number(playerA.duelPointsBefore) || 1000;
        match.playerBDuelPointsBefore = Number(playerB.duelPointsBefore) || 1000;
        match.playerADuelPointsAfter = Number(playerA.duelPointsAfter) || 1000;
        match.playerBDuelPointsAfter = Number(playerB.duelPointsAfter) || 1000;
        match.playerADuelPointsDelta = Number(playerA.duelPointsDelta) || 0;
        match.playerBDuelPointsDelta = Number(playerB.duelPointsDelta) || 0;
        match.g1FirstPlayer = g1FirstPlayer ? g1FirstPlayer.toLowerCase() : null;
        match.coinWinner = coinWinner ? coinWinner.toLowerCase() : null;
        match.duelLogId = duelLogId || null;
        await repo.save(match);
        const gameRepo = this.db.getRepository(LadderMatchGame_1.LadderMatchGame);
        await gameRepo.save([
            { matchId: match.id, duelLogId: duelLogId || null, playerName: playerA.name.toLowerCase(), opponentName: playerB.name.toLowerCase(), deckTypeId: Number(playerA.deckTypeId) || 4095, winnerName: (winnerName || playerA.name).toLowerCase(), gNumber: 1, isFirst: 0, isMain: 1, isSide: 0, duelCount: 1 },
            { matchId: match.id, duelLogId: duelLogId || null, playerName: playerB.name.toLowerCase(), opponentName: playerA.name.toLowerCase(), deckTypeId: Number(playerB.deckTypeId) || 4095, winnerName: (winnerName || playerA.name).toLowerCase(), gNumber: 1, isFirst: 0, isMain: 1, isSide: 0, duelCount: 1 }
        ]);
        return match;
    }
    // 名字规范化:不区分大小写,同一用户
    async getLadderUser(name) {
        const repo = this.db.getRepository(LadderUser_1.LadderUser);
        try {
            return await repo.findOne(name.toLowerCase());
        }
        catch (e) {
            this.log.warn(`Failed to fetch ladder user ${name}: ${e.toString()}`);
            return null;
        }
    }
    // 返回 'registered'(新注册) 或 'exists'(已存在)
    async registerLadderUser(name, pass) {
        const key = name.toLowerCase();
        const repo = this.db.getRepository(LadderUser_1.LadderUser);
        try {
            const existing = await repo.findOne(key);
            if (existing) {
                return 'exists';
            }
            const user = new LadderUser_1.LadderUser();
            user.name = key;
            user.pass = pass || null;
            user.createdAt = new Date();
            await repo.save(user);
            return 'registered';
        }
        catch (e) {
            this.log.warn(`Failed to register ladder user ${name}: ${e.toString()}`);
            return 'exists';
        }
    }
    // 更新一次天梯战绩。monthKey 形如 "2026-08"
    async updateLadderRecord(name, isWin, monthKey) {
        const key = name.toLowerCase();
        const repo = this.db.getRepository(LadderUser_1.LadderUser);
        try {
            let user = await repo.findOne(key);
            if (!user) {
                return;
            }
            const normalizedKey = this.normalizeMonthKey(monthKey);
            if (this.normalizeMonthKey(user.monthKey) !== normalizedKey) {
                user.monthWins = 0;
                user.monthLosses = 0;
                user.monthDuelPoints = 1000;
                user.monthKey = normalizedKey;
            }
            if (isWin) {
                user.wins += 1;
                user.monthWins += 1;
            }
            else {
                user.losses += 1;
                user.monthLosses += 1;
            }
            await repo.save(user);
        }
        catch (e) {
            this.log.warn(`Failed to update ladder record ${name}: ${e.toString()}`);
        }
    }
    // 结算一次天梯对战:未注册→注册;已注册且密码对→统计;密码不对→不计入
    // 无密码昵称(不带 $)一律不注册、不计入
    // 返回 { counted: boolean, registered: boolean }
    async tallyLadderResult(name, pass, isWin, monthKey) {
        const key = name.toLowerCase();
        if (!pass) {
            return { counted: false, registered: false };
        }
        const repo = this.db.getRepository(LadderUser_1.LadderUser);
        try {
            let user = await repo.findOne(key);
            if (!user) {
                user = new LadderUser_1.LadderUser();
                user.name = key;
                user.pass = pass || null;
                user.createdAt = new Date();
                await repo.save(user);
                this.log.info(`Ladder user registered: ${key}`);
                user = (await repo.findOne(key));
            }
            else if (user.pass !== (pass || null)) {
                return { counted: false, registered: true };
            }
            if (!user) {
                return { counted: false, registered: false };
            }
            const normalizedKey = this.normalizeMonthKey(monthKey);
            if (this.normalizeMonthKey(user.monthKey) !== normalizedKey) {
                user.monthWins = 0;
                user.monthLosses = 0;
                user.monthDuelPoints = 1000;
                user.monthKey = normalizedKey;
            }
            const beforeTotal = user.duelPoints ?? 1000;
            const beforeMonth = user.monthDuelPoints ?? 1000;
            const delta = this.getLadderDeltaForMatch(beforeTotal, 1000, isWin);
            user.duelPoints = Math.max(0, beforeTotal + (isWin ? delta : -delta));
            user.monthDuelPoints = Math.max(0, beforeMonth + (isWin ? delta : -delta));
            if (isWin) {
                user.wins += 1;
                user.monthWins += 1;
            }
            else {
                user.losses += 1;
                user.monthLosses += 1;
            }
            await repo.save(user);
            await this.upsertLadderMonthRecord(user.name, normalizedKey, user.monthDuelPoints, user.monthWins, user.monthLosses);
            return { counted: true, registered: true };
        }
        catch (e) {
            this.log.warn(`Failed to tally ladder result ${name}: ${e.toString()}`);
            return { counted: false, registered: false };
        }
    }
    async applyLadderMatchResult({ monthKey, playerA, playerB, winnerName, loserName, duelLogId, g1FirstPlayer, coinWinner, deckA, deckB }) {
        const userRepo = this.db.getRepository(LadderUser_1.LadderUser);
        const monthKeyValue = this.normalizeMonthKey(monthKey);
        const [aUser, bUser] = await Promise.all([
            userRepo.findOne(playerA.name.toLowerCase()),
            userRepo.findOne(playerB.name.toLowerCase())
        ]);
        const userA = aUser || new LadderUser_1.LadderUser();
        if (!aUser) {
            userA.name = playerA.name.toLowerCase();
            userA.pass = playerA.pass || null;
            userA.createdAt = new Date();
        }
        if (userA.pass !== (playerA.pass || null) && aUser) {
            return { counted: false, registered: true };
        }
        const userB = bUser || new LadderUser_1.LadderUser();
        if (!bUser) {
            userB.name = playerB.name.toLowerCase();
            userB.pass = playerB.pass || null;
            userB.createdAt = new Date();
        }
        if (userB.pass !== (playerB.pass || null) && bUser) {
            return { counted: false, registered: true };
        }
        const aDeckTypeId = await this.detectDeckTemplateId(deckA || playerA.deck || null);
        const bDeckTypeId = await this.detectDeckTemplateId(deckB || playerB.deck || null);
        const aBefore = userA.duelPoints ?? 1000;
        const bBefore = userB.duelPoints ?? 1000;
        const aDelta = this.getLadderDeltaForMatch(aBefore, bBefore, winnerName ? winnerName.toLowerCase() === userA.name : false);
        const bDelta = this.getLadderDeltaForMatch(bBefore, aBefore, winnerName ? winnerName.toLowerCase() === userB.name : false);
        if (!aUser)
            await userRepo.save(userA);
        if (!bUser)
            await userRepo.save(userB);
        const aFinal = Math.max(0, aBefore + (winnerName ? aDelta : 0));
        const bFinal = Math.max(0, bBefore + (winnerName ? bDelta : 0));
        if (this.normalizeMonthKey(userA.monthKey) !== monthKeyValue) {
            userA.monthWins = 0;
            userA.monthLosses = 0;
            userA.monthDuelPoints = 1000;
            userA.monthKey = monthKeyValue;
        }
        if (this.normalizeMonthKey(userB.monthKey) !== monthKeyValue) {
            userB.monthWins = 0;
            userB.monthLosses = 0;
            userB.monthDuelPoints = 1000;
            userB.monthKey = monthKeyValue;
        }
        userA.duelPoints = aFinal;
        userB.duelPoints = bFinal;
        userA.monthDuelPoints = (userA.monthDuelPoints ?? 1000) + (winnerName ? aDelta : 0);
        userB.monthDuelPoints = (userB.monthDuelPoints ?? 1000) + (winnerName ? bDelta : 0);
        const aWin = winnerName ? winnerName.toLowerCase() === userA.name : false;
        const bWin = winnerName ? winnerName.toLowerCase() === userB.name : false;
        userA.wins += aWin ? 1 : 0;
        userA.losses += aWin ? 0 : 1;
        userB.wins += bWin ? 1 : 0;
        userB.losses += bWin ? 0 : 1;
        userA.monthWins += aWin ? 1 : 0;
        userA.monthLosses += aWin ? 0 : 1;
        userB.monthWins += bWin ? 1 : 0;
        userB.monthLosses += bWin ? 0 : 1;
        await userRepo.save([userA, userB]);
        await this.upsertLadderMonthRecord(userA.name, monthKeyValue, userA.monthDuelPoints, userA.monthWins, userA.monthLosses);
        await this.upsertLadderMonthRecord(userB.name, monthKeyValue, userB.monthDuelPoints, userB.monthWins, userB.monthLosses);
        await this.recordLadderMatchWithScore({
            monthKey: monthKeyValue,
            playerA: { name: userA.name, pass: userA.pass, deckTypeId: aDeckTypeId, duelPointsBefore: aBefore, duelPointsAfter: userA.duelPoints, duelPointsDelta: userA.duelPoints - aBefore },
            playerB: { name: userB.name, pass: userB.pass, deckTypeId: bDeckTypeId, duelPointsBefore: bBefore, duelPointsAfter: userB.duelPoints, duelPointsDelta: userB.duelPoints - bBefore },
            winnerName: winnerName || userA.name,
            loserName: loserName || userB.name,
            duelLogId,
            g1FirstPlayer,
            coinWinner
        });
        return { counted: true, registered: true };
    }
    // 天梯前 N,type: 'total' | 'month'
    // search: 搜索name中包含的字符串
    // page: 页数（从1开始）
    // pagesize: 每页数量
    // 返回 { users: [...], total: number }
    async getLadderTop(type, search = '', page = 1, pagesize = 50, monthKey, rankingBasis) {
        try {
            const repo = this.db.getRepository(LadderUser_1.LadderUser);
            const isMonth = type === 'month';
            const effectiveRankingBasis = this.getLadderRankingBasis(rankingBasis);
            const allUsers = await repo.find();
            const targetMonth = this.normalizeMonthKey(monthKey || (isMonth ? (0, moment_1.default)().format('YYYYMM') : null));
            const filteredUsers = allUsers.filter((u) => {
                if (search && !u.name.includes(search)) {
                    return false;
                }
                if (isMonth) {
                    return this.normalizeMonthKey(u.monthKey) === targetMonth;
                }
                return true;
            });
            filteredUsers.sort((a, b) => {
                const aPoints = isMonth ? (a.monthDuelPoints ?? 1000) : (a.duelPoints ?? 1000);
                const bPoints = isMonth ? (b.monthDuelPoints ?? 1000) : (b.duelPoints ?? 1000);
                const aWins = isMonth ? a.monthWins : a.wins;
                const bWins = isMonth ? b.monthWins : b.wins;
                const aLosses = isMonth ? a.monthLosses : a.losses;
                const bLosses = isMonth ? b.monthLosses : b.losses;
                const aDiff = aWins - aLosses;
                const bDiff = bWins - bLosses;
                if (effectiveRankingBasis === "diff" && bDiff !== aDiff) {
                    return bDiff - aDiff;
                }
                if (effectiveRankingBasis === "winRate" && bWins * (aWins + aLosses) !== aWins * (bWins + bLosses)) {
                    return bWins * (aWins + aLosses) - aWins * (bWins + bLosses);
                }
                if (bPoints !== aPoints) {
                    return bPoints - aPoints;
                }
                if (bWins !== aWins) {
                    return bWins - aWins;
                }
                return bDiff - aDiff;
            });
            const total = filteredUsers.length;
            const paginatedUsers = filteredUsers.slice((page - 1) * pagesize, page * pagesize);
            const users = paginatedUsers.map((u, index) => {
                const wins = isMonth ? u.monthWins : u.wins;
                const losses = isMonth ? u.monthLosses : u.losses;
                const duelPoints = isMonth ? (u.monthDuelPoints ?? 1000) : (u.duelPoints ?? 1000);
                return {
                    rank: (page - 1) * pagesize + index + 1,
                    name: u.name,
                    wins,
                    losses,
                    diff: wins - losses,
                    winRate: (wins + losses) ? ((wins / (wins + losses)) * 100) : 0,
                    duelPoints,
                    monthDuelPoints: u.monthDuelPoints ?? 1000,
                    monthKey: u.monthKey,
                };
            });
            return { users, total, rankingBasis: effectiveRankingBasis };
        }
        catch (e) {
            this.log.warn(`Failed to fetch ladder top: ${e.toString()}`);
            return { users: [], total: 0, rankingBasis: this.getLadderRankingBasis(rankingBasis) };
        }
    }
}
exports.DataManager = DataManager;
