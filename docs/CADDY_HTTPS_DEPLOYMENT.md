# Windows 天梯 HTTPS 部署说明

> 状态：未来部署草案，尚未在正式服务器执行。状态基准：2026-09-15。
>
> 当前没有可用自有域名，维护者决定本期保持纯 HTTP 简单直连，不安装 Caddy/Tailscale，
> 也不改 `bindAddress` 或防火墙结构。本文仅作为服务器或域名条件变化后的安全债参考，不是
> 本期上线步骤。本文不包含数据库密码、天梯密码或证书私钥。

## 1. 本期范围

只处理持续开发的当前卡池环境：

| 项目 | 当前值 |
| --- | --- |
| 游戏 TCP 端口 | `7911` |
| Web/API 端口 | `7922` |
| HTTP `bindAddress` | 未配置，当前监听所有可用接口 |
| 内置 SSL | 关闭 |

同级 `config-srvpro2.json` 对应的 2337/2338 环境仍使用未解耦旧代码且卡池不同，本期不修改、
不更改防火墙规则，也不纳入本 Caddyfile。将来若要迁移，必须单独检查和验收。

## 2. Caddy 在这里做什么

取得域名后，Caddy 放在 SRVPro Web 服务前面：

```text
浏览器
  │  HTTPS 443
  ▼
Caddy（证书申请/续期、TLS 终止、HTTP 跳转 HTTPS）
  │  本机 HTTP
  ▼
127.0.0.1:7922（当前 SRVPro Web/API）
```

公网只看见 80/443；后端 7922 只在同一台机器的 loopback 上传输。Caddy 保留原始路径和查询
参数，并设置代理头。它只代理网页和 HTTP/WebSocket API，不影响 YGOPro 游戏 TCP 7911。

没有自有域名时，直接给公网 IP 使用 Caddy 本地 CA 只能得到自签名证书；未安装该根证书的
普通玩家浏览器会报安全错误。要求所有玩家手工安装根证书不适合公共页面，因此当前不执行
这套方案。

## 3. 有域名后的前置条件

1. 准备一个域名或子域名，例如 `ladder.example.com`。
2. DNS A 记录指向服务器公网 IPv4；使用 IPv6 时再配置 AAAA。
3. 云服务商安全组和 Windows Defender 防火墙允许入站 TCP 80、443。
4. 80、443 没有被 IIS、Apache、Nginx 或其他程序占用。
5. 确认没有外部监控或管理程序必须直连 7922；否则先迁移这些调用。
6. HTTPS 验收成功后，阻止公网直接访问 7922。

若域名接入额外 CDN/代理，真实客户端 IP 的信任链会变化，必须另行设计可信代理范围，不能
直接信任任意来源的 `X-Forwarded-For`。

## 4. Windows 安装

