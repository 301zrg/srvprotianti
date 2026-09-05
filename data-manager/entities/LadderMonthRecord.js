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
exports.LadderMonthRecord = void 0;
const typeorm_1 = require("typeorm");
let LadderMonthRecord = class LadderMonthRecord {
    constructor() {
        this.duelPoints = 1000;
        this.wins = 0;
        this.losses = 0;
        this.scoreDiff = 0;
    }
};
exports.LadderMonthRecord = LadderMonthRecord;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)({ unsigned: true, type: global.PrimaryKeyType || 'bigint' }),
    __metadata("design:type", Number)
], LadderMonthRecord.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ type: "varchar", length: 64 }),
    __metadata("design:type", String)
], LadderMonthRecord.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ type: "varchar", length: 8 }),
    __metadata("design:type", String)
], LadderMonthRecord.prototype, "monthKey", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 1000 }),
    __metadata("design:type", Number)
], LadderMonthRecord.prototype, "duelPoints", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 0 }),
    __metadata("design:type", Number)
], LadderMonthRecord.prototype, "wins", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 0 }),
    __metadata("design:type", Number)
], LadderMonthRecord.prototype, "losses", void 0);
__decorate([
    (0, typeorm_1.Column)("int", { default: 0 }),
    __metadata("design:type", Number)
], LadderMonthRecord.prototype, "scoreDiff", void 0);
exports.LadderMonthRecord = LadderMonthRecord = __decorate([
    (0, typeorm_1.Entity)("ladder_month_record")
], LadderMonthRecord);
