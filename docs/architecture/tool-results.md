# 工具结果、效果收据与恢复建议

更新日期：2026-10-07。内核是 FluxOs，桌面代理是 FluxAgent。

## 状态与原始内容分开

`ToolResult.output` 是原始工具内容；`Error:`、`Unknown tool:`、中文失败信息都不能决定调用状态。运行时派发中的普通字符串仅表示成功内容；失败必须返回带 `isError` 的结构。`ToolDispatchResult.isError` 必填。

`errorKind` 表示 validation / permission / environment / execution / timeout / abort。已知的准入、参数、运行环境和取消分支直接赋值；无法进一步确认的执行异常归为 execution。宿主能够确认的底层类别通过 `Result.errorKind` 传递，不能靠正文里的 permission、timeout 等词升级类别。

`toolResultExecutionStatus` 是运行、统计、回放和模型消息的共同状态函数。命令的 `isError` 表示调用/捕获结果；进程的 exit code、signal、running、timed_out、aborted 及 expectedExitCodes 独立保存。例如捕获到 exit 7 可以 `isError=false`，但执行状态仍为 failed。后台启动/轮询调用可以已返回，其进程仍 running。

## 效果和重试条件

失败或取消的生产结果携带 `recovery`：

| effects | 含义 |
| --- | --- |
| none | 已知本次调用未提交相关修改，或声明的操作只有读取 |
| committed | 已确认操作提交；不是持久化完成或当前内容未再改变的保证 |
| partial | 已确认部分操作提交，其余尚未完成 |
| unknown | 已派发操作但未获得效果确认，必须检查 |

`retry` 是条件，不是自动重放许可：after_correction、after_permission、after_environment、after_inspection、explicit_request。只要存在已提交、部分提交或未知效果，就要求先检查；仍需满足当前权限和用户的停止/继续意图。读取到某个进程退出不能证明该命令没有文件或外部副作用。

生命周期在准入前保留 none；派发后根据工具声明保守记录未知效果；提交后取消保留既有收据、附件与变更摘要。文件写/删继续使用底层 mutation 回执。patch 保留完整 committed/pending/unknown 路径和失败阶段，不回滚、不猜原子性。

## 任务变更收据与恢复

create_task、create_tasks、update_task 和依赖变更返回 `data.kind=tasks`：实际确认的任务节点、completed/partial/failed、逐输入索引的 create/dependency 失败原因。

批量创建不是事务。创建成功但依赖失败为 partial；已创建节点必须保留。回放汇集每个节点最后一份实际收据，不重新执行输入，不用数组位置给后续节点补造 ID，不创建失败项，也不补加失败依赖。

当前 canonical 投影把工具结果挂在 assistant 回合，实时执行会产生独立 tool_result 回合。恢复统一按 toolCallId 归并这两种当前生产形式。已结算数据必须显式提供 isError；没有结果的 pending/running 调用不能被猜成成功。不存在按错误前缀的旧格式回退或迁移。

## 持久化、模型与界面

`copyToolResultDetails` 深拷贝 recovery、data、errorKind、interruption、retrieval、changeSummary、attachments。canonical append/reopen、运行时重建和展示消费同一份事实。

模型工具消息使用 JSON 载荷，含 status、isError、errorKind、recovery 和原始 output；命令附进程事实与 expectedExitCodes，patch/tasks 附收据状态和完整计数。完整收据保留在持久化数据里，模型摘要不重复塞入无限长节点/路径列表。Chat、Responses 与 Messages 共用此表达；Messages 另写原生 is_error。图片继续通过原生视觉块传递。

协议配对修复遇到缺失结果，只能说明结果不可用、效果未知，不能假造成功或用户取消。重试提示放在 `recovery.guidance`，不改原始工具输出，也不为说明新增用户回合。

桌面展示部分任务修改与问题计数、条件型恢复说明。附件预览在共用结果层生成，失败、部分提交、取消也保留证据。电脑隐私投影继续删除敏感正文/图片，但保留只含枚举值的恢复与中断信息。

## 验证入口与边界

- 内核：`toolResultContract.test.ts`、`taskToolDispatcher.test.ts`、`runtime/toolCallLifecycle.test.ts`、`runtime/agentSessionRehydrator.test.ts`、命令/patch/隐私回归。
- 产品：`scripts/integration/toolResultContractReplay.test.ts` 从真实 Engine 生产者执行，经 canonical append/reopen、展示和 Engine 恢复，捕获三个协议的实际序列化请求。仅使用临时文件、固定本地进程和 MCP fixture，不访问模型服务。
- 产品 DOM：`scripts/tool-result-contract-dom-smoke.mjs` 在真实 Electron DOM 加载源码 bundle，检查错误文本、图片、部分提交、取消和恢复说明。这不是安装包或前台交互验收。
- 任务证据：产品仓 `docs/plans/2026-10-06-agent-hardening/evidence/T021-*`。实际结果以日志和最终结果文件为准，不以本文存在作为验收通过。
