# 困难群众补贴受理服务

街道民政专干的受理工作台：打开一笔申请，直接看到**资格依据、具体缺件、下一位办理人**，无需在多部门回执之间来回比对。纯 Node.js 内置能力实现，无外部依赖。

## 运行

```bash
npm start          # 启动受理服务（默认 :3000，数据目录 ./data）
npm start -- --help
npm test           # 运行测试（node:test）
```

环境变量：`PORT` 服务端口；`DATA_DIR` 事件日志目录（默认 `./data`，已 gitignore）。

## 参考数据（fixtures/）

| 文件 | 内容 |
| --- | --- |
| `context.json` | 现有政策样例与脱敏现场记录；政策 code/生效日/优先级以此为准，启动时对历史记录做重复申报自检 |
| `policies.json` | 政策业务细节：周期、所需材料（含有效期）、核验环节、资格规则、发放标准；`settings.priorityStrategy` 控制低保/残疾/临时救助的优先关系（`EXCLUSIVE_BY_PRIORITY` 数值大者优先，`ALLOW_PARALLEL` 允许并行） |
| `field-dictionary.json` | 字段字典：必填/格式/枚举校验 + 按角色脱敏策略（full/partial/hidden，可配保留首尾位数） |
| `conflict-materials.json` | 冲突材料规则：互斥材料不得同时有效、同类材料关键字段不得不一致 |

## 接口

身份由网关注入请求头：`X-Actor-Id` 工号、`X-Role` 角色、`X-Street` 所属街道（中文需 percent-encoding）。角色：`caseworker` 专干 / `disburser` 发放岗 / `auditor` 审核监督 / `district-admin` 区级（可跨街道只读）/ `verification-agent` 核验回执岗。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` `/meta` | 健康检查；政策、优先策略、冲突规则 |
| POST | `/streets/:street/applications` | 受理申请（支持 `Idempotency-Key` 头重放） |
| GET | `/streets/:street/applications` | 本街道列表（`?status=` `?familyKey=`） |
| GET | `/streets/:street/applications/:id` | **工作视图**：资格依据 / 具体缺件 / 下一位办理人 / 版本链 / 回执汇总 |
| POST | `…/:id/supplements` | 材料补交（形成连续版本，链回补正通知） |
| POST | `…/:id/receipts` | 核验回执（按 `receiptId` 幂等，容忍乱序） |
| POST | `…/:id/disburse` | 发放（幂等，重复请求返回原记录） |
| POST | `…/:id/reject` | 驳回（原因必填并留痕） |

## 关键设计

- **事件溯源，重启不丢**：所有业务事实（受理、版本、补正通知、回执、决定、发放）追加写入 `data/events.jsonl`（批量一次写入 + fsync，容忍末行半截写入）。重启后重放恢复全部状态——补正链、回执、驳回原因、发放记录原样回来。
- **同周期查重**：同一家庭在同一政策周期内只允许一个有效申请，跨社区、跨街道全局拦截；跨街道命中时不回显对方申请号。
- **证明按生效日判断**：材料只在 `[effectiveFrom, effectiveTo]` 内有效（缺省按政策 `validityDays` 推算）。审核跨月导致收入证明失效时，自动退回待补正并注明“已于 X 失效”，补交后沿用已回执继续办理；工作视图另附 7 日内到期提醒。
- **回执乱序/幂等**：回执按 `receiptId` 去重；每个核验环节取最新签发回执，全部到齐才裁决；批准后才到的 FAIL 回执会撤销批准并按最新回执重判，原因全部留痕。驳回决定汇总所有未通过环节与资格规则，一条不丢。
- **发放不重复**：发放记录按申请确定性生成，重复请求返回原记录；另有“家庭+政策+周期”台账兜底，重启后依然幂等。
- **街道隔离与脱敏**：非区级角色只能访问本街道路由；身份证号等敏感字段按字段字典对角色脱敏（专干全量、审核/区级掩码、其余隐藏）。
- **优先级可配置**：低保(30) > 残疾补贴(20) > 临时救助(10)，同家庭周期重叠时高优先级覆盖低优先级（在办的被覆盖、后决的被驳回），改 `policies.json` 即可调整。

## 目录

```
fixtures/            参考数据（政策样例、字段字典、冲突材料规则）
src/config.js        载入并合并参考数据
src/store.js         追加式事件日志
src/eligibility.js   材料有效期 / 冲突 / 资格规则（纯函数）
src/engine.js        命令与状态机（串行化、幂等、查重、裁决）
src/masking.js       按角色脱敏
src/views.js         专干工作视图
src/server.js        HTTP 层（路由、街道隔离、角色权限）
test/                node:test 测试（含乱序回执、跨月失效、重启恢复）
```
