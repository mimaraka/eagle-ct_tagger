#!/usr/bin/env python3
"""
camie-tagger 推論サーバー

JSON-lineプロトコルでstdin/stdoutを通じて通信する永続プロセス。
モデルを一度だけ読み込み、複数画像の推論リクエストを順次処理する。

使い方:
    python infer.py <model_path> <metadata_path>
"""

import sys
import os
import json
import time
import traceback

import numpy as np


def setup_utf8():
    """stdin/stdoutのUTF-8エンコーディングを明示的に設定（日本語パス対応）"""
    if sys.platform == "win32":
        import io
        sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)


def log(msg):
    """stderrにログ出力（stdoutはJSON-line通信専用）"""
    print(f"[infer.py] {msg}", file=sys.stderr, flush=True)


def send(obj):
    """stdoutにJSON-lineを送信"""
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def load_metadata(path):
    """メタデータJSONを読み込み、idx_to_tag / tag_to_category / img_size を返す"""
    with open(path, "r", encoding="utf-8") as f:
        metadata = json.load(f)

    dataset_info = metadata["dataset_info"]
    tag_mapping = dataset_info["tag_mapping"]
    idx_to_tag = tag_mapping["idx_to_tag"]
    tag_to_category = tag_mapping["tag_to_category"]
    total_tags = dataset_info["total_tags"]
    img_size = metadata["model_info"]["img_size"]

    return idx_to_tag, tag_to_category, total_tags, img_size


def _register_cuda_dll_dirs():
    """venv内のnvidia pipパッケージからCUDA DLLディレクトリをPATHに追加する（Windows専用）"""
    if sys.platform != "win32":
        return

    site_packages = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
    if not os.path.isdir(site_packages):
        return

    dll_dirs = []
    for pkg in os.listdir(site_packages):
        bin_dir = os.path.join(site_packages, pkg, "bin")
        if os.path.isdir(bin_dir):
            dll_dirs.append(bin_dir)

    if dll_dirs:
        os.environ["PATH"] = os.pathsep.join(dll_dirs) + os.pathsep + os.environ.get("PATH", "")
        log(f"CUDA DLLディレクトリ {len(dll_dirs)}件をPATHに追加")


def create_session(model_path):
    """ONNXセッションを作成（CUDA優先、CPUフォールバック）"""
    _register_cuda_dll_dirs()
    import onnxruntime as ort

    providers = []
    if ort.get_device() == "GPU":
        providers.append("CUDAExecutionProvider")
    providers.append("CPUExecutionProvider")

    session = ort.InferenceSession(model_path, providers=providers)
    active_provider = session.get_providers()[0]
    input_name = session.get_inputs()[0].name

    return session, input_name, active_provider


def preprocess_image(image_path, img_size):
    """
    画像を前処理する。
    PIL読み込み → RGB変換 → アスペクト比維持リサイズ(LANCZOS)
    → ImageNet mean色パディング → ImageNet正規化 → numpy配列
    """
    import torchvision.transforms as transforms
    from PIL import Image

    transform = transforms.Compose([
        transforms.ToTensor(),
        transforms.Normalize(
            mean=[0.485, 0.456, 0.406],
            std=[0.229, 0.224, 0.225],
        ),
    ])

    with Image.open(image_path) as img:
        if img.mode != "RGB":
            img = img.convert("RGB")

        width, height = img.size
        aspect_ratio = width / height

        if aspect_ratio > 1:
            new_width = img_size
            new_height = int(new_width / aspect_ratio)
        else:
            new_height = img_size
            new_width = int(new_height * aspect_ratio)

        new_width = max(new_width, 1)
        new_height = max(new_height, 1)

        img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

        pad_color = (124, 116, 104)
        padded = Image.new("RGB", (img_size, img_size), pad_color)
        paste_x = (img_size - new_width) // 2
        paste_y = (img_size - new_height) // 2
        padded.paste(img, (paste_x, paste_y))

        tensor = transform(padded)
        return tensor.unsqueeze(0).numpy()


