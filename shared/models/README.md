# shared/models — ML model binaries

This directory holds model files that are too large to keep in normal git
history. They are copied into the engine image at build time
(`engine/Dockerfile` → `/app/shared/models`) and resolved by
`shared/src/providers/deepfake/OnnxDeepfakeDetector.ts` (default path:
`shared/models/deepfake-detector.onnx`).

## deepfake-detector.onnx (optional — system works without it)

- **Default model:** [onnx-community/Deep-Fake-Detector-v2-Model-ONNX](https://huggingface.co/onnx-community/Deep-Fake-Detector-v2-Model-ONNX)
  on HuggingFace — **public, Apache-2.0, no token required**. It is a
  ViT (google/vit-base-patch16-224-in21k) fine-tuned for real-vs-deepfake
  classification (92% accuracy on its test set).
- **File:** `onnx/model_int8.onnx` (~87 MB, int8 — fast on CPU). The repo
  also has fp32 (343 MB) and q4 (57 MB) variants; switch by changing
  `DEEPFAKE_MODEL_URL`.
- **When missing:** `deepfake_check` returns the neutral stub
  `{ isReal: true, realProbability: 0.5, fakeProbability: 0.5 }` and the
  engine logs `Deepfake detector model not found, disabling`.

### How it's obtained — automatic, no private repo

`engine/download-models.js` (and `backend/download-models.js`) download the
model **automatically at build time** from the public HuggingFace URL above,
plus two tiny sidecar files next to it:

- `shared/models/config.json` — label order + input size
- `shared/models/preprocessor_config.json` — mean/std/rescale normalization

`OnnxDeepfakeDetector` parses those sidecars at startup and adapts its
preprocessing and real/fake output mapping to whatever model is deployed
(falls back to the original EfficientNet-B0 ImageNet defaults if the
sidecars are absent). So swapping models is a URL change, not a code change.

### Options

1. **Default (recommended):** do nothing — the build fetches the public model
   automatically. No `GITHUB_TOKEN`, no private repo, no manual step.

2. **Pin a custom model:** set `DEEPFAKE_MODEL_URL` at build time. If the
   source is not the default HF repo, ship a `config.json` +
   `preprocessor_config.json` next to the model file (or accept the
   EfficientNet-B0 defaults, which fit any 224×224 ImageNet-normalized
   2-class model with `[fake, real]` logit order).

3. **Vendor it in-repo (optional):** commit the ONNX + sidecars under
   `shared/models/` so builds don't touch the network:

   ```bash
   git lfs install
   git lfs track "*.onnx"
   curl -L -o shared/models/deepfake-detector.onnx \
     "https://huggingface.co/onnx-community/Deep-Fake-Detector-v2-Model-ONNX/resolve/main/onnx/model_int8.onnx"
   curl -L -o shared/models/config.json \
     "https://huggingface.co/onnx-community/Deep-Fake-Detector-v2-Model-ONNX/resolve/main/config.json"
   curl -L -o shared/models/preprocessor_config.json \
     "https://huggingface.co/onnx-community/Deep-Fake-Detector-v2-Model-ONNX/resolve/main/preprocessor_config.json"
   git add shared/models/ .gitattributes
   git commit -m "chore(models): vendor deepfake detector ONNX (LFS)"
   ```

### Sanity checks

- `head -c 4 shared/models/deepfake-detector.onnx | od -c` → should start
  with `210` (ONNX protobuf), not `<` (HTML error page).
- After deploy, watch the engine log for
  `Deepfake detector model loaded` with the sidecar-derived settings, and a
  `deepfake_check` in API responses that is no longer the 0.5/0.5 stub.
- The check is a **soft flag** (Tier 2, non-blocking) — the blocking
  anti-spoofing remains the head-turn challenge (Gate 4).
