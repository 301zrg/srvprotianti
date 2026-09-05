import {Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn} from "typeorm";
import {LadderMatch} from "./LadderMatch";

@Entity("ladder_match_game")
export class LadderMatchGame {
	@PrimaryGeneratedColumn({ unsigned: true, type: (global as any).PrimaryKeyType as ('bigint' | 'integer') || 'bigint' })
	id: number;

	@Index()
	@Column("int", { nullable: true })
	matchId: number;

	@Index()
	@Column("int", { nullable: true })
	duelLogId: number;

	@Index()
	@Column({ type: "varchar", length: 64 })
	playerName: string;

	@Column({ type: "varchar", length: 64, nullable: true })
	opponentName: string;

	@Column("int", { default: 4095 })
	deckTypeId: number = 4095;

	@Column({ type: "varchar", length: 64, nullable: true })
	winnerName: string;

	@Column("smallint", { default: 1 })
	gNumber: number = 1;

	@Column("smallint", { default: 0 })
	isFirst: number = 0;

	@Column("smallint", { default: 1 })
	isMain: number = 1;

	@Column("smallint", { default: 0 })
	isSide: number = 0;

	@Column("smallint", { default: 1 })
	duelCount: number = 1;

	@ManyToOne(() => LadderMatch, (match) => match.games, { nullable: true, onDelete: "CASCADE" })
	match: LadderMatch;
}
