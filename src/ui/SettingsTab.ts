import { App, Notice, Platform, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type KnowledgeWorkbenchPlugin from "../main";
// P1-1：Edge 协议常量/校验是纯函数、零 Node 依赖，手机端设置页可安全引用。
// 切勿改成从 edgeEngine.ts 导入（那会把 crypto / ws 带进移动端加载路径）。
import {
  EDGE_DEFAULT_CHROMIUM_VERSION,
  isValidGecVersionInput,
} from "../speech/edgeProtocol";

/** 功能名 + 控件 + (i) 折叠说明；说明默认隐藏，点 (i) 才展开。 */
function addInfo(setting: Setting, text: string): void {
  const button = setting.infoEl.createEl("button", {
    cls: "kw-info-btn",
    text: "i",
  });
  button.setAttr("type", "button");
  button.setAttr("aria-label", "查看该项说明");
  button.setAttr("aria-expanded", "false");
  const panel = setting.settingEl.createDiv({ cls: "kw-info-panel", text });
  panel.setAttr("hidden", "true");
  button.addEventListener("click", () => {
    const open = !panel.classList.contains("is-open");
    panel.classList.toggle("is-open", open);
    if (open) panel.removeAttribute("hidden");
    else panel.setAttr("hidden", "true");
    button.setAttr("aria-expanded", String(open));
  });
}

export class WorkbenchSettingTab extends PluginSettingTab {
  private readonly plugin: KnowledgeWorkbenchPlugin;
  /** P2-8：音色下拉随 voiceschanged 刷新；display() 重复打开时先退订旧订阅。 */
  private voicesUnsub?: () => void;

  constructor(app: App, plugin: KnowledgeWorkbenchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // 插件卸载时兑底退订，避免设置页最后一次订阅泄漏。
    plugin.register(() => this.voicesUnsub?.());
  }

  display(): void {
    const { containerEl } = this;
    const plugin = this.plugin;
    const settings = plugin.store.settings;
    containerEl.empty();

    // v1.0.6：顶部改为简短定位 + 快速上手，减少「要素养才能用」的门槛。
    containerEl.createDiv({
      cls: "kw-settings-intro",
      // U-6/P0-3：默认离线，朗读是唯一可选联网项（与 manifest / README 口径一致）。
      text: "纯本地 vault 数据：零后端、默认离线，仅朗读可选联网，桌面与手机端一致。点每项右侧的 (i) 看详细说明。",
    });
    const quick = containerEl.createDiv({ cls: "kw-quickstart" });
    quick.createDiv({ cls: "kw-quickstart-title", text: "快速上手 3 步" });
    const ol = quick.createEl("ol", { cls: "kw-quickstart-list" });
    ol.createEl("li", {
      text: "给需要跟踪的笔记加 frontmatter 日期：due（到期）或 review（复习）。",
    });
    ol.createEl("li", {
      text: "在正文任务行写 @due(2026-11-30) 或 @every(每周)，即进入「催办 / 待办」与日历。",
    });
    ol.createEl("li", {
      text: "在下方把 .ics 提醒导入手机 / 桌面系统日历，关掉 Obsidian 也能收到提醒。",
    });

    // 操作结果反馈放在说明区之外，便于区分「配置说明」与「执行结果」。
    const feedback = containerEl.createDiv({ cls: "kw-settings-feedback" });
    feedback.setText("操作结果会显示在这里。");
    // 朗读能力的描述要等异步探测结束后再刷新，声明在前、赋值在控件创建后。
    let refreshSpeechDesc: () => void = () => undefined;
    // U-5：网关就绪状态条的刷新函数，控件创建后再赋值；各配置项 onChange 调用。
    let refreshGatewayStatus: () => void = () => undefined;
    // U-5：联网朗读三条件统一计算，供前置状态条复用，避免状态只藏在页尾。
    const gatewayStatusText = (): { text: string; ready: boolean } => {
      const cfg = plugin.store.settings;
      const engineOk = cfg.speechEngine === "cloud";
      const enableOk = cfg.cloudTtsEnabled;
      const keyOk = Boolean(cfg.cloudTtsUrl.trim() && cfg.cloudTtsKey.trim());
      const ready = engineOk && enableOk && keyOk;
      const mark = (ok: boolean): string => (ok ? "✓" : "✗");
      return {
        ready,
        text: `联网朗读就绪度：引擎 ${mark(engineOk)}（自定义网关） · 开关 ${mark(enableOk)} · 地址/密钥 ${mark(keyOk)} → ${ready ? "可用" : "未就绪"}`,
      };
    };

    // ── 每天用（置顶，不加标题）──────────────────────────────
    const classify = new Setting(containerEl)
      .setName("分类维度")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("tag", "标签")
          .addOption("folder", "文件夹")
          .setValue(settings.classifyBy)
          .onChange((value) => {
            plugin.store.updateSettings({
              classifyBy: value === "folder" ? "folder" : "tag",
            });
            plugin.workbench.recompute();
            feedback.setText("分类维度已更新。");
          }),
      );
    addInfo(
      classify,
      "主分类按标签的第一段或笔记所在的第一层文件夹。逐篇统计不设上限；统计页两个已有卡片的下半部分列表每行带横向条形图，按篇数比例绘制，点名称或条形可展开该分类的笔记清单。",
    );

    const autoInfer = new Setting(containerEl)
      .setName("自动识别任务周期词")
      .setDesc("把「每周复盘」这类带周期词的任务自动算入催办 / 待办。")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.taskAutoInfer)
          .onChange((value) => {
            plugin.store.updateSettings({ taskAutoInfer: value });
            plugin.index.invalidateTaskCache();
            feedback.setText(value ? "已开启周期词自动识别，正在重建索引。" : "已关闭周期词自动识别。");
          }),
      );
    addInfo(
      autoInfer,
      "识别正文任务里的「每天 / 每周 / 每月 / 每季度 / 每年」及 daily / weekly / monthly 等词，按周期推断下次到期。若你的任务里这些词只是叙述而非周期，可关闭以免误报；关闭后只有 @due / @every 标记的任务进入催办 / 待办。",
    );

    const intervals = new Setting(containerEl)
      .setName("艾宾浩斯复习间隔（天，逗号分隔）")
      .addText((text) =>
        text
          .setPlaceholder("1,2,4,7,15,30,60")
          .setValue(settings.reviewIntervals.join(","))
          .onChange((value) => {
            const parsed = value
              .split(/[,，\s]+/)
              .map((part) => Number.parseInt(part, 10))
              .filter((part) => Number.isFinite(part) && part > 0);
            plugin.store.updateSettings({
              reviewIntervals: parsed.length ? parsed : settings.reviewIntervals,
            });
            plugin.workbench.recompute();
          }),
      );
    addInfo(
      intervals,
      "默认 1/2/4/7/15/30/60 天，是艾宾浩斯记忆曲线按整天离散化后的排期。点「开始复习」才加入序列；在今日页点「完成复习」会按当前轮次自动算下次日期并写回。到顶后保持最后一档；修改这里不会改写已有笔记。",
    );

    // ── 索引与备份 ──────────────────────────────────────────
    new Setting(containerEl).setName("索引与备份").setHeading();

    const snapshot = new Setting(containerEl).setName("索引快照");
    addInfo(
      snapshot,
      `vault 内路径：${settings.indexPath}。该文件只存可重建的派生数据（笔记摘要、标签、日期字段），随你既有的同步方案跨端；损坏或版本不符时自动重建。路径在插件启动时读取，修改需要重载插件。差异只做只读提示，不提供 ZIP 恢复，也不删除任何笔记。`,
    );

    const indexOps = new Setting(containerEl)
      .setName("重建索引 / 写入快照")
      .addButton((button) =>
        button.setButtonText("重建索引").onClick(() => {
          plugin.index.rescan();
          feedback.setText("已开始分批重建索引，不阻塞界面。");
        }),
      )
      .addButton((button) =>
        button.setButtonText("写入快照").onClick(() => {
          plugin.index.writeNow();
          feedback.setText("已触发 index.json 写入。");
        }),
      );
    indexOps.settingEl.classList.add("kw-ops-setting");
    addInfo(
      indexOps,
      "重建会分批重新扫描全部 Markdown 文件，每批让出主线程；写入快照会把当前索引落到 vault 内的 index.json。两者都不会修改笔记正文。",
    );

    const writeSummary = new Setting(containerEl)
      .setName("允许写回摘要")
      // U-8 常驻提示：把写回风险从 (i) 提升到默认可见。
      .setDesc("默认关闭；即使开启，也需手动执行命令才会改动笔记 frontmatter。")
      .addToggle((toggle) =>
        toggle.setValue(settings.writeSummaryToFrontmatter).onChange((value) => {
          plugin.store.updateSettings({ writeSummaryToFrontmatter: value });
          feedback.setText(
            value ? "已允许写回摘要，仍需手动执行命令。" : "已关闭摘要写回。",
          );
        }),
      );
    addInfo(
      writeSummary,
      "默认关闭。开启后仍需手动执行「把规则摘要写入笔记 frontmatter」命令，会修改笔记的 kw-summary 字段。规则式摘要本身不改动任何笔记。",
    );

    const writeReview = new Setting(containerEl)
      .setName("允许写回复习日期")
      // U-8 常驻提示：把写回风险从 (i) 提升到默认可见。
      .setDesc("默认关闭；即使开启，也需手动执行命令才会写回复习日期。")
      .addToggle((toggle) =>
        toggle.setValue(settings.writeReviewToFrontmatter).onChange((value) => {
          plugin.store.updateSettings({ writeReviewToFrontmatter: value });
          feedback.setText(
            value ? "已允许写回复习日期，仍需手动执行命令。" : "已关闭复习日期写回。",
          );
        }),
      );
    addInfo(
      writeReview,
      "默认关闭。开启后仍需手动执行「应用复习排期到 frontmatter」命令，会修改到期笔记的 review / review-stage 字段。插件不会自动给全库笔记加提醒。",
    );

    const writeOps = new Setting(containerEl)
      .setName("执行写回操作")
      // U-8 常驻提示：把写回风险从 (i) 提升到默认可见。
      .setDesc("会直接修改你的笔记，操作前请先备份；对应开关未开启时命令会拒绝执行。")
      .addButton((button) =>
        button.setButtonText("应用复习排期").onClick(() => {
          void plugin.applyReviewPlan();
          feedback.setText("已触发复习排期写回，结果见右上角提示。");
        }),
      )
      .addButton((button) =>
        button.setButtonText("写入摘要").onClick(() => {
          void plugin.writeSummaries();
          feedback.setText("已触发摘要写回，结果见右上角提示。");
        }),
      );
    addInfo(
      writeOps,
      "这两个操作会改动用户笔记，请先确认已备份。若对应开关未开启，命令会拒绝执行并给出提示。",
    );

    const dataNote = new Setting(containerEl).setName("数据存放说明");
    addInfo(
      dataNote,
      "业务数据写进笔记 frontmatter（tags / due / status / updated / review）；页签位置、折叠状态、浏览历史与朗读断点存于插件数据。云端表、旧版本地目录句柄与每日轮询均不再使用。",
    );

    // ── .ics 提醒 ───────────────────────────────────────────
    new Setting(containerEl).setName(".ics 提醒").setHeading();

    const icsEnabled = new Setting(containerEl)
      .setName("启用 .ics 提醒文件")
      .addToggle((toggle) =>
        toggle.setValue(settings.icsEnabled).onChange((value) => {
          plugin.store.updateSettings({ icsEnabled: value });
          plugin.workbench.recompute();
          feedback.setText(value ? "已启用 .ics。" : "已关闭 .ics。");
        }),
      );
    addInfo(
      icsEnabled,
      "把逾期、到期、催办、复习与有日期的待办任务写入 vault 内的 .ics，含提前 1 天的 VALARM；无日期的待办不进日历。插件不能常驻后台，最终提醒由系统日历触发；关闭 Obsidian 后不会推送，启动时应用内会有汇总提示。",
    );

    const icsPath = new Setting(containerEl)
      .setName(".ics 路径")
      .addText((text) =>
        text.setValue(settings.icsPath).onChange((value) => {
          plugin.store.updateSettings({ icsPath: value || settings.icsPath });
          plugin.workbench.recompute();
        }),
      );
    addInfo(
      icsPath,
      "默认是「知识管理工作台/提醒.ics」。手机端请把该文件导入或订阅到系统日历；桌面端也可用命令把内容复制到剪贴板。",
    );

    const icsOps = new Setting(containerEl)
      .setName("重建 / 复制 .ics")
      .addButton((button) =>
        button.setButtonText("重建").onClick(() => {
          plugin.workbench.rebuildIcs();
          feedback.setText("已触发 .ics 重建。");
        }),
      )
      .addButton((button) =>
        button.setButtonText("复制").onClick(() => {
          void plugin.copyIcs();
          feedback.setText("已触发复制，结果见右上角提示。");
        }),
      );
    icsOps.settingEl.classList.add("kw-ops-setting");
    addInfo(
      icsOps,
      "重建会立即写入 vault；复制仅在桌面剪贴板可用时生效，不可用时请直接打开 vault 内的 .ics 文件。索引或设置变化后也会自动防抖重建。",
    );

    // ── 朗读 ────────────────────────────────────────────────
    new Setting(containerEl).setName("朗读").setHeading();

    const engine = new Setting(containerEl)
      .setName("朗读引擎")
      .addDropdown((dropdown) => {
        dropdown.addOption("system", "系统语音（离线·零配置）");
        dropdown.addOption("edge", "Edge 神经语音（联网·免费·推荐桌面）");
        dropdown.addOption("cloud", "自定义 TTS 网关（联网·双端·手机推荐）");
        dropdown.setValue(settings.speechEngine).onChange((value) => {
          const next = value === "edge" || value === "cloud" ? value : "system";
          plugin.store.updateSettings({ speechEngine: next });
          void plugin.refreshSpeechEngine().then(() => {
            refreshSpeechDesc();
            refreshGatewayStatus(); // U-5：引擎变化时即时刷新网关就绪状态
            const tips: Record<string, string> = {
              system: "已切换回系统语音。",
              edge:
                "已选择 Edge 神经语音（仅桌面，联网免费）。音色在下方选择；结果见「朗读能力」。",
              cloud:
                "已选择自定义 TTS 网关。手机端请在下方「安卓语音预设」选一个服务商，或手动填写地址与密钥；结果见「朗读能力」。",
            };
            feedback.setText(tips[next]);
          });
        });
      });
    addInfo(
      engine,
      "三种引擎按「易用」优先排序：Edge 神经语音音色最自然、免费、无需密钥、国内可直连，但仅桌面可用（微软接口要求自定义请求头，手机 WebView 做不到）。自定义 TTS 网关可填国内 OpenAI 兼容语音服务，桌面与手机都能用，需自行注册并填密钥——这是安卓端获得与桌面一致神经语音效果的唯一可行方案，下方「安卓语音预设」已预置好国内服务配置。系统语音完全离线、零配置。Edge / 网关仅在你主动选择时才联网，其余功能始终零网络。任一引擎偶发失败会先重试，连续失败才回退系统语音。",
    );

    // Edge 神经语音音色（仅 edge 引擎使用）。
    const edgeVoice = new Setting(containerEl)
      .setName("Edge 音色")
      .addDropdown((dropdown) => {
        for (const [id, label] of [
          ["zh-CN-XiaoxiaoNeural", "晓晓 · 温柔女声（默认）"],
          ["zh-CN-XiaoyiNeural", "晓伊 · 活泼女声"],
          ["zh-CN-YunxiNeural", "云希 · 阳光男声"],
          ["zh-CN-YunjianNeural", "云健 · 浑厚男声"],
          ["zh-CN-YunyangNeural", "云扬 · 专业男声"],
          ["zh-CN-liaoning-XiaobeiNeural", "小北 · 东北话"],
          ["zh-CN-shaanxi-XiaoniNeural", "小妮 · 陕西话"],
        ]) {
          dropdown.addOption(id, label);
        }
        dropdown
          .setValue(settings.edgeVoiceId || "zh-CN-XiaoxiaoNeural")
          .onChange((value) => {
            plugin.store.updateSettings({ edgeVoiceId: value });
            feedback.setText(`Edge 音色已设为：${value}`);
          });
      });
    addInfo(
      edgeVoice,
      "微软 Edge「大声朗读」的神经音色，晓晓最自然通用；方言音色用于趣味朗读。仅在桌面端、且朗读引擎选 Edge 时生效。",
    );

    // P1-1：接口版本热修入口，与 Edge 音色同属「朗读」组，不归入自定义网关。
    // 微软升级 DRM v2 版本串后旧值会返回 403；用户填新版本号即可恢复，无需等插件发版。
    const edgeGec = new Setting(containerEl)
      .setName("Edge 接口版本")
      .setDesc(
        `留空用插件内置版本（${EDGE_DEFAULT_CHROMIUM_VERSION}）；朗读报 403 时填入新版 Edge 的完整版本号即可热修。`,
      )
      .addText((text) =>
        text
          .setPlaceholder(`${EDGE_DEFAULT_CHROMIUM_VERSION}（留空用内置值）`)
          .setValue(settings.edgeGecVersion)
          .onChange((value) => {
            const next = value.trim();
            if (!isValidGecVersionInput(next)) {
              // 不写入非法值，并把输入框回滚到上一次有效值，避免用户误以为已生效。
              // setValue() 不会再次触发 onChange，不会形成递归。
              text.setValue(plugin.store.settings.edgeGecVersion);
              feedback.setText(
                "版本号格式不对：应为 143.0.3650.75 或 2-143.0.3650.75；已保留原设置，请重新填写。",
              );
              return;
            }
            plugin.store.updateSettings({ edgeGecVersion: next });
            void plugin.refreshSpeechEngine().then(() => {
              refreshSpeechDesc();
              feedback.setText(
                next
                  ? `Edge 接口版本已设为 2-${next.replace(/^2-/, "")}，下次朗读生效。`
                  : "已恢复使用插件内置的 Edge 接口版本。",
              );
            });
          }),
      );
    addInfo(
      edgeGec,
      "微软 Edge「大声朗读」接口的 DRM v2 鉴权依赖一个 Chromium 版本串（Sec-MS-GEC-Version）。微软升级 Edge 后旧版本串会被拒绝并返回 403，表现为朗读无声、重试后自动回退系统语音。此时在新版 Edge 地址栏打开 edge://version 查看完整版本号（形如 143.0.3650.75），填到这里即可恢复，不需要等插件发版、也不需要重新打包。只接受「四段数字」或带 2- 前缀的写法，非法输入不会写入设置，引擎侧也会回退内置版本。留空始终使用插件内置版本，不会新增任何联网行为；也可以改用「自定义 TTS 网关」或系统语音。",
    );

    // ── 自定义 TTS 网关（双端联网方案）──────────────────────
    new Setting(containerEl).setName("自定义 TTS 网关").setHeading();

    // 安卓语音预设：把已确认可行的国内 OpenAI 兼容神经 TTS 配置做成可选项，
    // 选中后一次性填好地址 / 模型 / 音色，用户只需补自己的 API 密钥即可。
    // 这些配置来自 2026-11 对国内服务商文档的核对，均为「朗读文本」联网，
    // 不上传 vault / 索引 / 笔记路径。
    const ANDROID_PRESETS: Record<
      string,
      { label: string; url: string; model: string; voice: string; style: string }
    > = {
      cosyvoice: {
        label: "阿里云百炼 · CosyVoice3（推荐）",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech",
        model: "cosyvoice-v3-flash",
        voice: "longanhuan",
        style: "用自然、平和的普通话朗读，按语义断句，疑问句尾音上扬，长句适当停顿。",
      },
      qwen: {
        label: "阿里云百炼 · Qwen-TTS",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech",
        model: "qwen-tts",
        voice: "Cherry",
        style: "用自然、平和的普通话朗读，按语义断句。",
      },
      siliconflow: {
        label: "硅基流动 · CosyVoice2",
        url: "https://api.siliconflow.cn/v1/audio/speech",
        model: "FunAudioLLM/CosyVoice2-0.5B",
        voice: "",
        style: "",
      },
      openai: {
        label: "OpenAI 官方（需海外网络）",
        url: "https://api.openai.com/v1/audio/speech",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        style: "Read naturally in Mandarin with sensible pauses.",
      },
    };
    const androidPreset = new Setting(containerEl)
      .setName("安卓语音预设")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "自定义（手动填写下方各项）");
        for (const [key, preset] of Object.entries(ANDROID_PRESETS)) {
          dropdown.addOption(key, preset.label);
        }
        dropdown.onChange((value) => {
          const preset = ANDROID_PRESETS[value];
          if (!preset) {
            feedback.setText("已切回自定义，请手动填写下方服务地址 / 模型 / 音色。");
            return;
          }
          plugin.store.updateSettings({
            speechEngine: "cloud",
            cloudTtsUrl: preset.url,
            cloudTtsModel: preset.model,
            cloudTtsVoice: preset.voice,
            cloudTtsStyle: preset.style,
            cloudTtsEnabled: true,
          });
          // 预设会覆盖下方文本框，重绘设置页让控件显示新值；用 Notice 反馈，
          // 避免引用重绘后已失效的 feedback 节点。密钥为空时 supported()=false，
          // 不会真正联网，因此自动切到网关引擎是安全的。
          this.display();
          new Notice(
            `已填入「${preset.label}」并切到自定义网关。只需在下方粘贴你的 API 密钥即可朗读。`,
          );
        });
      });
    addInfo(
      androidPreset,
      "安卓 WebView 没有 Node 环境，无法使用需要自定义请求头的 Edge 神经语音；本地 WASM 方案实测音质与兼容性都不达标。因此安卓端要获得与桌面一致的神经语音效果，唯一可行方案是走「自定义 TTS 网关」——把朗读文本发给你自己的国内 OpenAI 兼容语音服务。本下拉预置了已核对可行性的服务商配置（阿里云百炼 CosyVoice3 / Qwen-TTS、硅基流动、OpenAI），选中即自动填好地址、模型与音色，你只需粘贴自己的 API Key。新用户通常有免费额度。仅朗读时联网，不上传 vault / 索引 / 笔记路径，其余功能始终零网络。密钥只存本机 data.json。",
    );

    // U-5：常驻就绪状态条——引擎 / 开关 / 地址密钥三态即时可见，不再只靠页尾「朗读能力」。
    const gatewayStatus = containerEl.createDiv({ cls: "kw-gateway-status" });
    const updateGatewayStatus = (): void => {
      const state = gatewayStatusText();
      gatewayStatus.setText(state.text);
      gatewayStatus.classList.toggle("is-ready", state.ready);
    };
    refreshGatewayStatus = updateGatewayStatus;
    updateGatewayStatus();

    const cloudUrl = new Setting(containerEl)
      .setName("服务地址")
      .addText((text) =>
        text
          .setPlaceholder("https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech")
          .setValue(settings.cloudTtsUrl)
          .onChange((value) => {
            plugin.store.updateSettings({ cloudTtsUrl: value.trim() });
            refreshGatewayStatus(); // U-5：地址变化即时刷新网关就绪状态
          }),
      );
    addInfo(
      cloudUrl,
      "填写 OpenAI /v1/audio/speech 兼容的完整地址。国内推荐：阿里云百炼 CosyVoice（dashscope.aliyuncs.com/compatible-mode/v1/audio/speech，新用户有免费额度、响应快、读音自然）、火山引擎/腾讯/百度同类网关。仅当你把朗读引擎切到「自定义 TTS 网关」且打开下方开关时才会请求该地址。",
    );

    // 清空密钥按钮需要同步密码输入框；两步确认在用户改动输入时复位。
    let cloudKeyInput: TextComponent | undefined;
    let resetClearKeyConfirm: () => void = () => undefined;
    const cloudKey = new Setting(containerEl)
      .setName("API 密钥")
      // U-8/P1-2 常驻提示：把同步盘泄露风险从 (i) 提升到默认可见。
      .setDesc("密钥仅存本机 data.json；若 vault 位于同步盘，data.json 会随之上传，建议使用服务商子密钥或只读密钥。")
      .addText((text) => {
        cloudKeyInput = text;
        text
          .setPlaceholder("sk-...")
          .setValue(settings.cloudTtsKey)
          .onChange((value) => {
            plugin.store.updateSettings({ cloudTtsKey: value.trim() });
            resetClearKeyConfirm(); // 输入变化即撤销待确认的清空操作
            refreshGatewayStatus(); // U-5：密钥变化即时刷新网关就绪状态
          });
        text.inputEl.setAttr("type", "password");
      });
    addInfo(
      cloudKey,
      "填入你在该服务商控制台创建的 API Key，仅保存在本机插件配置（data.json），不会写入笔记或索引。留空则不启用。",
    );

    // 清空密钥：只移除本机保存的 cloudTtsKey，不动地址 / 模型 / 音色 / 引擎 / 开关。
    // 两步确认避免误触；网关 supported() 实时读取配置，密钥清空后立刻不再联网。
    let clearKeyArmed = false;
    new Setting(containerEl)
      .setName("清空已保存的 API 密钥")
      .setDesc(
        "仅从本机 data.json 移除密钥，服务地址、模型、音色与朗读引擎设置保持不变；清空后自定义网关立即不再发起联网请求。",
      )
      .addButton((button) => {
        resetClearKeyConfirm = () => {
          clearKeyArmed = false;
          button.setButtonText("清空密钥");
        };
        button
          .setButtonText("清空密钥")
          .setWarning()
          .onClick(() => {
            if (!plugin.store.settings.cloudTtsKey.trim()) {
              resetClearKeyConfirm();
              feedback.setText("当前没有已保存的 API 密钥，无需清空。");
              new Notice("知识管理工作台：当前未保存 API 密钥");
              return;
            }
            if (!clearKeyArmed) {
              clearKeyArmed = true;
              button.setButtonText("再次点击确认清空");
              feedback.setText("再次点击将把已保存的 API 密钥从本机移除；其它网关配置不受影响。");
              return;
            }
            plugin.store.updateSettings({ cloudTtsKey: "" });
            resetClearKeyConfirm();
            cloudKeyInput?.setValue("");
            refreshGatewayStatus();
            feedback.setText("API 密钥已清空，自定义网关现在不会发起联网请求。");
            new Notice("知识管理工作台：API 密钥已清空");
          });
      });

    const cloudModel = new Setting(containerEl)
      .setName("模型名")
      .addText((text) =>
        text
          .setPlaceholder("cosyvoice-v3-flash")
          .setValue(settings.cloudTtsModel)
          .onChange((value) => {
            plugin.store.updateSettings({ cloudTtsModel: value.trim() });
          }),
      );
    addInfo(
      cloudModel,
      "阿里云百炼示例：cosyvoice-v3-flash / qwen-tts；OpenAI 示例：tts-1 / gpt-4o-mini-tts。按你所选服务的文档填写。",
    );

    const cloudVoice = new Setting(containerEl)
      .setName("音色")
      .addText((text) =>
        text
          .setPlaceholder("longanhuan")
          .setValue(settings.cloudTtsVoice)
          .onChange((value) => {
            plugin.store.updateSettings({ cloudTtsVoice: value.trim() });
          }),
      );
    addInfo(
      cloudVoice,
      "服务要求的 voice 标识。阿里云百炼示例：longanhuan（女）/ longcheng（男）；OpenAI 示例：alloy / nova。",
    );

    const cloudEnable = new Setting(containerEl)
      .setName("启用自定义网关")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.cloudTtsEnabled)
          .onChange((value) => {
            plugin.store.updateSettings({ cloudTtsEnabled: value });
            void plugin.refreshSpeechEngine().then(() => {
              refreshSpeechDesc();
              refreshGatewayStatus(); // U-5：开关变化即时刷新网关就绪状态
              feedback.setText(
                value ? "自定义 TTS 网关已启用（需引擎也切到该项）。" : "自定义 TTS 网关已关闭。",
              );
            });
          }),
      );
    addInfo(
      cloudEnable,
      "双重开关：这里打开 + 上方「朗读引擎」选「自定义 TTS 网关」才会联网。这是本插件仅有的两个联网选项之一，其余功能永远离线。手机端如需朗读，推荐用此项（Edge 神经语音仅桌面可用）。",
    );

    // U-4：把语速等 8 项通用朗读设置从「自定义 TTS 网关」组内拆出，纠正分组归属。
    new Setting(containerEl).setName("朗读（通用）").setHeading();

    const rate = new Setting(containerEl)
      .setName("朗读语速")
      .addText((text) =>
        text
          .setPlaceholder("1")
          .setValue(String(settings.speechRate))
          .onChange((value) => {
            const parsed = Number.parseFloat(value);
            const next = Number.isFinite(parsed) && parsed > 0 ? parsed : settings.speechRate;
            plugin.store.updateSettings({ speechRate: next });
            plugin.speech.setRate(next);
          }),
      );
    addInfo(
      rate,
      "系统语音的基准语速，范围 0.5–3，默认 1。规则式韵律会在此基础上按句群做小幅浮动；改动会立即作用于当前分块。",
    );

    const voice = new Setting(containerEl)
      .setName("中文音色优先")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.speechPreferChineseVoice)
          .onChange((value) => {
            plugin.store.updateSettings({ speechPreferChineseVoice: value });
            plugin.speech.setPreferChineseVoice(value);
          }),
      );
    addInfo(
      voice,
      "优先使用系统里的 zh-CN / zh-* 音色；系统没有中文音色时回退默认音色。朗读前会按当前音色列表重新选择。",
    );

    const autoResume = new Setting(containerEl)
      .setName("打开笔记时自动续读")
      .addToggle((toggle) =>
        toggle.setValue(settings.speechAutoResume).onChange((value) => {
          plugin.store.updateSettings({ speechAutoResume: value });
          feedback.setText(
            value ? "已开启自动续读：有断点时打开原文窗口会自动继续。" : "已关闭自动续读。",
          );
        }),
      );
    addInfo(
      autoResume,
      "默认关闭，避免打开笔记时意外发声。开启后，若该笔记有未读完的断点，原文窗口会自动接着朗读；否则一律手动点「从断点续读」。断点按笔记路径保存，重命名时会自动迁移。",
    );

    const prosody = new Setting(containerEl)
      .setName("自然韵律优化")
      .addToggle((toggle) =>
        toggle.setValue(settings.speechProsody).onChange((value) => {
          plugin.store.updateSettings({ speechProsody: value });
          plugin.speech.setProsody(value);
          feedback.setText(value ? "已开启句群分块、停顿与动态语气。" : "已关闭韵律优化，恢复逐标点分块。");
        }),
      );
    addInfo(
      prosody,
      "句群分块（不再每个逗号都断）、句末停顿、动态语速与音高、Natural / Neural 音色优选。系统语音走参数合成；Edge 神经语音 / 自定义网关为神经网络合成，韵律由模型决定，规则式 pitch 不生效。",
    );

    const pause = new Setting(containerEl)
      .setName("句间停顿上限（毫秒）")
      .addText((text) =>
        text
          .setPlaceholder("420")
          .setValue(String(settings.speechPauseMs))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            const next = Number.isFinite(parsed) && parsed >= 0 ? Math.min(1200, parsed) : settings.speechPauseMs;
            plugin.store.updateSettings({ speechPauseMs: next });
            plugin.speech.setMaxPauseMs(next);
          }),
      );
    addInfo(pause, "每个句群读完后的停顿，按标点动态调整（句号 280ms、疑问 / 感叹 340ms、省略号 420ms），不超过此处上限。设为 0 关闭停顿。");

    const voicePick = new Setting(containerEl)
      .setName("系统音色")
      .addDropdown((dropdown) => {
        // P2-8：系统音色异步就绪（voiceschanged）后自动刷新选项，
        // 不再需要重开设置页才能看到音色。
        let lastVoices = "\u0000";
        const rebuild = (): void => {
          dropdown.selectEl.empty();
          dropdown.addOption("", "自动（中文 / Natural 优先）");
          for (const voice of plugin.speech.listVoices()) {
            dropdown.addOption(voice.name, `${voice.name} · ${voice.lang}`);
          }
          dropdown.setValue(plugin.store.settings.speechVoiceName);
        };
        const refreshVoiceOptions = (): void => {
          const sig = plugin.speech.listVoices().map((voice) => voice.name).join("|");
          if (sig === lastVoices) return;
          lastVoices = sig;
          rebuild();
        };
        rebuild();
        lastVoices = plugin.speech.listVoices().map((voice) => voice.name).join("|");
        this.voicesUnsub?.();
        this.voicesUnsub = plugin.speech.subscribe(() => refreshVoiceOptions());
        dropdown.onChange((value) => {
          plugin.store.updateSettings({ speechVoiceName: value });
          plugin.speech.setManualVoiceName(value);
          feedback.setText(value ? `已固定使用音色：${value}` : "已恢复自动优选音色。");
        });
      });
    addInfo(voicePick, "系统音色列表由设备提供；Android WebView 通常为空。留空时自动挑选 zh-CN 且名字含 Natural / Neural 的高质量音色。");

    const speechState = new Setting(containerEl)
      .setName("朗读能力")
      .addButton((button) =>
        button.setButtonText("停止全部朗读").onClick(() => {
          plugin.speech.stop(true);
          feedback.setText("已停止朗读并保存断点。");
        }),
      );
    const describeSpeech = (): void => {
      const snapshot = plugin.speech.getSnapshot();
      const engine = plugin.store.settings.speechEngine;
      const name =
        engine === "edge"
          ? "Edge 神经语音（桌面·联网免费）"
          : engine === "cloud"
            ? "自定义 TTS 网关（联网）"
            : "系统语音（离线）";
      let detail: string;
      if (engine === "edge") {
        detail = Platform.isMobile
          ? "Edge 神经语音需要自定义请求头，Android 不支持；请用上方「安卓语音预设」配置自定义网关，或用朗读稿交给系统朗读。"
          : snapshot.supported
            ? "Edge 神经语音已就绪，点朗读即联网合成（仅发送当前段落文本）。"
            : "Edge 暂不可用，朗读时会重试，连续失败才回退系统语音。";
      } else if (engine === "cloud") {
        const cfg = plugin.store.settings;
        const ready =
          cfg.cloudTtsEnabled && cfg.cloudTtsUrl.trim() && cfg.cloudTtsKey.trim();
        detail = ready
          ? "自定义网关已配置，点朗读即联网合成（仅发送当前段落文本）。"
          : `网关未就绪：可在上方「安卓语音预设」一键填入配置，再补上 API 密钥（${snapshot.engineDiagnostic ?? "配置不全"}）。`;
      } else {
        detail = snapshot.supported
          ? "系统语音配合规则式韵律，完全离线。"
          : "Android WebView 通常没有系统语音，请使用朗读稿替代路径交给系统朗读。";
      }
      // P1-1 / P1-2：把引擎最近一次失败的可读诊断（Edge 403、网关 401/403 等）
      // 回传到「朗读能力」，用户不必只看到「已回退系统语音」却不知道原因。
      if (snapshot.engineLastError) {
        detail += ` 最近失败：${snapshot.engineLastError}`;
      }
      speechState.setDesc(`当前引擎：${name}（生效：${snapshot.engineLabel}）。${detail}`);
    };
    refreshSpeechDesc = describeSpeech;
    describeSpeech();
    addInfo(
      speechState,
      "朗读在笔记原文窗口顶部控制：朗读 / 暂停 / 停止 / 可拖动进度条，关闭窗口自动保存断点。设备无语音时窗口会提供「复制朗读稿」「保存朗读稿到库内」，可交给系统「随选朗读」。插件卸载或禁用时会 cancel 语音并清除全部定时器。",
    );

    // ── 导出 ────────────────────────────────────────────────
    new Setting(containerEl).setName("导出").setHeading();
    const exportCatalog = new Setting(containerEl)
      .setName("导出笔记目录")
      .setDesc("把所有已索引笔记按主分类生成一份 Markdown 目录，写入 vault。")
      .addButton((button) =>
        button.setButtonText("导出到 vault").onClick(() => {
          void plugin.exportCatalog();
          feedback.setText("已触发笔记目录导出，结果见右上角提示。");
        }),
      );
    addInfo(
      exportCatalog,
      "生成「知识管理工作台/笔记目录.md」：按标签或文件夹（跟随当前分类维度）分组，每条含标题（可点开原文）、标签、日期与摘要。这是可重建的派生文件，每次导出覆盖旧文件，不会改动任何笔记。",
    );

    const manageTags = new Setting(containerEl)
      .setName("批量管理标签")
      .setDesc("重命名或合并标签，一次改掉所有相关笔记。")
      .addButton((button) =>
        button.setButtonText("打开管理器").onClick(() => {
          plugin.openTagManager();
        }),
      );
    addInfo(
      manageTags,
      "选择源标签（可多选做合并）与目标名称，先预览影响篇数，二次确认后分批写入。默认只改 frontmatter.tags，不碰正文内联 #标签；层级标签可选是否一并处理。",
    );

    // ── 关于 ────────────────────────────────────────────────
    new Setting(containerEl).setName("关于").setHeading();
    const about = new Setting(containerEl).setName("数据与隐私");
    about.setDesc(
      "默认纯本地：零后端、默认离线，笔记与提醒都留在你的 vault。唯一例外是朗读：当你主动选择 Edge 神经语音或自定义 TTS 网关时，才会把「当前这一块朗读文本 + 音色」发往对应语音服务，不上传 vault、索引、笔记路径或任何其它内容。",
    );
    addInfo(
      about,
      "Edge 神经语音为微软免费的大声朗读接口（桌面可用）；自定义网关是你自己填写的 OpenAI 兼容服务（桌面与手机可用，需密钥）。两者默认都关闭，且只有朗读页签用到，其余功能（索引、快照、.ics、标签、复习等）永远离线。Android WebView 通常无系统语音，手机端推荐「自定义 TTS 网关」或用原文窗口的「复制 / 保存朗读稿」交给系统「随选朗读」。",
    );

    containerEl.createDiv({
      cls: "kw-ver",
      // U-6/P0-3：版本栏不再宣称绝对"零网络请求"。
      text: `知识管理工作台 v${plugin.manifest.version} · 默认离线，朗读可选联网`,
    });
  }
}
