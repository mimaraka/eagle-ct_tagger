const fs = require("fs");
const path = require("path");

const SETTINGS_KEY = "eagle-ct-classifier.settings";
const TAG_GROUP_NAME = "Camie Tagger";
const TAG_PREFIX = "CT/";
const DEFAULT_CATEGORIES = ["general", "character", "copyright", "artist", "meta"];
const SUPPORTED_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "bmp",
  "gif",
  "avif",
  "tif",
  "tiff",
]);

let pluginContext = null;
let isRunning = false;
let CamieTagger = null;
let resolveTaggerPaths = null;

const elements = {
  repoPathInput: document.getElementById("repoPathInput"),
  thresholdInput: document.getElementById("thresholdInput"),
  topKInput: document.getElementById("topKInput"),
  categoryGeneral: document.getElementById("categoryGeneral"),
  categoryCharacter: document.getElementById("categoryCharacter"),
  categoryCopyright: document.getElementById("categoryCopyright"),
  categoryArtist: document.getElementById("categoryArtist"),
  categoryMeta: document.getElementById("categoryMeta"),
  browseRepoButton: document.getElementById("browseRepoButton"),
  saveSettingsButton: document.getElementById("saveSettingsButton"),
  runButton: document.getElementById("runButton"),
  selectionCount: document.getElementById("selectionCount"),
  statusTitle: document.getElementById("statusTitle"),
  statusText: document.getElementById("statusText"),
  statusCard: document.getElementById("statusCard"),
  progressBar: document.getElementById("progressBar"),
  logOutput: document.getElementById("logOutput"),
};

function readSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error(error);
    return {};
  }
}

function writeSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function currentSettings() {
  const categories = [
    elements.categoryGeneral,
    elements.categoryCharacter,
    elements.categoryCopyright,
    elements.categoryArtist,
    elements.categoryMeta,
  ]
    .filter((element) => element.checked)
    .map((element) => element.value);

  return {
    repoPath: elements.repoPathInput.value.trim(),
    threshold: Number(elements.thresholdInput.value),
    topK: Number(elements.topKInput.value),
    categories,
  };
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  elements.logOutput.textContent += `\n[${timestamp}] ${message}`;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function setStatus(mode, title, text) {
  elements.statusCard.className = `status-card ${mode}`;
  elements.statusTitle.textContent = title;
  elements.statusText.textContent = text;
}

function setProgress(percent) {
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function setRunningState(running) {
  isRunning = running;
  elements.runButton.disabled = running;
  elements.browseRepoButton.disabled = running;
  elements.saveSettingsButton.disabled = running;
}

function normalizeTagName(tag) {
  return `${TAG_PREFIX}${String(tag).trim()}`;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function isFiniteThreshold(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteTopK(value) {
  return Number.isInteger(value) && value > 0;
}

function validateSettings(settings) {
  if (!settings.repoPath) {
    throw new Error("camie-tagger リポジトリパスを指定してください。");
  }
  if (!isFiniteThreshold(settings.threshold)) {
    throw new Error("閾値は 0 から 1 の範囲で指定してください。");
  }
  if (!isFiniteTopK(settings.topK)) {
    throw new Error("カテゴリごとの最大タグ数は 1 以上の整数で指定してください。");
  }
  if (!Array.isArray(settings.categories) || settings.categories.length === 0) {
    throw new Error("少なくとも 1 つのタグカテゴリを選択してください。");
  }
}

function validateTaggerPaths(repoPath) {
  if (typeof resolveTaggerPaths !== "function") {
    throw new Error("tagger モジュールが初期化されていません。");
  }

  const resolved = resolveTaggerPaths(repoPath);
  const paths = [
    { label: "Python 実行ファイル", value: resolved.pythonPath },
    { label: "ONNX モデル", value: resolved.modelPath },
    { label: "メタデータ", value: resolved.metadataPath },
  ];

  for (const entry of paths) {
    if (!fs.existsSync(entry.value)) {
      throw new Error(`${entry.label} が見つかりません: ${entry.value}`);
    }
  }

  return resolved;
}

async function browseRepoPath() {
  const result = await eagle.dialog.showOpenDialog({
    title: "camie-tagger リポジトリを選択",
    properties: ["openDirectory"],
  });

  if (!result.canceled && result.filePaths[0]) {
    elements.repoPathInput.value = result.filePaths[0];
  }
}

async function saveSettingsFromForm() {
  const settings = currentSettings();
  validateSettings(settings);
  validateTaggerPaths(settings.repoPath);
  writeSettings(settings);
  appendLog(`設定を保存しました: ${settings.repoPath}`);
  setStatus("success", "設定保存済み", "camie-tagger の実行環境を確認しました。");
}

async function refreshSelectionCount() {
  if (!pluginContext) {
    return;
  }

  try {
    let count = 0;
    if (typeof eagle.item.countSelected === "function") {
      count = await eagle.item.countSelected();
    } else {
      const selectedItems = await eagle.item.getSelected();
      count = selectedItems.length;
    }
    elements.selectionCount.textContent = `選択中 ${count} 件`;
  } catch (error) {
    console.error(error);
  }
}

async function ensureTagGroup(tagNames) {
  if (!pluginContext) {
    throw new Error("プラグインの初期化前です。");
  }

  let groups = await eagle.tagGroup.get();
  let group = groups.find((entry) => entry.name === TAG_GROUP_NAME);

  if (!group) {
    appendLog(`タググループ "${TAG_GROUP_NAME}" を作成します。`);
    await eagle.tagGroup.create({
      name: TAG_GROUP_NAME,
      color: "orange",
      tags: [],
    });

    groups = await eagle.tagGroup.get();
    group = groups.find((entry) => entry.name === TAG_GROUP_NAME);
  }

  if (!group) {
    throw new Error(`タググループ "${TAG_GROUP_NAME}" の取得に失敗しました。`);
  }

  if (tagNames.length > 0) {
    const mergedTags = uniqueStrings([...(group.tags || []), ...tagNames]);

    if (typeof group.addTags === "function") {
      try {
        await group.addTags({ tags: tagNames });
      } catch (error) {
        appendLog(`tagGroup.addTags に失敗したため save() にフォールバックします: ${error.message}`);
        group.tags = mergedTags;
        await group.save();
      }
    } else {
      group.tags = mergedTags;
      await group.save();
    }
  }

  return group;
}

function collectTags(result, allowedCategories) {
  const tags = [];
  for (const [category, categoryTags] of Object.entries(result.tags || {})) {
    if (!allowedCategories.has(category)) {
      continue;
    }
    for (const entry of categoryTags) {
      tags.push(normalizeTagName(entry.tag));
    }
  }
  return uniqueStrings(tags);
}

async function applyTagsToItem(item, tags) {
  item.tags = uniqueStrings([...(item.tags || []), ...tags]);
  await item.save();
}

function getPluginScriptPath() {
  if (!pluginContext?.path) {
    throw new Error("プラグインパスを取得できません。");
  }
  return path.join(pluginContext.path, "src", "infer.py");
}

function createTagger(settings) {
  if (!CamieTagger) {
    throw new Error("tagger モジュールが初期化されていません。");
  }

  const resolved = validateTaggerPaths(settings.repoPath);
  return new CamieTagger({
    ...resolved,
    scriptPath: getPluginScriptPath(),
    threshold: settings.threshold,
    topK: settings.topK,
  });
}

function loadTaggerModule() {
  if (!pluginContext?.path) {
    throw new Error("プラグインパスを取得できません。");
  }

  const taggerModulePath = path.join(pluginContext.path, "src", "tagger.js");
  const taggerModule = require(taggerModulePath);
  CamieTagger = taggerModule;
  resolveTaggerPaths = taggerModule.resolveTaggerPaths;
}

async function getSelectedImageItems() {
  if (!pluginContext) {
    throw new Error("プラグインの初期化前です。");
  }

  const items = await eagle.item.getSelected();
  return items.filter((item) => {
    const ext = String(item.ext || "").toLowerCase();
    return item.filePath && SUPPORTED_EXTENSIONS.has(ext);
  });
}

async function runTagging() {
  if (isRunning) {
    return;
  }

  setRunningState(true);
  setProgress(0);

  try {
    const settings = currentSettings();
    validateSettings(settings);
    writeSettings(settings);
    const allowedCategories = new Set(settings.categories);

    const selectedItems = await getSelectedImageItems();
    await refreshSelectionCount();

    if (selectedItems.length === 0) {
      throw new Error("画像アイテムが選択されていません。PNG/JPG/WebP などを選択してください。");
    }

    setStatus("running", "初期化中", "camie-tagger を起動してモデルを読み込んでいます。");
    appendLog(`${selectedItems.length} 件の画像を処理します。`);

    const tagger = createTagger(settings);
    let totalAppliedTags = 0;
    const allTags = new Set();
    let skippedItems = 0;

    try {
      const readyInfo = await tagger.initialize();
      appendLog(`モデル初期化完了: provider=${readyInfo.provider}, total_tags=${readyInfo.total_tags}`);

      for (let index = 0; index < selectedItems.length; index += 1) {
        const item = selectedItems[index];
        const progressText = `${index + 1}/${selectedItems.length}: ${item.name || path.basename(item.filePath)}`;
        setStatus("running", "解析中", progressText);
        appendLog(`推論開始: ${item.filePath}`);

        let result;
        try {
          result = await tagger.infer(item.filePath, {
            threshold: settings.threshold,
            topK: settings.topK,
          });
        } catch (error) {
          const message = error?.message || String(error);
          if (message.includes("画像が見つかりません")) {
            skippedItems += 1;
            setProgress(((index + 1) / selectedItems.length) * 100);
            appendLog(`スキップ: ${message}`);
            continue;
          }
          throw error;
        }

        const tags = collectTags(result, allowedCategories);
        await applyTagsToItem(item, tags);

        for (const tag of tags) {
          allTags.add(tag);
        }

        totalAppliedTags += tags.length;
        setProgress(((index + 1) / selectedItems.length) * 100);
        appendLog(`推論完了: ${tags.length} タグ追加, ${result.inference_time_ms} ms`);
      }
    } finally {
      await tagger.shutdown().catch((error) => {
        eagle.log.warn(error.stack || String(error));
      });
    }

    await ensureTagGroup([...allTags]);

    setStatus(
      "success",
      "完了",
      `${selectedItems.length} 件を処理し、合計 ${totalAppliedTags} 件の CT タグを適用しました。` +
        (skippedItems > 0 ? ` ${skippedItems} 件は画像未検出のためスキップしました。` : ""),
    );
    appendLog(`タググループ "${TAG_GROUP_NAME}" を同期しました。`);
    await eagle.notification.show({
      title: "Eagle CT Classifier",
      body: `${selectedItems.length} 件のタグ付けが完了しました。`,
      duration: 3000,
      mute: true,
    });
  } catch (error) {
    const message = error?.message || String(error);
    setStatus("error", "エラー", message);
    appendLog(`エラー: ${message}`);
    eagle.log.error(error?.stack || message);
    await eagle.dialog.showErrorBox("Eagle CT Classifier", message);
  } finally {
    setRunningState(false);
    await refreshSelectionCount();
  }
}

function hydrateForm() {
  const settings = readSettings();
  const categories =
    Array.isArray(settings.categories) && settings.categories.length > 0
      ? new Set(settings.categories)
      : new Set(DEFAULT_CATEGORIES);
  if (settings.repoPath) {
    elements.repoPathInput.value = settings.repoPath;
  }
  if (typeof settings.threshold === "number") {
    elements.thresholdInput.value = String(settings.threshold);
  }
  if (typeof settings.topK === "number") {
    elements.topKInput.value = String(settings.topK);
  }
  elements.categoryGeneral.checked = categories.has("general");
  elements.categoryCharacter.checked = categories.has("character");
  elements.categoryCopyright.checked = categories.has("copyright");
  elements.categoryArtist.checked = categories.has("artist");
  elements.categoryMeta.checked = categories.has("meta");
}

function bindEvents() {
  elements.browseRepoButton.addEventListener("click", () => {
    browseRepoPath().catch((error) => {
      eagle.log.error(error.stack || String(error));
    });
  });

  elements.saveSettingsButton.addEventListener("click", () => {
    saveSettingsFromForm().catch(async (error) => {
      const message = error?.message || String(error);
      appendLog(`設定エラー: ${message}`);
      setStatus("error", "設定エラー", message);
      await eagle.dialog.showErrorBox("Eagle CT Classifier", message);
    });
  });

  elements.runButton.addEventListener("click", () => {
    runTagging().catch((error) => {
      eagle.log.error(error.stack || String(error));
    });
  });
}

eagle.onPluginCreate((plugin) => {
  pluginContext = plugin;
  loadTaggerModule();
  elements.logOutput.textContent = "プラグインを初期化しました。";
  hydrateForm();
  bindEvents();
  refreshSelectionCount();
});

eagle.onPluginRun(() => {
  if (!pluginContext) {
    return;
  }
  refreshSelectionCount();
});
