import {Column, Entity, Index, PrimaryGeneratedColumn} from "typeorm";

@Entity("ladder_month_record")
export class LadderMonthRecord {
	@PrimaryGeneratedColumn({ unsigned: true, type: (global as any).PrimaryKeyType as ('bigint' | 'integer') || 'bigint' })
	id: number;

	@Index()
	@Column({ type: "varchar", length: 64 })
	name: string;

	@Index()
	@Column({ type: "varchar", length: 8 })
	monthKey: string;

	@Column("int", { default: 1000 })
	duelPoints: number = 1000;

	@Column("int", { default: 0 })
	wins: number = 0;

	@Column("int", { default: 0 })
	losses: number = 0;

	@Column("int", { default: 0 })
	scoreDiff: number = 0;
}
