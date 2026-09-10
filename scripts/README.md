# scripts

- `verify_lab.py` — 纹理压缩实验台线上端到端验收（Playwright 真实浏览器）。
  跑法：`python3 scripts/verify_lab.py`（需 playwright 的 chromium）。
  覆盖 6 用例：ETC1/BC1 100×100、ASTC 4×4/6×6、ASTC 6×6 120×120、ETC1 160×160；
  每例断言块数/文件字节/bpp/PSNR/日志行数，并点击②画布验证块级下钻面板；
  收集 console 错误（应为 0）。
