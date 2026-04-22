/**
 * camie-tagger JSブリッジモジュール
 *
 * Python永続プロセスとJSON-lineプロトコルで通信し、
 * 画像のタグ推論を行う。
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

const PROJECT_ROOT = path.resolve(__dirname, "..");

const DEFAULTS = {
  pythonPath: path.join(PROJECT_ROOT, "camie-tagger-v2", "venv", "Scripts", "python.exe"),
  modelPath: path.join(PROJECT_ROOT, "camie-tagger-v2", "camie-tagger-v2.onnx"),
  metadataPath: path.join(PROJECT_ROOT, "camie-tagger-v2", "camie-tagger-v2-metadata.json"),
  scriptPath: path.join(PROJECT_ROOT, "src", "infer.py"),
  threshold: 0.35,
  topK: 50,
  initTimeout: 120_000,
};

function resolveTaggerPaths(repoPath) {
  if (!repoPath) {
    return {
      pythonPath: DEFAULTS.pythonPath,
      modelPath: DEFAULTS.modelPath,
      metadataPath: DEFAULTS.metadataPath,
    };
  }

  const resolvedRepoPath = path.resolve(repoPath);
  return {
    pythonPath: path.join(resolvedRepoPath, "venv", "Scripts", "python.exe"),
    modelPath: path.join(resolvedRepoPath, "camie-tagger-v2.onnx"),
    metadataPath: path.join(resolvedRepoPath, "camie-tagger-v2-metadata.json"),
  };
}

class CamieTagger {
  constructor(options = {}) {
    this._opts = { ...DEFAULTS, ...options };
    this._process = null;
    this._rl = null;
    this._ready = false;
    this._readyInfo = null;
    this._initPromise = null;
    this._requestCounter = 0;
    this._pendingRequests = new Map();
  }

  get isReady() {
    return this._ready;
  }

  get readyInfo() {
    return this._readyInfo;
  }

  async initialize() {
    if (this._ready) {
      return this._readyInfo;
    }
    if (this._initPromise) {
      return this._initPromise;
    }
    this._initPromise = this._doInitialize();
    try {
      return await this._initPromise;
    } catch (err) {
      this._initPromise = null;
      throw err;
    }
  }

  async _doInitialize() {
    const checks = [
      { path: this._opts.pythonPath, label: "Python実行ファイル" },
      { path: this._opts.modelPath, label: "ONNXモデル" },
      { path: this._opts.metadataPath, label: "メタデータ" },
      { path: this._opts.scriptPath, label: "推論スクリプト" },
    ];
    for (const { path: p, label } of checks) {
      if (!fs.existsSync(p)) {
        throw new Error(`${label}が見つかりません: ${p}`);
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._kill();
        reject(new Error(`初期化タイムアウト (${this._opts.initTimeout / 1000}秒)`));
      }, this._opts.initTimeout);

      this._process = spawn(
        this._opts.pythonPath,
        [this._opts.scriptPath, this._opts.modelPath, this._opts.metadataPath],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );

      this._process.stderr.on("data", (data) => {
        const msg = data.toString("utf-8").trim();
        if (msg) {
          console.log(msg);
        }
      });

      this._rl = readline.createInterface({ input: this._process.stdout });

      this._rl.on("line", (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          console.log(`[tagger.js] JSONパース失敗: ${line}`);
          return;
        }

        if (msg.status === "ready" && !this._ready) {
          this._ready = true;
          this._readyInfo = msg;
          clearTimeout(timeout);
          resolve(msg);
          return;
        }

        if (msg.status === "error" && !this._ready) {
          clearTimeout(timeout);
          this._kill();
          reject(new Error(`初期化エラー: ${msg.error}`));
          return;
        }

        const requestId = msg.request_id;
        if (requestId != null && this._pendingRequests.has(requestId)) {
          const { resolve: res, reject: rej } = this._pendingRequests.get(requestId);
          this._pendingRequests.delete(requestId);

          if (msg.status === "ok") {
            res(msg);
          } else {
            rej(new Error(msg.error || "推論エラー"));
          }
        }
      });

      this._process.on("close", (code) => {
        clearTimeout(timeout);
        const wasReady = this._ready;
        this._ready = false;
        this._initPromise = null;

        for (const [, { reject: rej }] of this._pendingRequests) {
          rej(new Error(`Pythonプロセスが終了しました (code=${code})`));
        }
        this._pendingRequests.clear();

        if (!wasReady) {
          reject(new Error(`Pythonプロセスが異常終了しました (code=${code})`));
        }
      });

      this._process.on("error", (err) => {
        clearTimeout(timeout);
        this._kill();
        reject(new Error(`Pythonプロセス起動失敗: ${err.message}`));
      });
    });
  }

  async infer(imagePath, opts = {}) {
    if (!this._ready) {
      throw new Error("初期化されていません。先にinitialize()を呼んでください。");
    }

    const requestId = String(++this._requestCounter);
    const request = {
      command: "infer",
      image_path: imagePath,
      request_id: requestId,
      threshold: opts.threshold ?? this._opts.threshold,
      top_k: opts.topK ?? this._opts.topK,
    };

    return new Promise((resolve, reject) => {
      this._pendingRequests.set(requestId, { resolve, reject });
      this._send(request);
    });
  }

  async inferBatch(imagePaths, opts = {}) {
    const results = [];

    for (let i = 0; i < imagePaths.length; i++) {
      const imgPath = imagePaths[i];
      try {
        const res = await this.infer(imgPath, opts);
        const entry = {
          path: imgPath,
          tags: res.tags,
          inference_time_ms: res.inference_time_ms,
        };
        results.push(entry);

        if (opts.onProgress) {
          opts.onProgress(i + 1, imagePaths.length, entry);
        }
      } catch (err) {
        const entry = { path: imgPath, error: err.message };
        results.push(entry);

        if (opts.onProgress) {
          opts.onProgress(i + 1, imagePaths.length, entry);
        }
      }
    }

    return results;
  }

  async shutdown() {
    if (!this._process) {
      return;
    }

    if (this._ready) {
      this._send({ command: "shutdown" });
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._kill();
        resolve();
      }, 5000);

      this._process.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  _send(obj) {
    if (this._process && this._process.stdin.writable) {
      this._process.stdin.write(JSON.stringify(obj) + "\n");
    }
  }

  _kill() {
    if (this._process) {
      try {
        this._process.kill();
      } catch {
      }
      this._process = null;
      this._rl = null;
      this._ready = false;
    }
  }
}

module.exports = CamieTagger;
module.exports.DEFAULTS = DEFAULTS;
module.exports.resolveTaggerPaths = resolveTaggerPaths;
