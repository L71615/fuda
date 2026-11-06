# 浮答（fuda）

浮答是一款 Windows 桌面端的面试悬浮助手：按 `Ctrl+E` 呼出一个小窗，按 `Ctrl+D` 截屏提问，答案以“要点卡”的形式流式输出；窗口对常见截屏/录屏工具不可见，适合在模拟面试、面谈练习或复盘时放在屏幕角落。

- **本地运行**：没有账号、订阅和后端，模型用你自己的 OpenAI 兼容接口
- **要点卡**：一句话结论（60 字内）+ 可折叠细节 + 3 个预测追问
- **救场**：按 `Ctrl+Alt+S`，把当前问题换成更短、更稳的回答
- **工作台**：简历 / 岗位 / 资料库三栏，PDF、DOCX 导入后按 450 字切片本地检索
- **听题**：Windows 系统声音回环，5 秒切片转写，字幕和文字实时进输入框；系统声音不可用时自动回退麦克风
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

## 听题

把模式切到「听题」，点标题栏的麦克风按钮开始；再点一次停止。悬浮窗隐藏后仍会继续听。

1. 优先采集 Windows 的系统扬声器输出（loopback），戴耳机也能听到面试官的声音；系统声音不可用时自动回退到默认麦克风。
2. 每 5 秒切一个 16 kHz 单声道 WAV 片段，调用 OpenAI 兼容的 `/audio/transcriptions` 转写；结果实时追加到输入框，并显示在输入框上方的字幕条里。按 `Enter` 发送给模型。
3. 设置页「语音转写（听题）」可以单独配置 ASR 接口、API Key、模型和语言；留空则沿用上方的聊天配置。本地 whisper.cpp / faster-whisper 提供的 OpenAI 兼容端口也可以直接填。如果聊天服务本身没有 `/audio/transcriptions`（例如部分 DeepSeek / Kimi 端点），需要在设置里单独填一个 ASR 接口。
4. 完全静音的片段不会发请求；停止时会补发最后一段。转写失败的片段不会阻塞后面的片段。

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
- 听题会采集系统正在播放的声音（或麦克风），在本机切成片段后发送到你配置的 ASR 服务；不会保存或上传完整录音。

## 已知限制

- 仅支持 Windows 10/11 x64；其他平台需要在 `stealth.js` 和启动脚本上另行适配。
- 隐身依赖 Electron 内容保护和 `SetWindowDisplayAffinity`，对部分硬件采集、外接采集卡、手机拍摄等方式不生效。
- 没有安装包、代码签名和自动更新；`dist/` 是绿色版目录。
- 全局快捷键是系统级的，可能和其他软件冲突；程序会自动降级到备用组合。
- 托盘图标依赖 Windows Explorer；Explorer 重启后需要重新呼出一次。
- 截屏问答需要模型支持图片输入；纯文本模型只能处理文字提问。
- 听题的系统声音回环仅 Windows 可用；其他平台会回退麦克风。部分受保护音频、独占模式声卡或虚拟声卡可能采不到系统声音。
- 听题目前是固定 5 秒切片，没有说话人分离和自动断句；长句子可能被切在词中间。
- 听题不会自动发送，转写结果进入输入框后由你确认再按 `Enter`。

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
