markdown
# 游戏王天梯卡组JSON配置说明

## 一、位段编码设计

### 位段分配（12位整数）
位段布局: [强度梯度 3位] [卡组大类 6位] [分支 3位]
位段位置: bits 11-9 bits 8-3 bits 2-0

text

### 编码/解码函数
```javascript
// 编码：(tier << 9) | (familyId << 3) | branchId
const encode = (tier, familyId, branchId) => (tier << 9) | (familyId << 3) | branchId;

// 解码
const decode = (id) => ({
  tier: (id >> 9) & 0x7,      // 0-7
  familyId: (id >> 3) & 0x3F, // 0-63
  branchId: id & 0x7          // 0-7
});
容量说明
强度梯度：8个级别（t0-t7）

卡组大类：64个家族

分支：每个家族8个子类

二、JSON结构
json
{
  "version": "1.0.0",
  "lastUpdated": "2026-09-05",
  
  "families": {
    "HERO": { 
      "id": 4, 
      "name": { "zh": "英雄", "en": "HERO", "ja": "ヒーロー", "ko": "히어로" } 
    }
    // ... 其他家族
  },

  "archetypes": {
    "578": { 
      "code": "HERO_BUBBLE", 
      "name": { "zh": "水泡英雄", "en": "Bubbleman Hero", "ja": "バブルマンヒーロー", "ko": "버블맨 히어로" }, 
      "tier": 1 
    }
    // ... 其他卡组
  },

  "display": {
    "groups": [
      {
        "id": "hero_group",
        "name": { "zh": "英雄", "en": "HERO", "ja": "ヒーロー", "ko": "히어로" },
        "type": "family",        // family | custom | single
        "familyId": 4,           // type为family或custom时必填
        "includeBranches": [0, 1, 2, 3], // 包含的分支ID列表
        "archetypeId": 514,      // type为single时必填
        "displayOrder": 1,
        "isDisplayed": true
      }
    ],
    "defaultGroup": {
      "type": "family",
      "isDisplayed": false
    }
  }
}
三、展示类型说明
类型	说明	必填字段
family	合并整个家族的所有分支	familyId, includeBranches
custom	只合并指定的分支	familyId, includeBranches
single	单独展示一个卡组	archetypeId
四、当前配置数据
家族列表（23个）
ID	Code	中文名
1	BEAT	beat
2	AGENT	代行
3	SIX_SAMURAI	六武众
4	HERO	英雄
5	SYNCHRO	同调均
6	GEAR	齿轮
7	KARAKURI	机巧
8	DARK_WORLD	暗黑界
9	DRAGUNITY	龙骑兵团
10	BLACK_FEATHER	黑羽
11	FROG_EMPEROR	蛙帝
12	INFERNITY	永火
13	NECROVALLEY	守墓
14	LAVA	熔岩
15	GLADIATOR_BEAST	剑斗兽
16	WORM	异虫
17	ZOMBIE	不死族
18	TG_PURE	科技属
19	SCRAP	废铁
20	LIGHT_ROAD	光道
21	NORDIC	极星
22	PSYCHIC	念动力
23	OTHERS	其他
卡组列表（33个）
ID	Code	中文名	Tier	家族
578	HERO_BUBBLE	水泡英雄	1	HERO
579	HERO_COME	到来英雄	2	HERO
580	HERO_THUNDER	雷王英雄	2	HERO
581	HERO_RED	红甲英雄	2	HERO
258	AGENT	代行	1	AGENT
259	AGENT_TG	tg代行	2	AGENT
260	AGENT_HERALD	神光代行	2	AGENT
514	RABBIT_BEAT	兔beat	1	BEAT
770	SIX_SAMURAI	荒行六武	1	SIX_SAMURAI
771	SIX_SAMURAI_NON	非荒六武	2	SIX_SAMURAI
1026	JUNK_DOZER_PLANT	星骸植物	1	SYNCHRO
1027	SYNCHRO_SPEED	速攻废二	2	SYNCHRO
1282	GEAR_TG	tg齿轮	1	GEAR
1283	GEAR_MACHINE	机甲齿轮	2	GEAR
1538	KARAKURI	机巧	1	KARAKURI
1794	DARK_WORLD_FILTER	滤抽暗黑界	1	DARK_WORLD
1795	DARK_WORLD_TRAP	红坑暗黑界	2	DARK_WORLD
2050	DRAGUNITY	龙骑兵团	2	DRAGUNITY
2306	BLACK_FEATHER_TYPHOON	旋风bf	2	BLACK_FEATHER
2307	BLACK_FEATHER_GRAVE	墓地bf	2	BLACK_FEATHER
2562	FROG_EMPEROR	蛙帝	2	FROG_EMPEROR
2818	INFERNITY	永火	2	INFERNITY
3074	NECROVALLEY	守墓	2	NECROVALLEY
3330	LAVA	熔岩	2	LAVA
3586	GLADIATOR_BEAST	剑斗	3	GLADIATOR_BEAST
3842	WORM	异虫	3	WORM
4098	ZOMBIE	不死	3	ZOMBIE
4354	TG_PURE	纯tg	3	TG_PURE
4610	SCRAP	废铁	3	SCRAP
4866	LIGHT_ROAD	光道	3	LIGHT_ROAD
5122	NORDIC	极星	3	NORDIC
5378	PSYCHIC	念动力	3	PSYCHIC
4095	OTHERS	其他	4	OTHERS
前端展示配置（当前显示8组）
序号	组名	类型	包含内容
1	英雄	family	所有英雄分支（4个）
2	代行	custom	代行 + 神光代行（不含tg代行）
3	齿轮	family	所有齿轮分支（2个）
4	同调均	family	所有同调分支（2个）
5	暗黑界	family	所有暗黑界分支（2个）
6	六武众	family	所有六武分支（2个）
7	beat	single	兔beat
8	机巧	single	机巧