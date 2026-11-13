# 日常维护、升级和故障回退

运行目录、代码 release 和私有数据分开维护。每次发布有自己的清单和备份批次，
不把“git pull 成功”或“端口起来”当成业务已验收。

## 维护管理账号和操作

首次新装没有可用的默认管理员；公共默认 root 账号已禁用。
在首次启动前创建只有 stop 权限的独立 maintenance 账号，密码私下输入。
以下只用于全新配置目录，文件已存在就失败；迁机保留原 admin_user.json：

```bash
sudo python3 - <<'PY'
import getpass, json, os, pwd
password = getpass.getpass('设置 maintenance 管理密码：')
if not password or password != getpass.getpass('再次输入：'):
    raise SystemExit('密码为空或不一致，未写入')
if any(c in password for c in '\r\n\x00'):
    raise SystemExit('密码不得包含控制字符')
target = '/srv/srvprotianti/shared/config/admin_user.json'
payload = {'file': './config/admin_user.json', 'permission_examples': {},
           'users': {'maintenance': {'password': password, 'enabled': True,
                                     'permissions': {'stop': True}}}}
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
    json.dump(payload, stream, ensure_ascii=False, indent=2)
    stream.write('\n')
account = pwd.getpwnam('srvpro')
os.chown(target, account.pw_uid, account.pw_gid)
PY
```

其他管理权限按实际需要另设账号，避免给仅负责备份的人启用全部权限。
runtime 数据库角色、运维数据库角色与这个 HTTP 管理账号是三套不同身份。

### 维护开关操作

服务运行时可在服务器本机执行以下代码进入维护；它复用既有 `/api/message` 的 stop 行为。
既有接口用查询参数认证，因此只访问 loopback，不经过公网或带访问日志的代理；
密码由提示读取，不写入 shell 历史或终端输出。恢复原账号时修改 username。
取消维护时把 stop_value 改为字符串 `'false'`，不能填 `'0'`：

将下一段保存为 UTF-8 Python 文件：Windows 用记事本保存到
`C:\srvpro-private\maintenance.py`（保存类型选“所有文件”，避免变成 `.py.txt`）；
Linux 保存到 `/etc/srvprotianti/maintenance.py`，权限 0600。
代码不保存密码，运行时提示输入；只在目标服务器本机执行，不把 base 改成公网地址。

```python
import base64, getpass, json, urllib.parse, urllib.request
username = 'maintenance'
stop_value = '服务器维护中，请稍后重试。'
password = getpass.getpass('HTTP 管理密码：')
base = 'http://127.0.0.1:7922'
query = urllib.parse.urlencode({'username': username, 'pass': password, 'stop': stop_value})
try:
    with urllib.request.urlopen(base + '/api/message?' + query, timeout=15) as response:
        result = response.read().decode('utf-8')
    if not result.startswith("['stop ok',"):
        raise ValueError('管理操作未成功')
    token = base64.b64encode((username + ':' + password).encode('utf-8')).decode('ascii')
    request = urllib.request.Request(base + '/api/maintenance/status',
                                    headers={'Authorization': 'Basic ' + token})
    with urllib.request.urlopen(request, timeout=15) as response:
        status = json.load(response)
    if status.get('maintenanceEnabled') != (stop_value != 'false'):
        raise ValueError('维护状态未达到预期')
except Exception:
    raise SystemExit('操作失败，请检查管理权限、端口和服务日志；不要忽略 HTTP200 内的失败状态')
print(json.dumps(status, ensure_ascii=False, indent=2))
```

Windows PowerShell 执行：

```powershell
python C:\srvpro-private\maintenance.py
if ($LASTEXITCODE -ne 0) { throw 'Maintenance operation failed' }
```

Linux 执行：

```bash
sudo python3 /etc/srvprotianti/maintenance.py
```

只读查询也可按备份指南使用私有 curl 配置。在本机创建 root 0600 的
`/etc/srvprotianti/maintenance-curl.conf`，内容格式为 `user = "maintenance:私下填写的密码"`。
引号或反斜杠按 curl 配置格式转义；不要把真实文件提交仓库。
进入维护后等待 readyToStop=true，再按联合备份指南停服务；取消维护时先启动仍保持 stop 的服务，
核对运行正常后再开放新入房及启动其他 writer。

## 日常检查

