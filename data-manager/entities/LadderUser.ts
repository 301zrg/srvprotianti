import {Column, Entity, PrimaryColumn} from "typeorm";

@Entity("ladder_user")
export class LadderUser {
	@PrimaryColumn({ type: "varchar", length: 64 })
	name: string;

	@Column({ type: "varchar", length: 128, nullable: true })
	pass: string;

	@Column({ type: (global as any).DbDateType || 'datetime', nullable: true })
	createdAt: Date;

	@Column({ type: "int", default: 0 })
	wins: number = 0;

	@Column({ type: "int", default: 0 })
	losses: number = 0;

	@Column({ type: "int", default: 0 })
	monthWins: number = 0;

	@Column({ type: "int", default: 0 })
	monthLosses: number = 0;

	@Column({ type: "varchar", length: 8, nullable: true })
	monthKey: string;
}