def run_inference(session, input_name, img_array, idx_to_tag, tag_to_category, threshold, top_k):
    """
    推論実行。outputs[1] (refined logits) にsigmoidを適用し、
    閾値でフィルタ→カテゴリ別グループ化→確信度ソート。
    """
    from collections import defaultdict

    start = time.perf_counter()
    outputs = session.run(None, {input_name: img_array})
    inference_time_ms = (time.perf_counter() - start) * 1000

    logits = outputs[1] if len(outputs) >= 2 else outputs[0]
    probs = 1.0 / (1.0 + np.exp(-logits))
    indices = np.where(probs[0] >= threshold)[0]

    tags_by_category = defaultdict(list)
    for idx in indices:
        idx_str = str(idx)
        tag_name = idx_to_tag.get(idx_str, f"unknown-{idx}")
        category = tag_to_category.get(tag_name, "general")
        confidence = float(probs[0, idx])
        tags_by_category[category].append({"tag": tag_name, "confidence": confidence})

    for category in tags_by_category:
        tags_by_category[category] = sorted(
            tags_by_category[category],
            key=lambda x: x["confidence"],
            reverse=True,
        )[:top_k]

    return dict(tags_by_category), inference_time_ms


def main():
    setup_utf8()

    if len(sys.argv) != 3:
        log(f"使い方: python {sys.argv[0]} <model_path> <metadata_path>")
        sys.exit(1)

    model_path = sys.argv[1]
    metadata_path = sys.argv[2]

    log("メタデータを読み込み中...")
    try:
        idx_to_tag, tag_to_category, total_tags, img_size = load_metadata(metadata_path)
        log(f"メタデータ読み込み完了: {total_tags}タグ, img_size={img_size}")
    except Exception as e:
        send({"status": "error", "error": str(e), "error_type": "metadata_load"})
        sys.exit(1)

    log("ONNXモデルを読み込み中...")
    try:
        session, input_name, provider = create_session(model_path)
        log(f"モデル読み込み完了: provider={provider}")
    except Exception as e:
        send({"status": "error", "error": str(e), "error_type": "model_load"})
        sys.exit(1)

    send({
        "status": "ready",
        "provider": provider,
        "total_tags": total_tags,
        "img_size": img_size,
    })

    log("リクエスト待機中...")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            send({"status": "error", "error": f"JSONパースエラー: {e}", "error_type": "parse"})
            continue

        command = request.get("command")
        request_id = request.get("request_id", "")

        if command == "shutdown":
            log("シャットダウンリクエスト受信")
            break

        if command == "infer":
            image_path = request.get("image_path", "")
            threshold = request.get("threshold", 0.35)
            top_k = request.get("top_k", 50)

            try:
                if not os.path.exists(image_path):
                    send({
                        "status": "error",
                        "request_id": request_id,
                        "error": f"画像が見つかりません: {image_path}",
                        "error_type": "file_not_found",
                    })
                    continue

                img_array = preprocess_image(image_path, img_size)
                tags, inference_time_ms = run_inference(
                    session, input_name, img_array,
                    idx_to_tag, tag_to_category,
                    threshold, top_k,
                )

                send({
                    "status": "ok",
                    "request_id": request_id,
                    "tags": tags,
                    "inference_time_ms": round(inference_time_ms, 1),
                })

            except Exception as e:
                log(f"推論エラー: {traceback.format_exc()}")
                send({
                    "status": "error",
                    "request_id": request_id,
                    "error": str(e),
                    "error_type": "inference",
                })
        else:
            send({
                "status": "error",
                "request_id": request_id,
                "error": f"不明なコマンド: {command}",
                "error_type": "unknown_command",
            })

    log("プロセス終了")


if __name__ == "__main__":
    main()
