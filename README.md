# dsh-data-ledger 数据管理

统一查看 DSH 本地数据的来源、位置与内容摘要；支持回收站式删除、复制路径、资源管理器定位、浏览器本地存储查看与清除；内置 AI 管家工具（ledger_*）。

- 右侧「数据管理」按钮 → 滑出面板：对话 / 数据文件 / 技能 / 记忆库 / 日志 / 回收站 / 浏览器存储 / 只读参考；点面板外任意处自动收回
- 删除一律先进回收站（`~/.dsh/trash/`，默认保留 30 天），可恢复；彻底删除需双重确认
- 凭据类文件只显示位置与大小，永不显示内容
- 零第三方依赖、无网络请求；卸载 `dsh plugin --profile web remove dsh-data-ledger` 即恢复原状

## 配置（cordis.patch.yml 内 `data-ledger` 行）

| 字段 | 默认 | 说明 |
|---|---|---|
| enabled | true | 启用开关 |
| trashDays | 30 | 回收站保留天数 |
| refreshSeconds | 20 | 面板自动刷新间隔（秒） |

## 开发自测

```sh
node test/smoke.mjs   # 盘点 + 回收站全流程 + 路径校验（独立于 DSH 运行）
```
