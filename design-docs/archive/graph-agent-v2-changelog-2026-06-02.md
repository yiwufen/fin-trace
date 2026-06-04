# graph-agent v2 设计修正 — 变更记录

## 触发条件
2026-06-02 霍尔木兹海峡五工具全链路模拟，暴露原 State 模型的四个深层问题。

## 修正内容

### 1. event_buffer → 删除，改为 raw_event_archive（问题 1）
- 第一性原理：EXPLORING 轮次不需要历史 raw 数据。每轮 raw 在当轮被 LLM 消费并抽象为 key_insights。下一轮只需要抽象产物。
- raw_event_archive 只在 FINALIZE 注入（拼 Thread 时需要查 ku_id 和时间戳）
- 删除 event_buffer(max50)，改为无上限追加的 raw_event_archive

### 2. key_findings → 拆为三层（问题 2）
- entity_flags（代码保障层）：基础设施告警，代码注入 prompt
- cluster_flags（数据绑定层）：随集群数据附加，LLM 自然看到
- key_insights（LLM 认知层）：跨轮合成性洞察，LLM 自由消费

### 3. 二段压缩 → 极简化（问题 3）
- 去掉 Active State + Compressed Log 二段结构
- State 体积天然小（去掉 event_buffer 后），唯一可压的是 exploration_log
- 85% token → 压 exploration_log → 还超 → FINALIZE

### 4. frontier 优先级 → 准入控制（问题 4）
- 不去设计加权排序系统
- LLM Think 自带判断力，优先级的实际作用是辅助清单
- 改为：max 10 + 带 reason + entity_flags 准入检查（消歧失败的实体不让进）

## 文件修改

**工作区合并文档**:
- graph-agent-design-2026-06-01.md：第四节（State）、第五节（上下文组装）、第八节（System Prompt）、第九节（认知产物）、第十节（Event Thread）、新增第十一-B节（上下文溢出处理）

**开发目录分节文件** (D:\projects\graph-explorer\design-docs\, 2026-06-02 21:20-21:55):
- state.md：重写——删除 event_buffer/event_archive/recall 工具/预算分池/compressed results，替换为 v3 ExplorationState
- context-assembly.md：重写——删除三层热/温/冷架构，替换为 EXPLORING/FINALIZE 两条路径
- findings.md：重写——三层；接口规范化对齐 state.ts v3（EntityFlag: entity_id/unreliable_mapping/noise_ratio/note → entity_name/flag_type/description/source_step；Map → Array）
- agent-loop.md：重写——删除三层架构/温层/recall/压缩/预算分池，替换为 v3 EXPLORING/FINALIZE 两路径
- tools.md：删除第 6-8 节（recall_entity/recall_buffer/recall_finding）及底部工具对比表
- system-prompt.md：新增 Layer 3a（State 字段说明 ~300t）、更新 Layer 3+ 和 Layer 6 引用
- event-threads.md：全局替换 event_buffer → raw_event_archive（4 处）
- error-handling.md：删除 recall 工具异常处理和预算分池；新增简化上下文溢出应急
- three-tier-architecture.md：标记 DEPRECATED（保留作为设计演进记录）

## 参与讨论
Hang Li