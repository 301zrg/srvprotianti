# Linux 安装脚本与手册块映射

基线：`ops/docs/linux-install.md`，main `8fb0645`；设计批准提交 `d85f42c`，第 10 节优先。
行号包含围栏。手册共 44 块，以下每块均有登记。原行号稳定用于追溯，当前附录位置见文末。
身份中的“部署”均为白名单环境、显式 HOME/cwd 的 `runuser`；root 动作拆出执行，部署子进程不调用 sudo。
只读后置验证：0=已完成，10=未开始/可安全重复只读检查，20=部分完成或无法确定；验证不得补写目标。
所有首次动作的 pending 持久化失败即不执行；部分复制/角色/库/链接一律停，保留现场。
阶段 PASS 是本路线所有块完成的聚合。下游“后续全部”指流程中排在该块之后的块，含第 2 批阶段。

| 块 ID（函数） | 手册行号 | 类型 | 身份 | 只读后置验证 | 可重做 | 下游 | 覆盖 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H10-EXPORT | 41-56 | 首次动作 | 维护者 | 维护者核对导出/CR | 否 | 全部 | 范围外：维护者侧 handover.py，第 2 批 |
| H10-LAND (`h10_land`) | 72-88 | 首次动作 | root | `verify_h10_land`：完整清单+owner/mode | 否 | 后续全部 | 自动+参数页人工检查点 |
| H10-INDEPENDENT (`h10_independent`) | 95-101 | 只读 | 部署→root 检查点 | `verify_h10_independent`：已记账接受记录 | 是 | 后续全部 | 人工检查点：独立渠道大小/SHA，双清单分别核对 |
| H10-INVENTORY (`h10_inventory`) | 106-146 | 只读 | root | `verify_h10_inventory`：统一清单模型/完整文件集/SHA | 是 | 后续全部 | 自动 |
| H10-REMOVE-STAGING (`h10_remove_staging`) | 154-169 | 首次动作 | root | `verify_h10_remove_staging`：中转路径已不存在 | 否 | 后续全部 | 自动，仅 B；规范路径/清单/cmp 守卫 |
| S12-APT (`s12_apt`) | 179-194 | 幂等 | 部署核对+root APT | `verify_s12_apt`：包已安装 | 是 | 后续全部 | 自动 |
| S12-NODE (`s12_node`) | 199-216 | 首次动作 | 部署摘要+root安装+部署版本 | `verify_s12_node`：固定版本/可执行 | 否 | 后续全部 | 自动，半目录保留 |
| S12-PG (`s12_pg`) | 223-239 | 幂等 | root+postgres | `verify_s12_pg`：17/5432/ready/enabled | 是 | 后续全部 | 自动 |
| U21-UNPACK (`u21_unpack`) | 251-266 | 首次动作 | 部署 | `verify_u21_unpack`：归档校验+三组件 | 否 | 后续全部 | 自动，已有 WORK 不覆盖 |
| E22-SOURCE (`e22_source`) | 282-311 | 首次动作 | 部署 | `verify_e22_source`：完整源码清单 | 否 | 后续全部 | 自动，半源码目录保留 |
| E22-BUILD (`e22_build`) | 315-335 | 幂等 | 部署 | `verify_e22_build`：ELF/ldd/SHA | 是 | 后续全部 | 自动 |
| B23 (`b23_compose/links/npm/install_release/install_ops/permissions`) | 350-384 | 首次动作+幂等构建/权限 | 部署构建+root安装 | `verify_b23_*`：见下文子块 | 子块限定 | 后续全部 | 自动，拆为六个记账块 |
| R31-DIRECTORIES (`r31_directories`) | 406-413 | 首次动作 | root | `verify_r31_directories`：owner/mode/目录 | 否 | 后续全部 | 自动；交互 psql 改为下一块非交互 SQL |
| R31-ROLES (`r31_roles`) | 417-423 | 首次动作 | postgres | `verify_r31_roles`：三角色属性+成员关系 | 否 | 后续全部 | 自动，部分角色停 |
| R31-PASSWORDS (`r31_passwords`) | 428-453 | 首次动作 | root Python+postgres SQL | `verify_r31_passwords`：passfile 权限/operator与runtime认证 | 否 | 后续全部 | 人工口令检查点+自动；不打印 SQL/口令 |
| A32-CONNECT (`a32_connect`) | 463-468 | 只读 | postgres | `verify_a32_connect`：peer连接 | 是 | A32 后续 | 自动，仅 A；替代交互提示符 |
| A32-DATABASE (`a32_database`) | 472-479 | 首次动作 | postgres | `verify_a32_database`：owner/libc C/UTF8/schema/授权 | 否 | 后续全部 | 自动，仅 A |
| A32-INIT (`a32_init`) | 483-495 | 首次动作 | root/operator/schema | `verify_a32_init`：只读 schema verify+选库文件 | 否 | 后续全部 | 自动，仅 A，失败先 verify、不清库 |
| B33-VERIFY (`b33_verify`) | 507-523 | 只读 | root | `verify_b33_verify`：verify退出0/PG17/不同名 | 是 | B33 后续 | 自动，仅 B |
| B33-DATABASE (`b33_database`) | 531-540 | 首次动作 | postgres | `verify_b33_database`：owner/builtin C.UTF-8/UTF8/schema/授权 | 否 | 后续全部 | 自动，仅 B，retarget 后用新名 |
| B33-RESTORE (`b33_restore`) | 549-576 | 首次动作 | root/operator | `verify_b33_restore`：三标志/摘要算法与行尾/release与独立组件/schema/选库 | 否 | 后续全部 | 自动，仅 B；失败仅 retarget |
| B33-ISOLATED-DRILL | 587-609 | 首次动作 | root | 手册三标志+独立选库 | 否 | 无 | 范围外：已有服务上的隔离恢复验证分支 |
| B33-LOCALE-CONNECT (`b33_locale_connect`) | 615-622 | 只读 | root/operator | `verify_b33_locale_connect`：只读连接 | 是 | B33-LOCALE及后续 | 自动，仅 B；输出文件由下一块五查询写入 |
| B33-LOCALE (`b33_locale`) | 626-635 | 只读 | root/operator | `verify_b33_locale`：provider/locale/编码/批次行数/无重名 | 是 | 后续全部 | 自动；L637-640 另设 B33-ACCEPT 人工检查点 |
| V34-RUNTIME (`v34_runtime`) | 647-663 | 只读 | root/runtime | `verify_v34_runtime`：重新认证+只读schema verify，不写报告 | 是 | 41及后续 | 人工口令检查点+自动 |
| L41-LAYOUT | 671-685 | 首次动作 | root | `verify_l41_layout` | 否 | 后续全部 | 自动+配置等价检查点 |
| C42-CONFIG | 720-730 | 首次动作 | root | `verify_c42_config` | 否 | 后续全部 | 自动，仅 A |
| C42-ADMIN | 736-758 | 首次动作 | root | `verify_c42_admin` | 否 | 后续全部 | 人工口令检查点+自动 |
| C43-MAP | 783-817 | 首次动作 | root | `verify_c43_map` | 否 | 后续全部 | 组件分类/映射人工确认+自动，仅 B |
| C44-CONNECTION | 839-884 | 首次动作 | root | `verify_c44_connection` | 否 | 后续全部 | 口令/差异批准检查点+自动 |
| P45-PERMISSIONS | 896-938 | 首次动作+幂等权限 | root+srvpro测试 | `verify_p45_permissions` | 子块限定 | 后续全部 | 自动 |
| F46-PREFLIGHT | 950-959 | 只读 | srvpro | `verify_f46_preflight` | 是 | 后续全部 | 自动 |
| F46-SMOKE | 966-997 | 只读验收/临时进程 | srvpro | `verify_f46_smoke` | 是 | 后续全部 | 自动 |
| D51-SYSTEMD | 1010-1074 | 首次动作+启动 | root+srvpro服务 | `verify_d51_unit` / `verify_d51_start` | 子块限定 | 后续全部 | 自动 |
| M52-TOOL | 1093-1107 | 首次动作 | root | `verify_m52_tool` | 否 | 后续全部 | 按10.10调用模块，不从文档提取 |
| M52-MAINTENANCE | 1113-1126 | 幂等 | root | `repeat_readonly`（重新认证排空） | 是 | 后续全部 | 认证检查点+自动，排空硬门槛 |
| M52-STOP | 1133-1142 | 幂等 | root | `verify_m52_stop` | 是 | 备份/重启 | 按独立writers清单停全部writer |
| M52-RELEASE-INPUT | 1151-1165 | 首次动作 | root | `verify_m52_release_input` | 否 | 备份 | 自动，仅 B |
| M52-BACKUP | 1169-1180 | 首次动作 | root/operator | `verify_m52_backup` | 否 | 重启 | 人工可选+自动verify |
| M52-RESTART | 1185-1240 | 幂等启动 | root+srvpro服务 | `restart_only` / readiness | 显式restart-only | 无自动下游 | 10.1禁止在52d后自动启动 |
| R53-PREBOOT | 1248-1256 | 只读+首次记录 | root | `verify_r53_preboot` | 子块限定 | 53b/CP2 | 自动取证+人工reboot |
| R53-POSTBOOT | 1262-1283 | 只读 | root（统一journal取证） | `verify_r53_postboot` | 是 | CP2 | boot_id/首条Accepted/5分钟/间隔60秒 |
| X54-RECOVERY | 1312-1371 | 幂等补救 | 部署+root | `diagnose`只读 | 否 | 无 | 范围外：恢复动作留人工；diagnose 仅只读诊断 |
| N61-FIREWALL | 1385-1404 | 幂等 | root | `verify_n61_firewall` | 是 | CP1/52b起 | 自动+另开SSH检查点；公网入口范围外 |