1. 从 [Caddy 官方安装页](https://caddyserver.com/docs/install)下载 Windows x64 标准版
   `caddy.exe`。
2. 建立 `C:\caddy\`，放入 `caddy.exe`，并记录版本及文件校验值。
3. 在管理员 PowerShell 执行 `C:\caddy\caddy.exe version`。
4. 前台验证完成后，按[官方 Windows service 文档](https://caddyserver.com/docs/running)使用
   WinSW 或 `sc.exe` 注册自动启动服务。WinSW 更便于固定工作目录、配置路径和滚动日志。

生产环境不要依赖长期打开的命令行窗口维持 Caddy 运行。

## 5. Caddyfile

在 `C:\caddy\Caddyfile` 写入并替换真实域名：

```caddyfile
{
  email admin@example.com
}

ladder.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:7922
}
```

域名 DNS 正确、80/443 可达且 Caddy 数据目录可写时，Caddy 会自动申请和续期浏览器信任的
证书，并把 HTTP 跳转到 HTTPS。后端必须使用 `127.0.0.1`，不能写公网 IP。

验证格式和前台测试：

```powershell
C:\caddy\caddy.exe validate --config C:\caddy\Caddyfile --adapter caddyfile
C:\caddy\caddy.exe run --config C:\caddy\Caddyfile --adapter caddyfile
```

确认成功后按 `Ctrl+C` 停止前台实例，再安装 Windows 服务。修改配置时先 `validate`，再用
`caddy reload` 平滑加载。

## 6. `bindAddress=127.0.0.1` 的含义

目前 Node 使用 `http_server.listen(port)`，未指定地址时通常会在全部可用网络接口监听。因此
只要防火墙允许，本机、内网和公网地址都可能直连 7922。

计划增加兼容性的可选配置：

```json
{
  "modules": {
    "http": {
      "bindAddress": "127.0.0.1"
    }
  }
}
```

Node 随后使用 `http_server.listen(port, bindAddress)`：

- 本机 `127.0.0.1:7922` 仍可访问，Caddy 或 Funnel 可正常代理；
- 内网 IP 和公网 IP 的 7922 无法直连，即使误开普通允许规则也没有服务在相应网卡接收；
- 网页和 API 改从 HTTPS 地址访问；
- 游戏 TCP 7911 不受影响；
- 服务器外部直连 7922 的监控或管理调用会失效。

配置缺失时保持原监听行为，以兼容其他部署。loopback 监听和防火墙是两层防护，应同时使用。

## 7. 防火墙调整

域名/Caddy 正式上线后：

- 云安全组和 Windows 防火墙允许公网 TCP 80、443；
- 保留游戏 TCP 7911 的既有规则；
- 删除或禁用 7922 的公网允许规则；
- PostgreSQL、管理接口和备份目录不得因本次改造向公网开放；
- 不修改旧环境 2337/2338 的规则。

必须从另一台公网机器实际测试，不能只在服务器本机验证。

## 8. 应用代码配合

1. 新增通用可选 `modules.http.bindAddress`，默认缺失时保持兼容。
2. Caddy 模式下保持 SRVPro 内置 SSL 关闭，TLS 只在 Caddy 终止。
3. 仅信任物理来源为 loopback 的 `X-Forwarded-For` 和 `X-Forwarded-Proto`。
4. 带密码接口只接受 HTTPS；HTTP 提交密码返回 `426 Upgrade Required`。
5. 敏感端点校验同源 `Origin`，不得继承全局 `Access-Control-Allow-Origin: *`。
6. 认证失败按真实 IP 与玩家 ID 两个独立维度限速，日志不记录密码或请求体。
7. 私有响应设置 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。

页面使用相对 URL，切换 HTTPS 后无需逐页替换 API 或静态资源地址。

## 9. 当前无域名时的替代方案

[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)可以把本机 7922 暴露为公开
`https://*.ts.net` 地址并自动配置有效证书，普通访问者不需要安装 Tailscale，也不需要开放
80/443 或配置自有 DNS。目标命令形式为：

```powershell
tailscale funnel --bg 7922
```

`--bg` 会持久保存配置，并在 Tailscale 或设备重启后自动恢复；仍需实际做重启验收。Funnel
当前仍为 beta，使用 Tailscale 的加密代理且受不可配置带宽限制。只代理 7922 时，游戏 TCP
7911 不经过 Funnel，因此不会直接影响对战延迟；带宽限制影响的是页面、API、录像和卡组
下载。本期决定不使用，未来若重新评估，必须确认可接受第三方中继、测试下载速度并验证
Windows 重启后服务恢复。相关产品与安全取舍详见
[LADDER_PLAYER_AND_USAGE_SPEC.md](./LADDER_PLAYER_AND_USAGE_SPEC.md#15-传输安全认证与-sql-注入边界)。

## 10. 上线顺序与验收

1. 先完成 DNS，不关闭旧访问路径。
2. 安装 Caddy，验证 Caddyfile 后前台启动。
3. 检查首页、房间、录像、排行、下载、四语言和所有新增 API。
4. 安装 Caddy Windows 服务并重启服务器验证自动恢复。
5. 部署 `bindAddress`，将当前 Node HTTP 绑定到 `127.0.0.1`。
6. 关闭安全组和 Windows 防火墙中的公网 7922。
7. 从外部网络确认 HTTPS 正常、HTTP 自动跳转、证书受信任且公网 IP:7922 不可达。
8. 验证认证限速取得真实客户端 IP，密码不出现在 URL、日志和浏览器历史。
9. HTTPS 稳定后再评估 HSTS。
10. 在正常房间负载下记录 Caddy/Tailscale、Node 与整机内存，满足主设计文档第 11.1 节最低线。

## 11. 回退

如果 Caddy/Funnel 上线失败：

1. 保留 Node 和数据库，不做数据回退。
2. 停止代理服务。
3. 临时撤销 `bindAddress` 部署覆盖，使 Node 恢复原监听方式。
4. 仅在必要时恢复旧 Web 端口防火墙规则；此时带密码查询必须禁用，公开查询可继续使用。

## 12. 官方参考

- [Caddy 安装](https://caddyserver.com/docs/install)
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Caddy Windows service](https://caddyserver.com/docs/running)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)
