import {Column, Entity, OneToMany, PrimaryGeneratedColumn} from "typeorm";
import {LadderMatchGame} from "./LadderMatchGame";

@Entity("ladder_match")
export class LadderMatch {
	@PrimaryGeneratedColumn({ unsigned: true, type: (global as any).PrimaryKeyType as ('bigint' | 'integer') || 'bigint' })
	id: number;

	@Column({ type: "varchar", length: 8, nullable: true })
	monthKey: string;

	@Column({ type: "varchar", length: 64, nullable: true })
	winnerName: string;

	@Column({ type: "varchar", length: 64, nullable: true })
	loserName: string;

	@Column({ type: "varchar", length: 64, nullable: true })
	playerAName: string;

	@Column({ type: "varchar", length: 64, nullable: true })
	playerBName: string;

	@Column("int", { default: 4095 })
	playerADeckTypeId: number = 4095;

	@Column("int", { default: 4095 })
	playerBDeckTypeId: number = 4095;

	@Column("int", { default: 0 })
	playerADuelPointsDelta: number = 0;

	@Column("int", { default: 0 })
	playerBDuelPointsDelta: number = 0;

	@Column("int", { default: 1000 })
	playerADuelPointsBefore: number = 1000;

	@Column("int", { default: 1000 })
	playerBDuelPointsBefore: number = 1000;

	@Column("int", { default: 1000 })
	playerADuelPointsAfter: number = 1000;

	@Column("int", { default: 1000 })
	playerBDuelPointsAfter: number = 1000;

	@Column({ type: "varchar", length: 64, nullable: true })
	g1FirstPlayer: string;

	@Column({ type: "varchar", length: 64, nullable: true })
	coinWinner: string;

	@Column("int", { nullable: true })
	duelLogId: number;

	@OneToMany(() => LadderMatchGame, (game) => game.match)
	games: LadderMatchGame[];
}
