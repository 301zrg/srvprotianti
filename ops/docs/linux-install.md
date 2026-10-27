# 从全新 Linux 安装当前 1103 服务

本指南的主线是 Ubuntu 24.04 LTS、x86_64、Node 24、PostgreSQL 17、native + systemd。
网页静态站继续独立托管，桌面助手继续走 Windows 发行流程。
本机实际验证范围见 [验收与演练](validation.md)，尚未取得真实 Linux 游戏验收结果。
已有账号、积分和录像需要保留时，改走 [联合恢复](backup-restore.md)，不要执行空库初始化。

## 先准备交接包

需要：审核过的服务端 release archive 及其 manifest、本目录运维材料、完整引擎源代码与资源、
四语查询 CDB、自己的域名和 TLS 证书管理方式、私有配置和数据库管理权限。
四语查询库可从独立资源仓库 Git LFS 直接取得，无需手动拷贝；完整在线引擎仍需封存资源包。
下载前确认 [资源发布状态](resources.md#从线上取得四语查询库)，固定提交与四份 LFS 对象必须均已上线。
release 不能只凭 Git HEAD 判断完整：若运行服务器仍有未提交的业务文件，需要逐项审查纳入，漏掉它们会缺功能。
版本与资源指纹入口是 [versions.json](../versions.json)，参数表是
[deployment.example.json](../templates/deployment.example.json)。

在有网络的新机或可信构建机上安装 Git LFS，从不存在的 `srvprotianti` 目录取得源码。
`SERVER_COMMIT` 必须替换为包含本次下载工具及资源版本清单的已审核完整服务端提交 SHA；不要保留示例占位值。
工具按该版本清单的 `catalogSource` 取固定资源提交，不使用浮动最新卡库。

```bash
sudo apt-get update
sudo apt-get install -y git git-lfs python3
SERVER_COMMIT=REPLACE_WITH_REVIEWED_FULL_COMMIT_SHA
git clone --branch main https://github.com/301zrg/srvprotianti.git srvprotianti
cd srvprotianti
git checkout --detach "$SERVER_COMMIT"
python3 ops/scripts/ops.py catalog-fetch \
  --destination plugins/card-catalog/databases --versions ops/versions.json
python3 ops/scripts/ops.py catalog-check \
  --catalog plugins/card-catalog/databases --versions ops/versions.json
git rev-parse HEAD
cd ..
```

若 GitHub/LFS 下载受限，先解决联网或访问权限，不能继续使用 LFS 指针当作卡库。
源码 ZIP 或 GitHub raw 不保证提供真实 LFS 内容；安装与检查过程不得跳过。
仓库已有源码时切到审核提交后运行检查；已有 `databases/` 目录通过指纹校验即可复用。
下载工具拒绝覆盖已有目标。不匹配时下载到另一个新目录，再按运行配置或 release 组件安排切换，不重新创建同名链接。

在可信的源码工作区制作制品。下例目录都由操作者填写；若有必要纳入未跟踪的公共业务源码，
先逐项审阅，再添加对应的 `--include-public` 参数。
被忽略的私密配置、运行数据不要加入公开源码制品；它们属于私有联合备份。

```bash
python3 srvprotianti/ops/scripts/ops.py release \
  --source srvprotianti --output /private-staging/server-1103.tar.gz \
  --release-id server-1103-20261011 \
  --component engine=srvprotianti/ygopro \
  --component catalog=srvprotianti/plugins/card-catalog/databases
```

先用 `git status --short` 审核完整列表，确认所有实际运行的业务源码已跟踪或已显式选入。
制品清单记录当前文件字节、HEAD、dirty 状态和所有显式选入文件。引擎中的 `.git`、录像和私密文件不进入公开制品。
四语 CDB 必须作为 `catalog` 组件提供；发布工具不在 `application/` 再保存同一批查询库。
源码制品自身也需要检查：提交过的凭据不会因文件名过滤自动变安全。

## 1. 安装系统依赖和固定 Node

以下命令在新机执行，先确认 `uname -m` 为 `x86_64`。

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git git-lfs python3 xz-utils file \
  build-essential libevent-dev libsqlite3-dev liblzma-dev nginx postgresql-common
```

Node 的复现基准为已在本机跑过项目检查的 24.15.0；它不是“最新版已验证”的声明。
升级 Node 补丁时记录实际版本，并重复构建和恢复演练。
下载及签名校验方式见 [Node 官方下载](https://nodejs.org/en/download)。

```bash
NODE_VERSION=24.15.0
mkdir -p node-download
cd node-download
curl --fail --location --remote-name "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
curl --fail --location --remote-name "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
awk -v f="node-v${NODE_VERSION}-linux-x64.tar.xz" '$2==f {print}' SHASUMS256.txt > selected.sha256
test -s selected.sha256
sha256sum --check selected.sha256
sudo mkdir -p /opt/node24
sudo tar --extract --xz --file "node-v${NODE_VERSION}-linux-x64.tar.xz" --strip-components=1 --directory /opt/node24
export PATH=/opt/node24/bin:$PATH
node --version
npm --version
cd ..
```

下载校验文件与下载文件来自同一个官方 HTTPS 来源；有签名校验流程的团队按官方流程额外验证签名。
记下 Node archive SHA、实际 npm 版本和 APT 包版本到本次私有安装记录。

## 2. 安装 PostgreSQL 17

用户记忆中的源库大版本为 17，正式迁移前仍执行 `SHOW server_version;` 核实。
Ubuntu 自带的默认版本不一定是 17，应按
[PostgreSQL 官方 Ubuntu 安装说明](https://www.postgresql.org/download/linux/ubuntu/)
配置 PGDG 仓库，再显式安装 `postgresql-17 postgresql-client-17`。

```bash
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt-get update
sudo apt-get install -y postgresql-17 postgresql-client-17
/usr/lib/postgresql/17/bin/psql --version
/usr/lib/postgresql/17/bin/pg_dump --version
sudo -u postgres psql -X -c 'SHOW server_version;'
```

核对 PostgreSQL 只监听本机或受控的私网，应用不需要公网 5432。
不要在服务器换机时顺便改变数据库大版本。角色、空库初始化按 [数据库指南](database-init.md) 操作。

## 3. 安装应用目录

```bash
sudo useradd --system --create-home --home-dir /srv/srvprotianti --shell /usr/sbin/nologin srvpro
sudo install -d -m 0755 /srv/srvprotianti/releases /srv/srvprotianti-ops
sudo install -d -m 0750 -o srvpro -g srvpro /srv/srvprotianti/shared
sudo install -d -m 0700 /etc/srvprotianti /private-staging
```

将服务端仓库的 `ops/` 目录完整复制到 `/srv/srvprotianti-ops`，将 release 及 sidecar manifest 放到 `/private-staging`。
用运维工具校验和安全解包，新目标目录必须不存在。

```bash
sudo python3 /srv/srvprotianti-ops/scripts/ops.py verify-release --archive /private-staging/server-1103.tar.gz
sudo python3 /srv/srvprotianti-ops/scripts/ops.py unpack-release \
  --archive /private-staging/server-1103.tar.gz \
  --destination /srv/srvprotianti/releases/server-1103-20261011
sudo chown -R "$(id -un):$(id -gn)" /srv/srvprotianti/releases/server-1103-20261011
```

最后一条只调整刚校验解包的这一个新 release；先确认绝对路径正确。
后续链接、下载、编译和 npm 命令由当前部署用户执行，避免对 root 拥有的只读目录直接写入。
游戏运行身份仍是 srvpro，运行数据单独放 shared；不要给它整个旧 release 的写权限。

release 解包后有 `application/`、`components/engine/`、`components/catalog/`。
在新 release 中把 `application/ygopro` 指向 `../components/engine`，
把 `application/plugins/card-catalog/databases` 指向 `../../../components/catalog`。
四语查询数据库必须真的存在；仅有网页裁剪库不够。
以下链接命令用于新解包的 release；源码工作区已下载真实 `databases/` 目录时不执行同名链接。

```bash
cd /srv/srvprotianti/releases/server-1103-20261011/application
ln -s ../components/engine ygopro
ln -s ../../../components/catalog plugins/card-catalog/databases
sudo install -d -m 0750 -o srvpro -g srvpro /srv/srvprotianti/shared/config \
  /srv/srvprotianti/shared/replays /srv/srvprotianti/shared/deck_log \
  /srv/srvprotianti/shared/logs /srv/srvprotianti/shared/privatePluginConfigs \
  /srv/srvprotianti/shared/privatePluginConfigs/postgres-compat \
  /srv/srvprotianti/shared/tournament-decks /srv/srvprotianti/shared/tournament-logs
ln -s /srv/srvprotianti/shared/config config
ln -s /srv/srvprotianti/shared/logs logs
ln -s /srv/srvprotianti/shared/privatePluginConfigs/postgres-compat/config.json plugins/postgres-compat/config.json
```

若名称已存在，先查明来源及内容，不用覆盖链接命令跳过核对。
既有录像或配置应从恢复目录映射到 shared，不能用新建空目录掩盖漏件。
应用以正确工作目录启动；`ygopro/ygopro`、插件路径和相对配置路径都依赖它。
在应用目录完成 `npm ci` 后，按 [查询库配置](../../plugins/card-catalog/CARD_DATABASE_CONFIG.md#验证实际插件装载)
执行真实四库的只读装载验收，确认 `metadataAvailable=true`、卡片数量非零、四语均成功读取。

## 4. 取得兼容的 Linux 引擎

本地 `ygopro.exe` 是 Windows 文件，改名不能在 Linux 用。
复用旧 Linux 引擎的条件是架构、动态库、协议版本、Core/Lua/脚本和资源均匹配，且验收通过。
没有可复用 Linux 文件时，从 release 内封存的源代码构建，
不要重新拉取浮动 `server`、`master` 或 `server-latest` 来代替当前 706 环境。

```bash
cd /srv/srvprotianti/releases/server-1103-20261011/components/engine
curl --fail --location --output premake-linux.tar.gz \
  https://github.com/premake/premake-core/releases/download/v5.0.0-beta8/premake-5.0.0-beta8-linux.tar.gz
printf '%s  %s\n' 63edd3e7461eebdd45b500a3c7e8ad4e7a67d68f230010f9a97cbb71b4ec59c8 premake-linux.tar.gz | sha256sum --check -
tar --extract --gzip --file premake-linux.tar.gz
chmod +x premake5
cp -r premake/* .
cp -r resource/* .
./premake5 gmake --use-simd=sse2
make -C build -j2 config=release
install -m 0755 bin/release/ygopro ./ygopro
file ./ygopro
ldd ./ygopro
sha256sum ./ygopro
```

Premake 版本与 SHA 来自当前封存源码的 `.github/workflows/server.yml`。
使用 SSE2 避免构建机自动选择 AVX2，降低换 CPU 后不能运行的可能。
Lua 默认使用封存的 `lua/` 源码按 C++ 构建；缺目录时按该 workflow 的固定版本及 SHA 补齐。
不要随手替换成系统 C Lua；不要把网页 Replay Core 的脚本当作在线服务器脚本。
本指南的构建命令尚未在本机 Linux 执行；实际编译和对战验收是上线前检查项。

## 5. 依赖、数据库和私有配置

在新 release 的 application 目录执行：

```bash
export PATH=/opt/node24/bin:$PATH
npm ci
npm run build
npm test
node plugins/postgres-compat/deployment/schema.js check-contract
```

不要复制 Windows 的 node_modules。
按 [数据库指南](database-init.md) 只对全新空库运行 init；已有库走 verify/恢复分支。
模板 [server.config.example.json](../templates/server.config.example.json) 是覆盖片段，
用于首次新装，不用于覆盖已有正式配置。必须核对当前 1103 `hostinfo`、禁限表编号、
允许版本、插件开关和恢复设置；示例不替操作者猜规则。

首次新装可用下面命令创建初始配置，再私下补齐规则参数；恢复已有服务则按恢复指南映射原文件：

```bash
sudo install -m 0600 -o srvpro -g srvpro /srv/srvprotianti-ops/templates/server.config.example.json \
  /srv/srvprotianti/shared/config/config.json
sudo install -m 0600 -o srvpro -g srvpro /srv/srvprotianti-ops/templates/postgres-compat.config.example.json \
  /srv/srvprotianti/shared/privatePluginConfigs/postgres-compat/config.json
sudo install -m 0600 /srv/srvprotianti-ops/templates/server.env.example /etc/srvprotianti/server.env
```

其他插件的私有 config.json 也放到 shared/privatePluginConfigs 的对应插件目录，
由 application 中的同名 config.json 链接过去，逐项纳入备份计划。
公开默认文件留在 release；管理页面可写的卡组模板、分类/展示 JSON 按模块文档显式映射可写目录，
并纳入备份，不能只将日志设为可写后假定所有管理写入可用。
认证模块在加载时创建 `./logs`，因此 logs 链接必须在启动前完成。

首次启动前私下创建 `shared/config/admin_user.json`，按
[维护管理账号和操作](maintenance.md#维护管理账号和操作) 设置独立密码与 stop 权限。
公共默认账号是禁用状态，不能作为可用管理账号；恢复时保留原文件，不用新装模板覆盖。

PostgreSQL 插件本地配置启用 `enabled:true`、`synchronize:false`。
运行连接的五个 `SRVPRO_LADDER_PG_*` 值放入 root 可读的 `/etc/srvprotianti/server.env`，
运行用户名使用无建表权限的 runtime role。新宿主会排除这组变量的通用日志/主配置迁移。
数据库管理员凭据与运行连接凭据分别保存；不要写进 release 或公开仓库。

运行配置里录像路径为 `/srv/srvprotianti/shared/replays/`。
宿主仍有字符串拼接路径，目录末尾 `/` 不能遗漏；Windows 盘符和反斜杠需要映射为 Linux 路径。
配置文件属主 srvpro、0600，shared 数据目录 0750。按现有插件文档确认需要写入的模板、元数据目录。

## 6. 安装进程与网络

Windows 制品的文件 mode 不代表 Linux 最小写权限。构建完成、路径映射准备好后，
对刚创建的 release 收紧 group/other 写权限，保留需要的执行位：

```bash
chmod -R go-w /srv/srvprotianti/releases/server-1103-20261011
```

先核对这是本批 release，不对未知旧目录操作；shared 运行资产仍由 srvpro 管理。

把 [systemd 模板](../templates/srvprotianti.service) 安装到 `/etc/systemd/system/`，
替换路径、环境文件，确认 ExecStart 使用直接 Node 而不是 `node ... | bunyan`。
`current` 链接指向本批 application，初次创建后执行：

```bash
sudo ln -s /srv/srvprotianti/releases/server-1103-20261011/application /srv/srvprotianti/current
sudo systemctl daemon-reload
sudo systemctl enable srvprotianti.service
sudo systemctl start srvprotianti.service
sudo systemctl status srvprotianti.service --no-pager
sudo journalctl -u srvprotianti.service -n 100 --no-pager
```

Node 管理子房间进程，systemd 的整个服务 cgroup 需要一起停止；不要另起第二个 npm start 实例。
启动日志需核实数据库连接、所有需要的插件和四语卡库，而不只看端口已监听。

默认公网开放 TCP 7911、TLS 443，以及已经确认的 SSH 管理端口。
原始 HTTP 7922、Neos 7977 与 PostgreSQL 5432 只供本机/受控私网使用。
宿主当前监听未绑定 loopback，须由云防火墙及 Linux 防火墙阻断这些原始公网端口。
不要未核实 SSH 放行就启用拒绝入站策略。
WSS/API Nginx、Origin、可信代理头配置按 [迁址与网络](server-move.md) 操作。

## 7. 放行前验收

运行 preflight 时传真实 release 路径，不传 current/ygopro 等符号链接：

```bash
python3 /srv/srvprotianti-ops/scripts/ops.py catalog-check \
  --catalog /srv/srvprotianti/releases/server-1103-20261011/components/catalog \
  --versions /srv/srvprotianti-ops/versions.json
python3 /srv/srvprotianti-ops/scripts/ops.py preflight \
  --application /srv/srvprotianti/releases/server-1103-20261011/application \
  --engine /srv/srvprotianti/releases/server-1103-20261011/components/engine \
  --catalog /srv/srvprotianti/releases/server-1103-20261011/components/catalog \
  --versions /srv/srvprotianti-ops/versions.json
```

再按 [验收表](validation.md) 完成新账号、TT 全 Match、换备、重连、观战、四语统计、
录像下载播放、普通房与特殊房间代码验证。测试库和测试录像使用测试账号。
记录 Linux reboot 后服务和网络是否恢复。
机器人按各自部署包运行，切换时先停旧实例并保留去重状态，不与宿主合并进程。

首次安装失败时保留日志与报告；不要靠打开 synchronize 来“自动修好”。
验收通过后按维护指南取消 modules.stop，确认 maintenanceEnabled=false 才正式开放新入房。
已有数据恢复失败时保留新库/新目录证据，返回未切换的旧机，按 [回退边界](maintenance.md) 处理。
