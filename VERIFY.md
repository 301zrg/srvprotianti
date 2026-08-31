# SRVPro 定制改造 · 装回服务器验证清单

> 改造内容:Postgres 数据层 + 实时房间网页 + 天梯录像网页 + TT 天梯模式 + 爆满 98%
> 备份:项目根目录 backup-20260829-011451/(改前原版)

## 第 0 步:服务器 PostgreSQL 准备(一次性)

```sql
-- 用超级用户执行
CREATE USER srvpro WITH PASSWORD '你的强密码';
CREATE DATABASE srvpro OWNER srvpro;
```

## 第 1 步:填写 config/config.json 数据库凭据

文件里 `modules.mysql` 段(注意:开关名沿用 mysql,但 `db.type` 已是 postgres):

```json
"mysql": {
  "enabled": true,
  "db": {
    "type": "postgres",
    "host": "127.0.0.1",
    "port": 5432,
    "username": "srvpro",
    "password": "换成你设的密码",
    "database": "srvpro"
  }
}
```

- 如果 postgres 不在本机,`host` 改成实际地址;
- 如果 postgres 监听非默认端口,改 `port`;
- 弱口令会被 postgres 拒绝,注意 `pg_hba.conf` 的认证方式。

## 第 2 步:启动服务器

```bash
node ygopro-server.js
```

首次启动 TypeORM `synchronize: true` 会自动建表(全部实体:ban、cloud_replay、duel_log、ladder_user 等)。
**启动成功的标志**:日志无 `Failed to connect to database` / `ECONNREFUSED` 之类错误,且:

```bash
psql -U srvpro -d srvpro -c '\dt'
```
能看到所有表,其中包含 `ladder_user`。

## 第 3 步:功能验证清单

| # | 验证项 | 操作 | 期望 |
|---|---|---|---|
| 1 | 实时房间网页 | 浏览器打开 `http://服务器IP:7922/` | 显示房间列表页(免登录) |
| 2 | 房间 API | `http://服务器IP:7922/api/getrooms` | JSON 房间列表,房名不含 `$密码` |
| 3 | TT 天梯模式 | 游戏客户端进房名输入 `TT` | 进入"天梯模式"随机房,欢迎语提示计入天梯;观战页显示"天梯随机(比赛)" |
| 4 | 注册+记战绩 | 用 `名字$密码` 完成一场 TT 决斗 | 数据库 `ladder_user` 出现该名字;胜/负 +1 |
| 5 | 入口拦截:无密码 | 客户端昵称不带 `$`,进房名输 `TT` | 弹窗"天梯模式必须使用 昵称$密码 格式"并断开 |
| 5b | 入口拦截:密码错 | 用 `已注册名$错误密码` 进房名输 `TT` | 弹窗"用户名或密码错误"并断开,不进匹配 |
| 5c | 直连天梯房(等待中) | 房间创建后,另一个客户端输房名 `M#TT,RANDOM#xxx` 直接加入 | 弹窗"该房间是天梯对局,无法直接加入;对局开始后可输入房名观战" |
| 5d | 直连天梯房(对局中) | 对局开始后,输房名直连 | 进入观战席,不能对战 |
| 5e | 首次参与提示 | 新名字带密码打钩 | 蓝字"首次参与天梯:本场对决结束将注册您的账号…" |
| 6 | 天梯网页 | `http://服务器IP:7922/ladder.html` | 总战绩/当月战绩切换,前 50,按胜负差排序,无密码 |
| 7 | 录像落盘 | 完成一场 TT 决斗后 | `./replays/` 出现 `YYYY-MM-DD HH-mm-ss.SSS 玩家1 VS 玩家2.yrp` |
| 8 | 录像列表/下载 | `http://服务器IP:7922/replays.html` | 列表显示时间/双方/大小,能下载 |
| 9 | 约战不入天梯 | 普通房名约战一场 | `ladder_user` 无变化,`./replays/` 无新文件 |
| 10 | 爆满阈值 | 查看整机内存使用率 | 约战房 98%、随机房 98%(已统一)才报"服务器已爆满" |

## 第 4 步:回滚

出问题时,把 `backup-20260829-011451/` 里的原版文件复制回原位即可(重点:ygopro-server.js、data-manager/、config/config.json),然后重启。

## 注意事项

1. **duel log**:开启数据库后,只有天梯(TT)对局的录像会写盘入库;普通约战不写;
2. **磁盘**:一场天梯录像约 100-500KB,请定期清理 `./replays/`;
3. **内存**:postgres 本身约占 100-200MB,4G 机器上服务器预算 ≈ Node 50MB + postgres + 每房 12MB;
4. **名字大小写不敏感**:`Haha` 与 `haha` 视为同一用户(首个出现的大小写即注册名);
5. **无密码玩家**使用已注册名字 = 密码错误,提示且不计入天梯;
6. **本地测试脚本** `temp/ladder-test.js` 可用来在没有 postgres 的环境回归天梯逻辑(node temp/ladder-test.js,用内存库)。