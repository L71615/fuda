# 浮答（fuda）

浮答是一款 Windows 桌面端的面试悬浮助手：按 `Ctrl+E` 呼出一个小窗，按 `Ctrl+D` 截屏提问，答案以“要点卡”的形式流式输出；窗口对常见截屏/录屏工具不可见，适合在模拟面试、面谈练习或复盘时放在屏幕角落。

- **本地运行**：没有账号、订阅和后端，模型用你自己的 OpenAI 兼容接口
- **要点卡**：一句话结论（60 字内）+ 可折叠细节 + 3 个预测追问
- **救场**：按 `Ctrl+Alt+S`，把当前问题换成更短、更稳的回答
- **工作台**：简历 / 岗位 / 资料库三栏，PDF、DOCX 导入后按 450 字切片本地检索
- **隐身四层**：Electron 内容保护 + Win32 显示亲和 + 扩展窗口样式 + 置顶/全工作区
- **任意兼容模型**：OpenAI / DeepSeek / Kimi / 硅基流动 / 本机 Ollama / 自定义端点

## 环境

- Windows 10/11 x64
- Node.js 18+
- 打包需要 .NET Framework 4.x（Windows 自带 `csc.exe`）

## 运行

```bash
npm install
npm run get-electron   # 下载 Electron 33.2.1 到 runtime/，约 115 MB
npm start
```

`npm run get-electron` 只下载一次，之后可以离线运行。也可以自己准备 Electron 33.2.1 的 `win32-x64` 运行时，解压到 `runtime/`。

首次启动会先打开工作台。点右上角齿轮，选择服务商并填写：

- `Endpoint`：例如 `https://api.openai.com/v1`、`https://api.deepseek.com/v1`、`http://127.0.0.1:11434/v1`
- `API Key`：本机 Ollama 可留空
- `模型名`：例如 `gpt-4o-mini`、`deepseek-chat`、`qwen2.5:7b`

配置、对话记录和窗口位置都写在程序同级的 `.user-data/` 目录，不会上传到任何中转服务器。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+E` | 显示 / 隐藏悬浮窗 |
| `Ctrl+D` | 截屏提问 |
| `Ctrl+Alt+S` | 救场：生成“承认 + 迁移 + 求教”的短回答 |
| `Ctrl+Shift+R` | 清空当前对话 |
| `Ctrl+Shift+X` | 鼠标穿透开 / 关 |
| `Ctrl+Shift+↑ / ↓ / ← / →` | 移动窗口 |
| `Ctrl+Shift+= / -` | 放大 / 缩小界面 |
| `Ctrl+Shift+] / [` | 提高 / 降低不透明度 |
| `Ctrl+Alt+Q` | 退出 |

全局快捷键被其他程序占用时，会自动尝试 `Ctrl+Alt+<键>` 或 `Ctrl+Shift+Alt+<键>` 作为备用。

## 资料库

工作台的“资料库”支持导入 PDF 和 DOCX：

1. 文本在本地提取，按约 450 字切片；
2. 提问时在本地做关键词检索，只把命中的片段作为上下文发给模型；
3. 原始文件和完整文本留在本机，不会整份上传。

## 开发与测试

```bash
npm run check       # 语法检查 + 渲染层 id / 脚本 / preload 通道一致性
npm run test:core   # 主进程纯逻辑测试
npm run test:ipc    # IPC 通道测试
npm run dist        # 生成 dist/fuda-win32-x64/
```

`npm run dist` 会依次生成图标、编译启动器、组装 `app.asar`。首次打包如果缺少 Electron 缓存，先执行 `npm run get-electron`。

目录结构：

```text
src/
  main/
    index.js      窗口、工作台、托盘、热键、IPC、启动日志
    stealth.js    隐身四层与 Win32 读回
    llm.js        OpenAI 兼容流式客户端
    extract.js    PDF / DOCX 文本提取
    profile.js    简历、岗位、资料库与本地切片检索
    store.js      设置、记录、默认值
    icon.js       图标生成
  preload/
    index.js      contextBridge 白名单
  renderer/
    index.html    悬浮窗
    setup.html    工作台
    app.js        悬浮窗逻辑
    setup.js      工作台逻辑
    style.css
    setup.css
tools/            构建、检查、测试、CDP 验证脚本
```

## 隐私

- 没有中转后端；请求直接从本机发到你填写的 `Endpoint`。
- API Key、对话记录、简历和资料库都保存在本机 `.user-data/`，该目录已加入 `.gitignore`。
- 截屏提问时，截图会作为图片内容发给你配置的模型服务；不需要视觉能力时可以不按 `Ctrl+D`。
- 资料库检索在本地完成，只发送命中的文本片段。

## 已知限制

- 仅支持 Windows 10/11 x64；其他平台需要在 `stealth.js` 和启动脚本上另行适配。
- 隐身依赖 Electron 内容保护和 `SetWindowDisplayAffinity`，对部分硬件采集、外接采集卡、手机拍摄等方式不生效。
- 没有安装包、代码签名和自动更新；`dist/` 是绿色版目录。
- 全局快捷键是系统级的，可能和其他软件冲突；程序会自动降级到备用组合。
- 托盘图标依赖 Windows Explorer；Explorer 重启后需要重新呼出一次。
- 截屏问答需要模型支持图片输入；纯文本模型只能处理文字提问。

## 许可

MIT，见 [LICENSE](LICENSE)。

第三方组件：

| 组件 | 版本 | 许可 |
| --- | --- | --- |
| Electron | 33.2.1 | MIT |
| koffi | 2.16.2 | MIT |
| mammoth | 1.8.0 | BSD-2-Clause |
| pdfjs-dist | 3.11.174 | Apache-2.0 |
| @electron/packager | 20.3.0 | BSD-2-Clause（仅构建期） |

二进制发行时请保留 `resources/app.asar` 内的第三方许可文件，以及 `dist/` 根目录的 Electron `LICENSE` 和 `LICENSES.chromium.html`。