B23 子块：`B23-COMPOSE` L350-361、`B23-LINKS` L362-367、`B23-NPM` L368-372、
`B23-INSTALL-RELEASE` L373-376、`B23-INSTALL-OPS` L377、`B23-PERMISSIONS` L378-384。
仅 NPM、PERMISSIONS 可重做；其它为首次动作。验证分别为同名 `verify_b23_*`。
NPM 日志不能证明被中断的测试退出码，pending 时停下人工核实；不从日志存在推断成功。
H10-INDEPENDENT、B33-ACCEPT 无接受回执时可重新询问；不会把文件校验当作人工接受。

本批入口需要交接材料中的 `handover-params.json`：`machineName`、`route`（A/B）、
`releaseName`（linux-r4-1）、`database`（路线默认新库名）、`restoreDir`（/private-restores/batch1）、
`stagingDirectory`（部署HOME下规范绝对路径）、`opsCommit`（交付ops的40位提交）、
`ports`（game/http/wss 整数端口）。参数文件摘要与完整交接清单均绑定；不含口令。
可选 `minFreeGiB` 调整手册空间预算；B 有独立运行engine时 `runtimeEngine` 必须按路径表填 linux/windows。
执行中的脚本逐文件与交付ops对照，内容摘要与交付提交一同绑定；落地后helper路径切到落地副本，避免B删除中转目录后丢失入口依赖。
初次入口 `sudo bash install.sh run --staging /home/USER/NEW-HANDOVER`；续跑读取落地参数。
维护者侧生成器为 ops/scripts/handover.py；不从非结构化页面猜值。

