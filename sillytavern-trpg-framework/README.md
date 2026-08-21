# TRPG Framework (SillyTavern 扩展)

一个为 SillyTavern 打造的可模块化桌游 RPG 框架扩展。参考
[Multihog D&D Framework](https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework)
的设计理念（State Tracker / 混合 RNG / Lorebook Agent / 世界推进），用更精简、
易读的代码重新实现，并严格遵循 SillyTavern 第三方扩展格式。

## 功能

- **RPG 状态追踪器 (State Tracker)**
  - 每个聊天独立的角色卡：姓名 / 种族 / 职业 / 等级 / HP / 临时 HP / XP / 金币 /
    背包 / 法术位 / 增益与状态 / 笔记。
  - 助手回复后自动运行第二次 LLM pass，从剧情中提取状态增量（扣血、拾取、经验等），
    以 JSON delta 合并进角色卡，并生成纯文本 **State Memo**。
  - 可手动编辑、随机生成角色、导入 / 导出 JSON、Raw View 直接改 JSON。
- **混合 RNG 系统 (Hybrid RNG)**
  - **确定性骰子队列**：每回合把预置种子的 d20 / d100 队列注入提示词，战斗流畅且可复现。
  - **工具调用骰子**：注册 `roll_dice` 函数工具，模型必须先声明 DC 再掷骰（防"剧情需要"）。
  - `/roll` 斜杠命令：`/roll 2d6+3`、`/roll 1d20`、`/roll 2d20kh1`（优势）等。
- **Lorebook Agent（长期记忆）**
  - 按设定频率运行 LLM pass，阅读近期剧情与已有条目，自动 **新建 / 更新 / 删除**
    世界信息条目，写入专属 lorebook（默认 `<聊天名>_lore`）。
- **提示词注入 (Prompt Injection)**
  - 每回合在用户输入前注入 `RNG 队列` + `State Memo`（可配置注入位置），
    让叙事模型始终掌握"当前机械事实"。
  - 可选世界时钟 `[TIME] Day N, HH:MM`，随真实游玩时间推进。
- **面板与设置**：扩展菜单（魔杖）按钮呼出浮动角色面板；设置抽屉逐项开关。

## 安装

方式一（推荐，第三方扩展菜单安装）：

1. 打开 SillyTavern，进入 **扩展 (Extensions)** 菜单。
2. 点击顶部 **Install extension**。
3. 输入本仓库 URL（或本目录的 Git 仓库地址），安装。
4. 刷新页面，在扩展菜单中找到 **TRPG Framework**。

方式二（手动拷贝）：

1. 把整个 `sillytavern-trpg-framework` 文件夹复制到
   `SillyTavern/public/scripts/extensions/third-party/` 下。
2. 刷新页面。

> 注意：本扩展通过 `manifest.json` 的 `generate_interceptor` 字段注册了
> `rpgTrackerInterceptor` 全局拦截器，请勿修改该字段。

## 快速上手

1. 在右侧面板选择 **Fantasy / Modern / Sci-Fi**，点击 **Random Character** 生成角色，
   或手动填写角色卡；也可以粘贴已有角色卡到 **Raw View** 再点 Import。
2. （推荐）开启 **State Tracker** 与 **Lorebook Agent** 设置；需要主 API 支持
   `generateRaw`（大多数 OpenAI 兼容 API 均可）。
3. 正常开始 RP。每次助手回复后扩展会自动：
   - 运行 State Tracker 更新角色卡与 State Memo；
   - 按频率运行 Lorebook Agent 维护世界信息。
4. 在聊天里用 `/roll 2d6+3` 掷骰；叙事模型可在需要时调用 `roll_dice` 工具。

### Lorebook 生效

Lorebook Agent 创建的条目存放在一个独立的世界信息书（默认 `<聊天名>_lore`）中。
要让关键词自动激活生效：

- 点面板 **Attach Lore** 自动挂载（较新版本 ST 支持），
- 或在 **世界信息 (World Info)** 编辑器里把该书设为当前聊天激活，
  并确保启用 **关键词激活 (Keyword Activation)**。

## 设置说明

| 设置 | 说明 |
| --- | --- |
| Enable TRPG Framework | 总开关 |
| State Tracker | 助手回复后运行状态提取 LLM pass；`Run every N` 控制频率 |
| Prompt Injection | 是否向出站提示注入 State Memo 及其位置（In chat / At top / None） |
| Hybrid RNG | 确定性骰子队列（d20/d100）、队列长度、`roll_dice` 工具、仅战斗注入队列 |
| Lorebook Agent | 长期记忆 LLM pass 频率、lorebook 书名、最大 token |
| World Clock | 可选 `[TIME]` 注入与世界时间流速（每个真实分钟 = N 个世界分钟） |

## 开发与测试

纯逻辑模块（骰子引擎、状态模型、JSON 提取）不依赖浏览器，可用 Node 内置测试运行：

```bash
cd sillytavern-trpg-framework
npm test        # 等价于 node --test tests/
```

## 目录结构

```
sillytavern-trpg-framework/
├── manifest.json          # SillyTavern 扩展清单（含 generate_interceptor）
├── index.js               # 入口：注册面板、命令、工具、事件
├── style.css              # 面板与设置样式
├── src/
│   ├── settings.js        # 设置读写 + 每聊天状态持久化
│   ├── chat-state.js      # 角色卡模型、State Memo、随机角色（纯逻辑）
│   ├── dice.js            # 骰子公式解析与掷骰引擎（纯逻辑）
│   ├── rng.js             # RNG 队列、/roll 命令、roll_dice 工具
│   ├── llm.js             # generateRaw 封装 + 稳健 JSON 提取
│   ├── tracker.js         # State Tracker LLM pass
│   ├── lorebook.js        # Lorebook Agent + 世界信息 API
│   ├── interceptor.js     # 提示词注入拦截器（全局 rpgTrackerInterceptor）
│   └── ui.js              # 浮动面板 + 设置 UI
└── tests/                 # Node 内置测试
```

## License

GPL-3.0（与参考项目一致的精神：自由软件）。本扩展为独立实现，未复制参考项目代码。

