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
			if (user.monthKey !== monthKey) {
				user.monthWins = 0;
				user.monthLosses = 0;
				user.monthKey = monthKey;
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
			// 天梯必须使用"名字$密码"格式,无密码不参与
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
				// 名字已被注册且密码不符 → 本场不计入
				return { counted: false, registered: true };
			}
			if (!user) {
				return { counted: false, registered: false };
			}
			if (user.monthKey !== monthKey) {
				user.monthWins = 0;
				user.monthLosses = 0;
				user.monthKey = monthKey;
			}
			if (isWin) {
				user.wins += 1;
				user.monthWins += 1;
			} else {
				user.losses += 1;
				user.monthLosses += 1;
			}
			await repo.save(user);
			return { counted: true, registered: true };
		} catch (e) {
			this.log.warn(`Failed to tally ladder result ${name}: ${e.toString()}`);
			return { counted: false, registered: false };
		}
	}

	// 天梯前 N,type: 'total' | 'month'
	async getLadderTop(type: string, limit = 50) {
		try {
			const repo = this.db.getRepository(LadderUser);
			const qb = repo.createQueryBuilder("ladder");
			if (type === 'month') {
				qb.addSelect("(ladder.monthWins - ladder.monthLosses)", "diff")
					.orderBy("diff", "DESC")
					.addOrderBy("ladder.monthWins", "DESC");
			} else {
				qb.addSelect("(ladder.wins - ladder.losses)", "diff")
					.orderBy("diff", "DESC")
					.addOrderBy("ladder.wins", "DESC");
			}
			const users = await qb.limit(limit).getMany();
			return users.map(u => ({
				name: u.name,
				wins: type === 'month' ? u.monthWins : u.wins,
				losses: type === 'month' ? u.monthLosses : u.losses,
				diff: type === 'month' ? u.monthWins - u.monthLosses : u.wins - u.losses
			}));
		} catch (e) {
			this.log.warn(`Failed to fetch ladder top: ${e.toString()}`);
			return [];
		}
	}
}