`stage <阶段号> --redo` 只允许该阶段所有块均可重做；构建等混合阶段需按块ID选择可重做块。
执行前列出并使全部下游记账失效；存在首次动作目标时保留现场并由维护者处理，不自动删目标。
路线B恢复失败用 `retarget --database NEW --restore-dir /private-restores/NEW [--shared /srv/srvprotianti/NEW]`，
旧目标保留，当前绑定与历史一起原子更新；第4–6节使用绑定中的 database/restoreDir/shared，布局后 retarget 须选新 shared，已记账系统账户保留。

## 第 2 批细分登记（全部下游为流程中后续全部）

| 块 ID / 执行函数 | 阶段 / 类型 / 身份 | 验证 / redo / 覆盖 |
| --- | --- | --- |
| L41-PARAMS / l41_params | 41 / 只读 / root | verify_l41_params / 是 / 参数人工确认；只查非游戏 writer（§10.17） |
| L41-ACCOUNT / l41_account | 41 / 首次 / root | verify_l41_account / 否 / 自动 |
| L41-LAYOUT / l41_layout | 41 / 首次 / root | verify_l41_layout / 否 / 自动 |
| C42-CONFIG, C42-ADAPTER / c42_host, c42_adapter | 42 / 两个首次 / root | verify_c42_host, verify_c42_adapter / 否 / 仅 A |
| C42-ADMIN / c42_admin | 42 / 首次 / root | verify_c42_admin / 否 / A 口令检查点 |
| C42-EQUIVALENCE, C43-EQUIVALENCE, C44-EQUIVALENCE / config_equivalence | 42,43,44 / 只读 / root | verify_equivalence / 是 / 逐键理由、批准人和时间、指纹 |
| C43-MAP / c43_map | 43 / 首次 / root | verify_c43_map / 否 / B 全组件分类确认+复制 |
| C44-CONNECTION / c44_connection | 44 / 首次 / root | verify_c44_connection / 否 / 口令检查点 |
| C44-ENVIRONMENT / c44_environment | 44 / 首次 / root | verify_c44_environment / 否 / 自动 |
| P45-CONFIG-LINK, P45-LOGS-LINK, P45-ADAPTER-LINK, P45-CURRENT / p45_config, p45_logs, p45_adapter, p45_current | 45 / 各自首次 / root | verify_p45_config, logs, adapter, current / 否 / 自动 |
| P45-PERMISSIONS / p45_permissions | 45 / 幂等 / root+srvpro | verify_p45_permissions / 是 / 自动 |
| F46-PREFLIGHT, F46-SMOKE / f46_preflight, f46_smoke | 46 / 只读 / srvpro | verify_f46_preflight, smoke / 是 / 原生冒烟不代替客户端 |
| D51-SYSTEMD / d51_unit | 51 / 首次 / root | verify_d51_unit / 否 / 自动 |
| D51-START / d51_start | 51 / 幂等 / root | verify_d51_start / 否 / 不允许绕过停服 |
| M52-TOOL / m52_tool | 52a / 首次 / root | verify_m52_tool / 否 / 结构化模块代替文档提取 |
| M52-WRITERS / m52_writers | 52a / 只读+确认 / root | verify_m52_writers / 是 / 全部 unit 已加载，独立于备份 |
| M52-MAINTENANCE / maintenance_drain | 52b / 幂等 / root | repeat_readonly / 是 / 认证与排空硬门槛 |
| M52-STOP / m52_stop | 52c / 幂等 / root | verify_m52_stop / 是 / 重查排空，按清单停全部 writer |
| M52-RELEASE-INPUT / m52_release_input | 52d / 首次 / root | verify_m52_release_input / 否 / B 复制，A 无动作 |
| M52-PLAN / m52_plan | 52d / 只读+确认 / root | verify_m52_plan / 是 / 完整计划、存在不同即停 |
| M52-BACKUP / m52_backup | 52d / 首次 / root+operator | verify_m52_backup / 否 / 可选、意图先持久化、明确未备份 |
| R53-PREBOOT / r53_preboot | 53a / 只读记录 / root | verify_r53_preboot / 否 / 人工 reboot |
| R53-POSTBOOT / r53_postboot | 53b / 只读 / root | verify_r53_postboot / 是 / boot_id、首条 Accepted、五分钟、间隔60秒 |
| CP1-CLIENT, CP2-CLIENT / client_accept | CP1,CP2 / 人工 / root+客户端 | verify_client_accept / 否 / off→真实验收→on，分别记人/时间 |
| CP2-DRAIN / maintenance_drain | CP2 / 幂等 / root | repeat_readonly / 是 / 未排空续跑，最终保持维护 |
| N61-FIREWALL / n61_firewall | 61 / 幂等 / root | verify_n61_firewall / 是 / 新 SSH 连接人工确认 |

