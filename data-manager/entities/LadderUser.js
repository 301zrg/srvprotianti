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
exports.LadderUser = void 0;
const typeorm_1 = require("typeorm");
let LadderUser = class LadderUser {
    constructor() {
        this.wins = 0;
        this.losses = 0;
        this.monthWins = 0;
        this.monthLosses = 0;
    }
};
exports.LadderUser = LadderUser;
__decorate([
    (0, typeorm_1.PrimaryColumn)({ type: "varchar", length: 64 }),
    __metadata("design:type", String)
], LadderUser.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 128, nullable: true }),
    __metadata("design:type", String)
], LadderUser.prototype, "pass", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: global.DbDateType || 'datetime', nullable: true }),
    __metadata("design:type", Date)
], LadderUser.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "int", default: 0 }),
    __metadata("design:type", Number)
], LadderUser.prototype, "wins", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "int", default: 0 }),
    __metadata("design:type", Number)
], LadderUser.prototype, "losses", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "int", default: 0 }),
    __metadata("design:type", Number)
], LadderUser.prototype, "monthWins", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "int", default: 0 }),
    __metadata("design:type", Number)
], LadderUser.prototype, "monthLosses", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 8, nullable: true }),
    __metadata("design:type", String)
], LadderUser.prototype, "monthKey", void 0);
exports.LadderUser = LadderUser = __decorate([
    (0, typeorm_1.Entity)("ladder_user")
], LadderUser);