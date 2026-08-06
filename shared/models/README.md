# shared/models — ML model binaries

This directory holds model files that are too large to keep in normal git
history. They are copied into the engine image at build time
(`engine/Dockerfile` → `/app/shared/models`) and resolved by
`shared/src/providers/deepfake/OnnxDeepfakeDetector.ts` (default path:
`shared/models/deepfake-detector.onnx`).

## deepfake-detector.onnx (optional — system works without it)

- **Architecture:** EfficientNet-B0 binary classifier (real vs. AI-generated
  face), trained on FaceForensics++, input 224×224 RGB with ImageNet
  normalization (see `OnnxDeepfakeDetector.ts`).
- **Expected size:** ~25–50 MB (EfficientNet-B0 fp32 is ≈ 16M params; the
  older build in the `models-v1.0.0` release was ~30 MB). It is a rounding
  error inside the ~1.5 GB engine image.
- **When missing:** `deepfake_check` returns the neutral stub
  `{ isReal: true, realProbability: 0.5, fakeProbability: 0.5 }` and the
  engine logs `Deepfake detector model not found, disabling`.

### How to add it

The file used to be fetched from a private GitHub release at build time via
`GITHUB_TOKEN`. That dependency was removed — the model now ships in-repo so
builds work without a token:

```bash
# 1. (once) install git-lfs and enable it for this repo
git lfs install
git lfs track "*.onnx"

# 2. obtain the ONNX from the org release
gh release download models-v1.0.0 --repo team-idswyft/idswyft \
  --pattern deepfake-detector.onnx --dir shared/models/

# or, if you have a different source:
#   curl -L -o shared/models/deepfake-detector.onnx "$DEEPFAKE_MODEL_URL"

# 3. sanity-check it is a real ONNX (protobuf starts with 0x08, not HTML)
head -c 4 shared/models/deepfake-detector.onnx | od -c   # expect: 210 ...

# 4. commit
git add shared/models/deepfake-detector.onnx .gitattributes
git commit -m "chore(models): ship deepfake detector ONNX in-repo (LFS)"
```

### Alternative: remote source (no repo change)

Set `DEEPFAKE_MODEL_URL` at build time and `download-models.js` will fetch it
into `shared/models/` during the image build. This is the escape hatch for
teams that cannot commit binaries to git.