M52-RESTART 不注册自动块，显式 stage 51 --restart-only，核对停写后原子失效 52b 起全部下游，再 start/readiness。
新增必需参数：sshPort（可 null，现场确认 listener）、testCidr、managementUsername、maintenanceMessage、writerUnits、extraMutableAssets（可空）、enabledPlugins。
B 的额外组件用 componentMap 声明 id/required/action/reason/target，额外运行路径用 pathMappings 声明 document/keys/target；backupPlan 可指向交接目录内计划。
expected-config.json 必需，结构 host/adapter；只输出差异键，凭据脱敏，逐键批准和配置指纹一起记账。
顺序：10→12→21→22→23→31→32|33→34→41→42|43→44→45→46→51→52a→61→CP1→52b→52c→52d→53a→53b→CP2。

## 改写手册附录定位

| 附录 | 原手册行号 | 当前代码行号 |
| --- | --- | --- |
| B01 | 41-56 | 106-121 |
| B02 | 72-88 | 129-145 |
| B03 | 95-101 | 153-159 |
| B04 | 106-146 | 167-207 |
| B05 | 154-169 | 215-230 |
| B06 | 179-194 | 238-253 |
| B07 | 199-216 | 261-278 |
| B08 | 223-239 | 286-302 |
| B09 | 251-266 | 310-325 |
| B10 | 282-311 | 333-362 |
| B11 | 315-335 | 370-390 |
| B12 | 350-384 | 398-432 |
| B13 | 406-413 | 440-447 |
| B14 | 417-423 | 455-461 |
| B15 | 428-453 | 469-494 |
| B16 | 463-468 | 502-507 |
| B17 | 472-479 | 515-522 |
| B18 | 483-495 | 530-542 |
| B19 | 507-523 | 550-566 |
| B20 | 531-540 | 574-583 |
| B21 | 549-576 | 591-618 |
| B22 | 587-609 | 626-648 |
| B23 | 615-622 | 656-663 |
| B24 | 626-635 | 671-680 |
| B25 | 647-663 | 688-704 |
| B26 | 671-685 | 712-726 |
| B27 | 720-730 | 734-744 |
| B28 | 736-758 | 752-774 |
| B29 | 783-817 | 782-816 |
| B30 | 839-884 | 824-869 |
| B31 | 896-938 | 877-919 |
| B32 | 950-959 | 927-936 |
| B33 | 966-997 | 944-975 |
| B34 | 1010-1074 | 983-1047 |
| B35 | 1093-1107 | 1055-1069 |
| B36 | 1113-1126 | 1077-1090 |
| B37 | 1133-1142 | 1098-1107 |
| B38 | 1151-1165 | 1115-1129 |
| B39 | 1169-1180 | 1137-1148 |
| B40 | 1185-1240 | 1156-1211 |
| B41 | 1248-1256 | 1219-1227 |
| B42 | 1262-1283 | 1235-1256 |
| B43 | 1312-1371 | 1264-1323 |
| B44 | 1385-1404 | 1331-1350 |
