# 如何用 Python 做数据分析

> **来源**：https://chat.deepseek.com/a/chat/s/test-conversation-id
> 
> **模型**：DeepSeek
> 
> **导出时间**：2026-09-26 02:40
> 
> **消息数**：4　|　**思考过程**：已排除

---

## 用户

帮我用 Python 做一份销售数据分析，顺便讲讲思路。

---

## DeepSeek

### 整体思路

分三步：**读取**、*清洗*、`聚合`。

- 读取：`pd.read_csv`
- 清洗：处理缺失值

```python
import pandas as pd
df = pd.read_csv("sales.csv")
print(df.head())
```

| 步骤 | 工具 |
| --- | --- |
| 读取 | pandas |
| 绘图 | matplotlib |

公式示例：$E = mc^2$

参考 [官方文档](https://pandas.pydata.org/)。

> 提示：先看分布再建模。

---

## 用户

再帮我看看异常值怎么处理？

---

## DeepSeek

常见做法有三种：Z-Score、IQR、以及基于模型的检测。

其中 IQR 最稳健。