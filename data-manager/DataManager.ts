import moment from "moment";
import bunyan from "bunyan";
import {Connection, createConnection, EntityManager} from "typeorm";
import {CloudReplay} from "./entities/CloudReplay";
import {CloudReplayPlayer} from "./entities/CloudReplayPlayer";
import {Ban} from "./entities/Ban";
import {RandomDuelBan} from "./entities/RandomDuelBan";
import _ from "underscore";
import {DuelLog} from "./entities/DuelLog";
import {Deck} from "./DeckEncoder";
import {DuelLogPlayer} from "./entities/DuelLogPlayer";
import {User} from "./entities/User";
import {RandomDuelScore} from "./entities/RandomDuelScore";
import JSZip from "jszip";
import * as fs from "fs";
import "reflect-metadata";
import { MysqlConnectionOptions } from "typeorm/driver/mysql/MysqlConnectionOptions";
import { PostgresConnectionOptions } from "typeorm/driver/postgres/PostgresConnectionOptions";
import {LadderUser} from "./entities/LadderUser";
import {LadderMatch} from "./entities/LadderMatch";
import {LadderMatchGame} from "./entities/LadderMatchGame";
import {LadderMonthRecord} from "./entities/LadderMonthRecord";
import YGOProDeck from "ygopro-deck-encode";
import * as path from "path";

interface BasePlayerInfo {
	name: string;
	pos: number
}

export interface CloudReplayPlayerInfo extends BasePlayerInfo {
	key: string;
}

export interface DuelLogPlayerInfo extends BasePlayerInfo {
	realName: string;
	startDeckBuffer: Buffer;
	deck: Deck;
	isFirst: boolean;
	winner: boolean;
	ip: string;
	score: number;
	lp: number;
	cardCount: number;
}

export interface DuelLogQuery {roomName: string, duelCount: number, playerName: string, playerScore: number}


export class DataManager {
	ready: boolean;
	private db: Connection;
	constructor(private config: MysqlConnectionOptions | PostgresConnectionOptions, private log: bunyan) {
		this.ready = false;
	}
	private async transaction(fun: (mdb: EntityManager) => Promise<boolean>) {
		try {
			// @ts-ignore
			if (this.config.type !== 'sqlite' && this.config.type !== 'sqljs') {
				await this.db.transaction(async (mdb) => {
					const result = await fun(mdb);
					if (!result) {
						throw new Error('Rollback requested.');
					}
				});
			} else {
				await fun(this.db.manager);
			}
		} catch (e) {
			this.log.warn(`Transaction failed: ${e.toString()}`);
		}
	}
	async init() {
		const dbType = (this.config as any).type || "mysql";
		const common = {
			synchronize: true,
			entities: ["./data-manager/entities/*.js"],
			...this.config
		};
		if (dbType === "postgres") {
			this.db = await createConnection({
				type: "postgres",
				...common
			} as any);
		} else if (dbType === "sqlite" || dbType === "sqljs") {
			this.db = await createConnection({
				type: dbType,
				...common
			} as any);
		} else {
			this.db = await createConnection({
				type: "mysql",
				supportBigNumbers: true,
				bigNumberStrings: false,
				...common
			} as any);
		}
		this.ready = true;
	}
	async getCloudReplaysFromKey(key: string) {
		try {
			const replaysQuery = this.db.createQueryBuilder(CloudReplay, "replay");
			const sqb = replaysQuery.subQuery()
				.select('splayer.id')
				.from(CloudReplayPlayer, 'splayer')
				.where('splayer.cloudReplayId = replay.id')
				.andWhere('splayer.key = :key');
			const replays = await replaysQuery.where(`exists ${sqb.getQuery()}`, { key })
				.orderBy("replay.date", "DESC")
				.limit(10)
				.leftJoinAndSelect("replay.players", "player")
				.getMany();
			return replays;
		} catch (e) {
			this.log.warn(`Failed to load replay of ${key}: ${e.toString()}`);
			return [];
		}

	}

	async getCloudReplayFromId(id: number) {
		try {
			return await this.db.getRepository(CloudReplay).findOne(id, { relations: ["players"] });
		} catch (e) {
			this.log.warn(`Failed to load replay R#${id}: ${e.toString()}`);
			return null;
		}
	}