```bash
sudo systemctl status srvprotianti.service --no-pager
sudo journalctl -u srvprotianti.service -n 100 --no-pager
df -h /srv/srvprotianti /private-backups
```

数据库连接、必要插件初始化、四语卡库、结算和录像保存错误要同时关注。
可选插件失败不会阻断无依赖宿主，因此 systemd active 不证明完整天梯可用。
公开房间、排行榜、连胜、使用率和录像 API要检查返回形状/数据，不能只看 HTTP200。
错误日志属于私有运维资料，发送问题报告前脱敏密码、Token、玩家IP/卡组/录像。

记录备份最近成功批次及异机校验/恢复时间。设告警接收人；磁盘不足、数据库权限不足、
中文卡库缺失、机器人重复实例分别处理，不能用重启掩盖长期漏记录。
日志用 journal保留策略/现有日志轮换管理，避免无限增长占满录像磁盘。

## 普通代码升级

1. 保留本次稳定 release 的 archive、manifest和当前配置；用审核过的新工作树制作新 release。
2. 在新 release目录重新 npm ci、build、test、schema check-contract。
3. 同一套数据库和资源在隔离环境验收；若有schema变更，先读对应迁移，不打开 synchronize。
4. 进入维护，自然排空，停全部writer并生成联合备份；核对批次verify。
5. 将 shared/config、数据和插件私有文件按映射接到新release。确保它们不被默认样例覆盖。
6. 将 current 链接切至新application，启动服务，检查日志/公开API/真实对局。
7. 验收后取消维护、恢复机器人；保存发布版本和验证报告。

只在 current 确认是指向本项目 release 的符号链接时更新它；不递归搬移/删除未知真实目录。
在root shell使用自己已核实的绝对路径执行链接切换，失败时保留旧链接指向信息。
如果部署用手工scp文件覆盖，必须先备份本批明确文件并重启；Coffee源与生成JS配套，
下一次build否则会回退修改。整套release更适合新人接手。

## 数据库升级

实体/迁移/授权/验证需要配套发布。已有库先只读verify和差异审查，
历史迁移中带修复/回填/清零的SQL不是可反复执行的初始化流程。
源/目标17换机与数据库大版本升级分开。升级大版本或locale需要独立测试完整dump恢复、
排序/唯一键、索引和应用查询，不能在故障恢复时顺便改变这些输入。

## 维护窗口与停机

