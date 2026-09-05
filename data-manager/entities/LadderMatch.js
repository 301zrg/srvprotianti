"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LadderMatch = void 0;
const typeorm_1 = require("typeorm");
const LadderMatchGame_1 = require("./LadderMatchGame");
let LadderMatch = class LadderMatch {
    constructor() {
        this.playerADeckTypeId = 4095;
        this.playerBDeckTypeId = 4095;
        this.playerADuelPointsDelta = 0;
        this.playerBDuelPointsDelta = 0;
        this.playerADuelPointsBefore = 1000;
        this.playerBDuelPointsBefore = 1000;
        this.playerADuelPointsAfter = 1000;
        this.playerBDuelPointsAfter = 1000;
    }
};
exports.LadderMatch = LadderMatch;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)({ unsigned: true, type: (global.PrimaryKeyType) || 'bigint' }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 8, nullable: true }),
    __metadata("design:type", String)
], LadderMatch.prototype, "monthKey", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 64, nullable: true }),
    __metadata("design:type", String)
], LadderMatch.prototype, "winnerName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 64, nullable: true }),
    __metadata("design:type", String)
], LadderMatch.prototype, "loserName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 64, nullable: true }),
    __metadata("design:type", String)
], LadderMatch.prototype, "playerAName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 64, nullable: true }),
    __metadata("design:type", String)
], LadderMatch.prototype, "playerBName", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 4095 }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "playerADeckTypeId", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 4095 }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "playerBDeckTypeId", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 0 }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "playerADuelPointsDelta", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 0 }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "playerBDuelPointsDelta", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 1000 }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "playerADuelPointsBefore", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 1000 }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "playerBDuelPointsBefore", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 1000 }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "playerADuelPointsAfter", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 1000 }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "playerBDuelPointsAfter", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 64, nullable: true }),
    __metadata("design:type", String)
], LadderMatch.prototype, "g1FirstPlayer", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 64, nullable: true }),
    __metadata("design:type", String)
], LadderMatch.prototype, "coinWinner", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { nullable: true }),
    __metadata("design:type", Number)
], LadderMatch.prototype, "duelLogId", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => LadderMatchGame_1.LadderMatchGame, (game) => game.match),
    __metadata("design:type", Array)
], LadderMatch.prototype, "games", void 0);
exports.LadderMatch = LadderMatch = __decorate([
    (0, typeorm_1.Entity)("ladder_match")
], LadderMatch);