	async getRandomCloudReplay() {
		try {
			const [minQuery, maxQuery] = await Promise.all(["min", "max"].map(minOrMax => this.db.createQueryBuilder()
				.select(`${minOrMax}(id)`, "value")
				.from(CloudReplay, "replay")
				.getRawOne()
			));
			if(!minQuery || !maxQuery) {
				return null;
			}
			const [minId, maxId] = [minQuery, maxQuery].map(query => parseInt(query.value));
			const targetId = Math.floor((maxId - minId) * Math.random()) + minId;
			return await this.db.createQueryBuilder(CloudReplay, "replay")
				.where("replay.id >= :targetId", {targetId})
				.orderBy("replay.id", "ASC")
				.limit(4) //there may be 4 players
				.leftJoinAndSelect("replay.players", "player")
				.getOne();
		} catch (e) {
			this.log.warn(`Failed to load random replay: ${e.toString()}`);
			return null;
		}
	}

	async saveCloudReplay(id: number, buffer: Buffer, playerInfos: CloudReplayPlayerInfo[]) {
		const replay = new CloudReplay();
		replay.id = id;
		replay.fromBuffer(buffer);
		replay.date = moment().toDate();
		const players = playerInfos.map(p => {
			const player = CloudReplayPlayer.fromPlayerInfo(p);
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
			} catch (e) {
				this.log.warn(`Failed to save replay R#${replay.id}: ${e.toString()}`);
				return false;
			}
		});
	}

	async checkBan(field: string, value: string) {
		const banQuery: any = {};
		banQuery[field] = value;
		try {
			return await this.db.getRepository(Ban).findOne(banQuery);
		} catch (e) {
			this.log.warn(`Failed to load ban ${field} ${value}: ${e.toString()}`);
			return null;
		}
	}

	async checkBanWithNameAndIP(name: string, ip: string) {
		try {
			return await this.db.getRepository(Ban).findOne({ name, ip });
		} catch (e) {
			this.log.warn(`Failed to load ban ${name} ${ip}: ${e.toString()}`);
			return null;
		}
	}

	getBan(name: string, ip: string) {
		const ban = new Ban();
		ban.ip = ip;
		ban.name = name;
		return ban;
	}

	async banPlayer(ban: Ban) {
		try {
			const repo = this.db.getRepository(Ban);
			if (await repo.findOne({
				ip: ban.ip,
				name: ban.name
			})) {
				return;
			}
			return await repo.save(ban);
		} catch (e) {
			this.log.warn(`Failed to update ban ${JSON.stringify(ban)}: ${e.toString()}`);
			return null;
		}
	}

	async getRandomDuelBan(ip: string) {
		const repo = this.db.getRepository(RandomDuelBan);
		try {
			const ban = await repo.findOne(ip);
			//console.log(ip, ban);
			return ban;
		} catch (e) {
			this.log.warn(`Failed to fetch random duel ban ${ip}: ${e.toString()}`);
			return null;
		}
	}

	async updateRandomDuelBan(ban: RandomDuelBan) {
		const repo = this.db.getRepository(RandomDuelBan);
		try {
			await repo.save(ban);
		} catch (e) {
			this.log.warn(`Failed to update random duel ban ${ban.ip}: ${e.toString()}`);
		}
	}

	async randomDuelBanPlayer(ip: string, reason: string, countadd?: number) {
		const count = countadd || 1;
		const repo = this.db.getRepository(RandomDuelBan);
		try {
			let ban = await repo.findOne(ip);
			if(ban) {
				ban.count += count;
				const banTime = ban.count > 3 ? Math.pow(2, ban.count - 3) * 2 : 0;
				const banDate = moment(ban.time);
				if(moment().isAfter(banDate)) {
					ban.time = moment().add(banTime, 'm').toDate();
				} else {
					ban.time = moment(banDate).add(banTime, 'm').toDate();
				}
				if(!_.contains(ban.reasons, reason)) {
					ban.reasons.push(reason);
				}
				ban.needTip = 1;
			} else {
				ban = new RandomDuelBan();
				ban.ip = ip;
				ban.time = moment().toDate();
				ban.count = count;
				ban.reasons = [reason];
				ban.needTip = 1;
			}
			return await repo.save(ban);
		} catch (e) {
			this.log.warn(`Failed to update random duel ban ${ip}: ${e.toString()}`);
			return null;
		}

	}

	async getAllDuelLogs() {
		const repo = this.db.getRepository(DuelLog);
		try {
			const allDuelLogs = await repo.find({relations: ["players"]});
			return allDuelLogs;
		} catch (e) {
			this.log.warn(`Failed to fetch duel logs: ${e.toString()}`);
			return [];
		}

	}

	private getEscapedString(text: string) {
		return text.replace(/\\/g, "").replace(/_/g, "\\_").replace(/%/g, "\\%") + "%";
	}

	async getDuelLogFromCondition(data: DuelLogQuery) {
		//console.log(data);
		if(!data) {
			return this.getAllDuelLogs();
		}
		const {roomName, duelCount, playerName, playerScore} = data;
		const repo = this.db.getRepository(DuelLog);
		try {
			const queryBuilder = repo.createQueryBuilder("duelLog")
				.where("1");
			if(roomName != null && roomName.length) {
				//const escapedRoomName = this.getEscapedString(roomName);
				queryBuilder.andWhere("duelLog.name = :roomName", { roomName });
			}
			if(duelCount != null && !isNaN(duelCount)) {
				queryBuilder.andWhere("duelLog.duelCount = :duelCount", { duelCount });
			}
			if (playerName != null && playerName.length || playerScore != null && !isNaN(playerScore)) {
				const sqb = queryBuilder.subQuery()
					.select('splayer.id')
					.from(DuelLogPlayer, 'splayer')
					.where('splayer.duelLogId = duelLog.id');
				//let innerQuery = "select id from duel_log_player where duel_log_player.duelLogId = duelLog.id";
				const innerQueryParams: any = {};
				if(playerName != null && playerName.length) {
					//const escapedPlayerName = this.getEscapedString(playerName);
					sqb.andWhere('splayer.realName = :playerName');
					//innerQuery += " and duel_log_player.realName = :playerName";
					innerQueryParams.playerName = playerName;
				}
				if(playerScore != null && !isNaN(playerScore)) {
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
		} catch (e) {
			this.log.warn(`Failed to fetch duel logs: ${e.toString()}`);
			return [];
		}
	}

	async getDuelLogFromId(id: number) {
		const repo = this.db.getRepository(DuelLog);
		try {
			const duelLog = await repo.findOne(id, {relations: ["players"]});
			return duelLog;
		} catch (e) {
			this.log.warn(`Failed to fetch duel logs: ${e.toString()}`);
			return null;
		}

	}

	async getDuelLogFromRecoverSearch(realName: string) {
		const repo = this.db.getRepository(DuelLog);
		try {
			const duelLogsQuery = repo.createQueryBuilder("duelLog")
				.where('startDeckBuffer is not null')
				.andWhere('currentDeckBuffer is not null')
				.andWhere('roomMode != 2');
			const sqb = duelLogsQuery.subQuery()
				.select('splayer.id')
				.from(DuelLogPlayer, 'splayer')
				.andWhere('splayer.duelLogId = duelLog.id')
				.andWhere('splayer.realName = :realName');
			const duelLogs = await duelLogsQuery.andWhere(`exists ${sqb.getQuery()}`, { realName })
				.orderBy("duelLog.id", "DESC")
				.limit(10)
				.leftJoinAndSelect("duelLog.players", "player")
				.getMany();
			return duelLogs;
		} catch (e) {
			this.log.warn(`Failed to fetch duel logs: ${e.toString()}`);
			return null;
		}

	}



	async getDuelLogJSON(tournamentModeSettings: any) {
		const allDuelLogs = await this.getAllDuelLogs();
		return allDuelLogs.map(duelLog => duelLog.getViewJSON(tournamentModeSettings));
	}
	async getDuelLogJSONFromCondition(tournamentModeSettings: any, data: DuelLogQuery) {
		const allDuelLogs = await this.getDuelLogFromCondition(data);
		return allDuelLogs.map(duelLog => duelLog.getViewJSON(tournamentModeSettings));
	}
	async getAllReplayFilenames() {
		const allDuelLogs = await this.getAllDuelLogs();
		return allDuelLogs.map(duelLog => duelLog.replayFileName);
	}
	async getReplayFilenamesFromCondition(data: DuelLogQuery) {
		const allDuelLogs = await this.getDuelLogFromCondition(data);
		return allDuelLogs.map(duelLog => duelLog.replayFileName);
	}

	async getReplayDeckBuffers(replayFileNames: string[]) {
		if (!replayFileNames.length) {
			return {};
		}
		const repo = this.db.getRepository(DuelLog);
		try {
			const duelLogs = await repo.createQueryBuilder("duelLog")
				.leftJoinAndSelect("duelLog.players", "player")
				.where("duelLog.replayFileName IN (:...replayFileNames)", {replayFileNames})
				.getMany();
			const result: {[replayFileName: string]: {id: string, deckbuffer: string}[]} = {};
			for (const duelLog of duelLogs) {
				result[duelLog.replayFileName] = duelLog.players
					.sort((player1, player2) => player1.pos - player2.pos)
					.slice(0, 2)
					.map(player => ({id: player.name, deckbuffer: player.currentDeckBuffer}));
			}
			return result;
		} catch (e) {
			this.log.warn(`Failed to fetch replay deck buffers: ${e.toString()}`);
			return {};
		}
	}
	async getReplayArchiveStreamFromCondition(rootPath: string, data: DuelLogQuery) {
		const filenames = await this.getReplayFilenamesFromCondition(data);
		if(!filenames.length) {
			return null;
		}
		try {
			const zip = new JSZip();
			for(let fileName of filenames) {
				const filePath = `${rootPath}${fileName}`;
				try {
					await fs.promises.access(filePath);
					zip.file(fileName, fs.promises.readFile(filePath));
				} catch(e) {
					this.log.warn(`Errored archiving ${filePath}: ${e.toString()}`)
					continue;
				}
			}
			return zip.generateNodeStream({
				compression: "DEFLATE",
				compressionOptions: {
					level: 9
				}
			});
		} catch(e2) {
			this.log.warn(`Errored creating archive: ${e2.toString()}`)
			return null;
		}
	}
	async clearDuelLog() {
		const runner = this.db.createQueryRunner();
		try {
			await runner.connect();
			await runner.startTransaction();
			if ((this.config as any).type === "postgres") {
				// PostgreSQL has no FOREIGN_KEY_CHECKS switch; truncate both tables in one statement
				await runner.query("TRUNCATE TABLE duel_log_player, duel_log");
			} else {
				await runner.query("SET FOREIGN_KEY_CHECKS = 0; ");
				await runner.clearTable("duel_log_player");
				await runner.clearTable("duel_log");
				await runner.query("SET FOREIGN_KEY_CHECKS = 1; ");
			}
			await runner.commitTransaction();
		} catch (e) {
			await runner.rollbackTransaction();
			this.log.warn(`Failed to clear duel logs: ${e.toString()}`);
		}
		await runner.release();
	}
	async saveDuelLog(name: string, roomId: number, cloudReplayId: number, replayFilename: string, roomMode: number, duelCount: number, playerInfos: DuelLogPlayerInfo[]) {
		const duelLog = new DuelLog();
		duelLog.name = name;
		duelLog.time = moment().toDate();
		duelLog.roomId = roomId;
		duelLog.cloudReplayId = cloudReplayId;
		duelLog.replayFileName = replayFilename;
		duelLog.roomMode = roomMode;
		duelLog.duelCount = duelCount;
		const players = playerInfos.map(p => DuelLogPlayer.fromDuelLogPlayerInfo(p));
		await this.transaction(async (mdb) => {
			try {
				const savedDuelLog = await mdb.save(duelLog);
				for (let player of players) {
					player.duelLog = savedDuelLog;
				}
				await mdb.save(players);
				return true;
			} catch (e) {
				this.log.warn(`Failed to save duel log ${name}: ${e.toString()}`);
				return false;
			}
		});

	}
	async getUser(key: string) {
		const repo = this.db.getRepository(User);
		try {
			const user = await repo.findOne(key);
			return user;
		} catch (e) {
			this.log.warn(`Failed to fetch user: ${e.toString()}`);
			return null;
		}
	}
	async getOrCreateUser(key: string) {
		const user = await this.getUser(key);
		if(user) {
			return user;
		}
		const newUser = new User();
		newUser.key = key;
		return await this.saveUser(newUser);
	}
	async saveUser(user: User) {
		const repo = this.db.getRepository(User);
		try {
			return await repo.save(user);
		} catch (e) {
			this.log.warn(`Failed to save user: ${e.toString()}`);
			return null;
		}
	}
	async getUserChatColor(key: string) {
		const user = await this.getUser(key);
		return user ? user.chatColor : null;
	}
	async setUserChatColor(key: string, color: string) {
		let user = await this.getOrCreateUser(key);
		user.chatColor = color;
		return await this.saveUser(user);
	}

	async migrateChatColors(data: any) {
		await this.transaction(async (mdb) => {
			try {
				const users: User[] = [];
				for(let key in data) {
					const chatColor: string = data[key];
					let user = await mdb.findOne(User, key);
					if(!user) {
						user = new User();
						user.key = key;
					}
					user.chatColor = chatColor;
					users.push(user);
				}
				await mdb.save(users);
				return true;
			} catch (e) {
				this.log.warn(`Failed to migrate chat color data: ${e.toString()}`);
				return false;
			}
		});

	}

	async getRandomDuelScore(name: string) {
		const repo = this.db.getRepository(RandomDuelScore);
		try {
			const score = await repo.findOne(name);
			return score;
		} catch (e) {
			this.log.warn(`Failed to fetch random duel score ${name}: ${e.toString()}`);
			return null;
		}
	}
	async saveRandomDuelScore(score: RandomDuelScore) {
		const repo = this.db.getRepository(RandomDuelScore);
		try {
			return await repo.save(score);
		} catch (e) {
			this.log.warn(`Failed to save random duel score: ${e.toString()}`);
			return null;
		}
	}
	async getOrCreateRandomDuelScore(name: string) {
		const score = await this.getRandomDuelScore(name);
		if(score) {
			return score;
		}
		const newScore = new RandomDuelScore();
		newScore.name = name;
		return await this.saveRandomDuelScore(newScore);
	}
	async getRandomDuelScoreDisplay(name: string, displayName: string) {
		const score = await this.getRandomDuelScore(name);
		if(!score) {
			return `${displayName} \${random_score_blank}`;
		}
		return score.getScoreText(displayName);
	}
	async randomDuelPlayerWin(name: string) {
		const score = await this.getOrCreateRandomDuelScore(name);
		if (!score) {
			return;
		}
		score.win();
		await this.saveRandomDuelScore(score);
	}
	async randomDuelPlayerLose(name: string) {
		const score = await this.getOrCreateRandomDuelScore(name);
		if (!score) {
			return;
		}
		score.lose();
		await this.saveRandomDuelScore(score);
	}
	async randomDuelPlayerFlee(name: string) {
		const score = await this.getOrCreateRandomDuelScore(name);
		if (!score) {
			return;
		}
		score.flee();
		await this.saveRandomDuelScore(score);
	}
	async getRandomScoreTop10() {
		try {
			const scores = await this.db.getRepository(RandomDuelScore)
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
		} catch (e) {
			this.log.warn(`Failed to fetch random duel score ${name}: ${e.toString()}`);
			return [];
		}
	}

	// ===== Ladder (天梯) =====

	private normalizeMonthKey(monthKey?: string | null): string {
		if (!monthKey) {
			return moment().format("YYYYMM");
		}
		const compact = String(monthKey).replace(/[^0-9]/g, "");
		if (compact.length === 6) {
			return compact;
		}
		const parsed = moment(monthKey, ["YYYY-MM", "YYYYMM", "YYYY/MM", "YYYY-MM-DD"], true);
		if (parsed.isValid()) {
			return parsed.format("YYYYMM");
		}
		return moment().format("YYYYMM");
	}

	loadLadderScoreConfig() {
		const configPath = require("path").join(process.cwd(), "plugins", "ladder_score", "ladder_score_config.json");
		try {
			if (!fs.existsSync(configPath)) {
				return { useDynamic: true, minDelta: 8, maxDelta: 15, fixedDelta: 12, K: 20 };
			}
			const source = JSON.parse(fs.readFileSync(configPath, "utf8"));
			return { useDynamic: true, minDelta: 8, maxDelta: 15, fixedDelta: 12, K: 20, ...source };
		} catch (e) {
			return { useDynamic: true, minDelta: 8, maxDelta: 15, fixedDelta: 12, K: 20 };
		}
	}

	private getLadderDeltaForMatch(playerPoints: number, opponentPoints: number, isWin: boolean) {
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

	private normalizeDeckInput(deck: any): { main: number[], side: number[] } {
		if (!deck) {
			return { main: [], side: [] };
		}
		if (Buffer.isBuffer(deck)) {
			try {
				const decoded = YGOProDeck.fromUpdateDeckPayload(deck);
				return { main: decoded.main || [], side: decoded.side || [] };
			} catch (e) {
				return { main: [], side: [] };
			}
		}
		if (typeof deck === "string") {
			try {
				const decoded = YGOProDeck.fromYdkString(deck);
				return { main: decoded.main || [], side: decoded.side || [] };
			} catch (e) {
				return { main: [], side: [] };
			}
		}
		return {
			main: Array.isArray(deck.main) ? deck.main.map((id: any) => Number(id)) : [],
			side: Array.isArray(deck.side) ? deck.side.map((id: any) => Number(id)) : []
		};
	}

	async detectDeckTemplateId(deck: any): Promise<number> {
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
				const templateDeck = YGOProDeck.fromYdkString(fs.readFileSync(path.join(templatesPath, filename), "utf8"));
				const templateCards = (templateDeck.main || []).map((id: number) => Number(id));
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
			} catch (e) {
				continue;
			}
		}
		return bestId;
	}

	async getLadderDeckStats(monthKey?: string) {
		const repo = this.db.getRepository(LadderMatch);
		const targetMonth = this.normalizeMonthKey(monthKey || moment().format("YYYYMM"));
		const matches = await repo.find({ where: { monthKey: targetMonth } as any });
		const matrix: {[key: string]: { total: number, wins: number }} = {};
		for (const match of matches) {
			const keyA = `${match.playerADeckTypeId}::${match.playerBDeckTypeId}`;
			const keyB = `${match.playerBDeckTypeId}::${match.playerADeckTypeId}`;
			if (!matrix[keyA]) { matrix[keyA] = { total: 0, wins: 0 }; }
			if (!matrix[keyB]) { matrix[keyB] = { total: 0, wins: 0 }; }
			matrix[keyA].total += 1;
			if (match.winnerName && match.winnerName === match.playerAName) {
				matrix[keyA].wins += 1;
			}
			matrix[keyB].total += 1;
			if (match.winnerName && match.winnerName === match.playerBName) {
				matrix[keyB].wins += 1;
			}
		}
		return { monthKey: targetMonth, matrix };
	}

	async upsertLadderMonthRecord(name: string, monthKey: string, duelPoints: number, wins: number, losses: number) {
		const repo = this.db.getRepository(LadderMonthRecord);
		const normalizedKey = this.normalizeMonthKey(monthKey);
		const existing = await repo.findOne({ where: { name: name.toLowerCase(), monthKey: normalizedKey } as any });
		if (existing) {
			existing.duelPoints = duelPoints;
			existing.wins = wins;
			existing.losses = losses;
			existing.scoreDiff = wins - losses;
			await repo.save(existing);
			return existing;
		}
		const record = new LadderMonthRecord();
		record.name = name.toLowerCase();
		record.monthKey = normalizedKey;
		record.duelPoints = duelPoints;
		record.wins = wins;
		record.losses = losses;
		record.scoreDiff = wins - losses;
		await repo.save(record);
		return record;
	}

	async recordLadderMatchWithScore({ monthKey, playerA, playerB, winnerName, loserName, duelLogId, g1FirstPlayer, coinWinner }: {
		monthKey: string,
		playerA: { name: string, pass: string | null, deckTypeId: number, duelPointsBefore: number, duelPointsAfter: number, duelPointsDelta: number },
		playerB: { name: string, pass: string | null, deckTypeId: number, duelPointsBefore: number, duelPointsAfter: number, duelPointsDelta: number },
		winnerName?: string | null,
		loserName?: string | null,
		duelLogId?: number | null,
		g1FirstPlayer?: string | null,
		coinWinner?: string | null
	}) {
		const repo = this.db.getRepository(LadderMatch);
		const match = new LadderMatch();
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
		const gameRepo = this.db.getRepository(LadderMatchGame);
		await gameRepo.save([
			{ matchId: match.id, duelLogId: duelLogId || null, playerName: playerA.name.toLowerCase(), opponentName: playerB.name.toLowerCase(), deckTypeId: Number(playerA.deckTypeId) || 4095, winnerName: (winnerName || playerA.name).toLowerCase(), gNumber: 1, isFirst: 0, isMain: 1, isSide: 0, duelCount: 1 },
			{ matchId: match.id, duelLogId: duelLogId || null, playerName: playerB.name.toLowerCase(), opponentName: playerA.name.toLowerCase(), deckTypeId: Number(playerB.deckTypeId) || 4095, winnerName: (winnerName || playerA.name).toLowerCase(), gNumber: 1, isFirst: 0, isMain: 1, isSide: 0, duelCount: 1 }
		] as any);
		return match;
	}

	// 名字规范化:不区分大小写,同一用户
	async getLadderUser(name: string) {
		const repo = this.db.getRepository(LadderUser);
		try {
			return await repo.findOne(name.toLowerCase());
		} catch (e) {
			this.log.warn(`Failed to fetch ladder user ${name}: ${e.toString()}`);
			return null;
		}
	}

	// 返回 'registered'(新注册) 或 'exists'(已存在)
	async registerLadderUser(name: string, pass: string | null): Promise<'registered' | 'exists'> {
		const key = name.toLowerCase();
		const repo = this.db.getRepository(LadderUser);
		try {
			const existing = await repo.findOne(key);
			if (existing) {
				return 'exists';
			}
			const user = new LadderUser();
			user.name = key;
			user.pass = pass || null;
			user.createdAt = new Date();
			await repo.save(user);
			return 'registered';
		} catch (e) {
			this.log.warn(`Failed to register ladder user ${name}: ${e.toString()}`);
			return 'exists';
		}
	}

	// 更新一次天梯战绩。monthKey 形如 "2026-08"
	async updateLadderRecord(name: string, isWin: boolean, monthKey: string) {
		const key = name.toLowerCase();
		const repo = this.db.getRepository(LadderUser);
		try {
			let user = await repo.findOne(key);
			if (!user) {
				return;
			}
			const normalizedKey = this.normalizeMonthKey(monthKey);
			if (this.normalizeMonthKey(user.monthKey) !== normalizedKey) {
				user.monthWins = 0;
				user.monthLosses = 0;
				user.monthKey = normalizedKey;
			}
			if (isWin) {
				user.wins += 1;
				user.monthWins += 1;
			} else {
				user.losses += 1;
				user.monthLosses += 1;
			}
			await repo.save(user);
		} catch (e) {
			this.log.warn(`Failed to update ladder record ${name}: ${e.toString()}`);
		}
	}

	// 结算一次天梯对战:未注册→注册;已注册且密码对→统计;密码不对→不计入
	// 无密码昵称(不带 $)一律不注册、不计入
	// 返回 { counted: boolean, registered: boolean }
	async tallyLadderResult(name: string, pass: string | null, isWin: boolean, monthKey: string) {
		const key = name.toLowerCase();
		if (!pass) {
			return { counted: false, registered: false };
		}
		const repo = this.db.getRepository(LadderUser);
		try {
			let user = await repo.findOne(key);
			if (!user) {
				user = new LadderUser();
				user.name = key;
				user.pass = pass || null;
				user.createdAt = new Date();
				await repo.save(user);
				this.log.info(`Ladder user registered: ${key}`);
				user = (await repo.findOne(key)) as LadderUser;
			} else if (user.pass !== (pass || null)) {
				return { counted: false, registered: true };
			}
			if (!user) {
				return { counted: false, registered: false };
			}
			const normalizedKey = this.normalizeMonthKey(monthKey);
			if (this.normalizeMonthKey(user.monthKey) !== normalizedKey) {
				user.monthWins = 0;
				user.monthLosses = 0;
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
			} else {
				user.losses += 1;
				user.monthLosses += 1;
			}
			await repo.save(user);
			await this.upsertLadderMonthRecord(user.name, normalizedKey, user.monthDuelPoints, user.monthWins, user.monthLosses);
			return { counted: true, registered: true };
		} catch (e) {
			this.log.warn(`Failed to tally ladder result ${name}: ${e.toString()}`);
			return { counted: false, registered: false };
		}
	}

	async applyLadderMatchResult({
		monthKey, playerA, playerB, winnerName, loserName, duelLogId, g1FirstPlayer, coinWinner, deckA, deckB
	}: {
		monthKey: string,
		playerA: { name: string, pass: string | null, deck?: any },
		playerB: { name: string, pass: string | null, deck?: any },
		winnerName?: string | null,
		loserName?: string | null,
		duelLogId?: number | null,
		g1FirstPlayer?: string | null,
		coinWinner?: string | null,
		deckA?: any,
		deckB?: any
	}) {
		const userRepo = this.db.getRepository(LadderUser);
		const monthKeyValue = this.normalizeMonthKey(monthKey);
		const [aUser, bUser] = await Promise.all([
			userRepo.findOne(playerA.name.toLowerCase()),
			userRepo.findOne(playerB.name.toLowerCase())
		]);
		const userA = aUser || new LadderUser();
		if (!aUser) {
			userA.name = playerA.name.toLowerCase();
			userA.pass = playerA.pass || null;
			userA.createdAt = new Date();
		}
		if (userA.pass !== (playerA.pass || null) && aUser) {
			return { counted: false, registered: true };
		}
		const userB = bUser || new LadderUser();
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
		if (!aUser) await userRepo.save(userA);
		if (!bUser) await userRepo.save(userB);
		const aFinal = Math.max(0, aBefore + (winnerName ? aDelta : 0));
		const bFinal = Math.max(0, bBefore + (winnerName ? bDelta : 0));
		userA.duelPoints = aFinal;
		userB.duelPoints = bFinal;
		userA.monthDuelPoints = (userA.monthDuelPoints ?? 1000) + (winnerName ? aDelta : 0);
		userB.monthDuelPoints = (userB.monthDuelPoints ?? 1000) + (winnerName ? bDelta : 0);
		const aWin = winnerName ? winnerName.toLowerCase() === userA.name : false;
		const bWin = winnerName ? winnerName.toLowerCase() === userB.name : false;
		if (this.normalizeMonthKey(userA.monthKey) !== monthKeyValue) {
			userA.monthWins = 0; userA.monthLosses = 0; userA.monthKey = monthKeyValue;
		}
		if (this.normalizeMonthKey(userB.monthKey) !== monthKeyValue) {
			userB.monthWins = 0; userB.monthLosses = 0; userB.monthKey = monthKeyValue;
		}
		userA.wins += aWin ? 1 : 0; userA.losses += aWin ? 0 : 1;
		userB.wins += bWin ? 1 : 0; userB.losses += bWin ? 0 : 1;
		userA.monthWins += aWin ? 1 : 0; userA.monthLosses += aWin ? 0 : 1;
		userB.monthWins += bWin ? 1 : 0; userB.monthLosses += bWin ? 0 : 1;
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
	async getLadderTop(type: string, search = '', page = 1, pagesize = 50, monthKey?: string) {
		try {
			const repo = this.db.getRepository(LadderUser);
			const isMonth = type === 'month';
			const allUsers = await repo.find();
			const targetMonth = this.normalizeMonthKey(monthKey || (isMonth ? moment().format('YYYYMM') : null));
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
				if (bPoints !== aPoints) {
					return bPoints - aPoints;
				}
				const aWins = isMonth ? a.monthWins : a.wins;
				const bWins = isMonth ? b.monthWins : b.wins;
				if (bWins !== aWins) {
					return bWins - aWins;
				}
				return ((isMonth ? b.monthWins - b.monthLosses : b.wins - b.losses) - (isMonth ? a.monthWins - a.monthLosses : a.wins - a.losses));
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
			return { users, total };
		} catch (e) {
			this.log.warn(`Failed to fetch ladder top: ${e.toString()}`);
			return { users: [], total: 0 };
		}
	}
}