按 [联合备份](backup-restore.md#1-进入维护并等自然结束) 操作：
stop=true 拒新入房 → maintenance/status有stop权限地读取 → rooms和pendingWork归零 →停全部writer。
维护接口不帮你自动踢玩家、不自动发送SIGTERM，也不承诺回调失败的录像会出现。
失败录像保持原有保存语义并留下告警，游戏结果不会因为录像失败被取消。

`pendingCount` 不清零时查卡住的协议处理、DB连接和文件写入。
若必须在故障状态中断，应明确记录受影响房间/未完成任务，恢复后按事实核对；
不能将强制结束标成正常完整Match。
systemd停止应清整个cgroup，避免留下YGOPro子进程或重复宿主。

## 回退的两个边界

**新代码尚未在正式库写入，也没有执行不兼容DDL：** 可停新服务、把current切回旧release，
还原本批配置/资源，启动旧服务，保持单写端，再做业务验收。

**新机/新代码已经接受正式写入，或已执行不兼容DDL：** 旧机旧库不是安全的即时回退目标。
先停所有写入并保存新批次，选择保留当前数据的修复，或明确选择备份时点恢复及其数据损失范围。
回退代码能否读取新schema需要单独验证；数据库恢复到新空库，再切运行连接，不能盲目覆盖旧库。
不要让两台服务器同时计算积分，事后无法靠文件合并自动得到可靠Match历史。

## 常见故障

| 症状 | 处理顺序 |
| --- | --- |
| 开房失败 | 工作目录、ygopro/ygopro执行位、file/ldd、端口stdout与stderr、资源/协议版本 |
| Node active但TT不可用 | PostgreSQL连接、插件failed日志、schema/role验证、账号测试 |
| 使用率新增缺数据 | 中文catalog metadataAvailable、完整四語CDB、投影告警，再按模块回填契约处理 |
| WSS101失败 | DNS/TLS、Origin、Nginx upgrade/内部端口、云/主机防火墙 |
| 玩家IP都变本机/代理 | 两Neos字段、trusted_proxies、Nginx覆盖XFF、上游CDN信任边界 |
| DB恢复失败 | archive/client/target版本、emptyguard、owner role、扩展、pg_restore退出码和报告 |
| 历史录像缺失 | 对照基线三分类、实际路径/权限/大小写、SHA；不猜造关联 |
| 网页迁址后交接失效 | dist/duel-config.js白名单、官网target origin、完整新构建是否被发布 |
| 机器人重复消息 | 旧/新实例是否同时运行，config路径及schedule/win-streak state是否保留 |

## 接手清单

### 上线后的交接与每日检查

新机能开一局只是安装检查的一部分。下面各项写明执行者、启用方式、检查命令/页面和最近成功时间；
没有设置的项目标待办，不能在验收中自动打勾。具体地址、账号和报警接收人保存在私有参数页。

| 项目 | 本轮验收要求 |
| --- | --- |
| 网络与证书 | TCP 游戏端口和 443 同时检查主机防火墙/云安全组，DB/原始 HTTP/WSS 后端端口不公开；证书续期工具有定时任务，并完成测试续期/自动 reload；检查到期告警 |
| 时间同步 | Linux `timedatectl status`、Windows `w32tm /query /status` 确认同步来源和状态；Bot 的业务时区按自身配置，不能靠改系统时区修补任务 |
| SSH | Linux 使用独立 sudo 用户和密钥；第二个会话确认密钥登录正常后才关闭 root/密码登录，`sudo sshd -t` 后 reload；保留现有会话直到复测通过 |
| 日志与磁盘 | 明确 journal/Nginx/PM2/应用/Bot 各自轮转；初始建议日志保留 14 天，磁盘可用低于 20% 或 10GiB 任一条件报警，阈值随录像增量调整；日志不能无限占满录像盘 |
| 定期备份 | 初始目标每天一次成功的联合批次，保留 7 个日批次 + 4 个周批次，另机副本；需维护排空/停写，不能只定时 pg_dump 却宣称 DB+文件一致；自动窗口尚未实现时安排人工窗口并记为自动备份待办 |
| 恢复抽检 | 每月至少从保留批次恢复一次新库/新目录；检查内容/序列/录像及新写入；源数据增长后重新测 RPO/RTO，不凭小样本承诺分钟数 |

轮转和备份删除只按已审核的明确目录/批次执行；首次测试不自动清理旧批次。
以上是需要实际配置并测试的运行合同，不表示当前示例已经安装了报警或定时备份。

网页静态站仍独立部署。维护者按网页仓库自己的构建/发布手册交付 dist、构建参数和来源 SHA，
新机只提供游戏/API/WSS，三端地址与 Origin 按 [迁址表](server-move.md) 修改并验证。
桌面助手在玩家 Windows 机器验证新默认/自定义连接、规则安装和录像；不需要安装到 Linux 游戏服务器。

两个 Bot 按 [独立服务入口](../../services/README.md) 取得各自完整部署包，
具体命令归 [QQ 部署](../../services/qq-bot/DEPLOYMENT.md) 和 [Discord 部署](../../services/discord-bot/DEPLOYMENT.md)。
先验证包依赖/测试/私有配置/完整 data，测试默认不外发；正式切换先停止旧平台实例，再启动新实例，
保留每日/月报/连胜去重和状态卡。不能从 PM2 dump 一次恢复旧机所有 Bot/代理/其他游戏。

日常发布：Windows 保留审核的 [发布监控](windows-release-monitor.md)，在新机明确注册精确应用/cwd/队列/协调锁，
先用合成批次测试 preflight→维护排空→单应用更新→失败回退。Linux 不运行 Windows CMD；
现阶段使用本页“普通代码升级”的停写/新 release/切换 current 流程。
Linux 自动监控若未实现，写“人工发布”，不能把 Windows CMD 改后缀称为 Linux 发布支持。

移交代码仓库及未提交源码的release、私有配置、联合批次与解密方法、数据库管理权限，
域名/DNS/证书续期、静态托管及自动构建、GitHub仓库/CI归属、QQ/Discord应用权限，
备份存储和告警接收人。每项记录负责人和访问方式，秘密另存，不写在公开参数表。
由接手者实际独立走一遍空库或联合恢复流程，才证明文档足够可操作。

其他游戏王环境的模块抽取和复用属于下一阶段；本仓库目前服务于当前1103环境的部署和恢复。
