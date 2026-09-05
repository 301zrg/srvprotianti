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
exports.LadderMatchGame = void 0;
const typeorm_1 = require("typeorm");
const LadderMatch_1 = require("./LadderMatch");
let LadderMatchGame = class LadderMatchGame {
    constructor() {
        this.deckTypeId = 4095;
        this.gNumber = 1;
        this.isFirst = 0;
        this.isMain = 1;
        this.isSide = 0;
        this.duelCount = 1;
    }
};
exports.LadderMatchGame = LadderMatchGame;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)({ unsigned: true, type: global.PrimaryKeyType || 'bigint' }),
    __metadata("design:type", Number)
], LadderMatchGame.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("int", { nullable: true }),
    __metadata("design:type", Number)
], LadderMatchGame.prototype, "matchId", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("int", { nullable: true }),
    __metadata("design:type", Number)
], LadderMatchGame.prototype, "duelLogId", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ type: "varchar", length: 64 }),
    __metadata("design:type", String)
], LadderMatchGame.prototype, "playerName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 64, nullable: true }),
    __metadata("design:type", String)
], LadderMatchGame.prototype, "opponentName", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 4095 }),
    __metadata("design:type", Number)
], LadderMatchGame.prototype, "deckTypeId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 64, nullable: true }),
    __metadata("design:type", String)
], LadderMatchGame.prototype, "winnerName", void 0);
__decorate([
    (0, typeorm_1.Column)("smallint", { default: 1 }),
    __metadata("design:type", Number)
], LadderMatchGame.prototype, "gNumber", void 0);
__decorate([
    (0, typeorm_1.Column)("smallint", { default: 0 }),
    __metadata("design:type", Number)
], LadderMatchGame.prototype, "isFirst", void 0);
__decorate([
    (0, typeorm_1.Column)("smallint", { default: 1 }),
    __metadata("design:type", Number)
], LadderMatchGame.prototype, "isMain", void 0);
__decorate([
    (0, typeorm_1.Column)("smallint", { default: 0 }),
    __metadata("design:type", Number)
], LadderMatchGame.prototype, "isSide", void 0);
__decorate([
    (0, typeorm_1.Column)("smallint", { default: 1 }),
    __metadata("design:type", Number)
], LadderMatchGame.prototype, "duelCount", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => LadderMatch_1.LadderMatch, (match) => match.games, { nullable: true, onDelete: "CASCADE" }),
    __metadata("design:type", LadderMatch_1.LadderMatch)
], LadderMatchGame.prototype, "match", void 0);
exports.LadderMatchGame = LadderMatchGame = __decorate([
    (0, typeorm_1.Entity)("ladder_match_game")
], LadderMatchGame);
