#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_srcrefs.py — 校验文档里的「源码路径:行号」引用是否真实存在。

为什么需要它：
本站的立站原则是「所有结论基于源码逐行核实」。改版后文章里会大量出现
"这一步对应 tlsf.c:638 那一行"这类引用——行号写错，读者照着翻源码找不到，
整站可信度就崩了。本脚本把文章里的引用全部抽出来，逐条到真实源码树上对齐。

用法：
    python scripts/verify_srcrefs.py              # 校验，有问题退出码 1
    python scripts/verify_srcrefs.py --list       # 只列出引用，不校验
    python scripts/verify_srcrefs.py --quiet      # 只打印失败项

配置：scripts/srcref.config.json
    roots       源码树根目录（递归建索引）
    map         文件名 → 真实绝对路径（同名文件多、或树外文件用这个钉死）
    ignore_files 不参与校验的 md

引用写法（文章里允许）：
    `Runtime/Allocator/TLSAllocator.cpp:120`     长路径
    `TLSAllocator.cpp:120`                       短路径（靠文件名索引解析）
    `tlsf.c:636-639`                             区间，两端都校验
    `MemoryManager.h`                            只引文件名，校验文件存在即可
标注 `no-verify` 的行会被跳过（用于明确不追行号的历史引用）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Windows 控制台默认 GBK，中文输出会乱码 —— 强制 UTF-8
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(__file__).resolve().parent / "srcref.config.json"
DOCS_ROOT = ROOT / "docs"

# `路径:行号` / `路径:起-止`；路径允许 / \ . - _ 字母数字
REF_RE = re.compile(
    r"`([A-Za-z0-9_./\\-]+\.(?:c|h|cpp|hpp|cs|mm|inc|js))(?::(\d+)(?:\s*-\s*(\d+))?)?`"
)
SKIP_MARKERS = ("no-verify", "不校验行号")


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        print(f"[error] 缺少配置 {CONFIG_PATH}", file=sys.stderr)
        sys.exit(2)
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def build_index(cfg: dict) -> dict[str, list[Path]]:
    """文件名（小写） → 候选真实路径列表。map 里的钉死项排最前。"""
    exts = {e.lower() for e in cfg.get("extensions", [".c", ".h", ".cpp", ".cs"])}
    index: dict[str, list[Path]] = {}

    for name, rel in cfg.get("map", {}).items():
        p = Path(rel)
        if not p.is_absolute():
            p = ROOT / rel
        if p.exists():
            index.setdefault(name.lower(), []).insert(0, p)
        else:
            print(f"[warn] map 指向的文件不存在: {name} -> {p}", file=sys.stderr)

    for root in cfg.get("roots", []):
        rp = Path(root)
        if not rp.exists():
            print(f"[warn] 源码根不存在，已跳过: {rp}", file=sys.stderr)
            continue
        for p in rp.rglob("*"):
            if p.is_file() and p.suffix.lower() in exts:
                index.setdefault(p.name.lower(), []).append(p)
    return index


_line_cache: dict[Path, int] = {}


def total_lines(p: Path) -> int:
    if p not in _line_cache:
        try:
            with p.open("r", encoding="utf-8", errors="replace") as f:
                _line_cache[p] = sum(1 for _ in f)
        except OSError:
            _line_cache[p] = 0
    return _line_cache[p]


def resolve(ref_path: str, index: dict[str, list[Path]]) -> list[Path]:
    """把文档里的引用解析成候选真实文件（可能多个同名，逐个试）。"""
    ref_path = ref_path.replace("\\", "/").lstrip("./")
    name = ref_path.split("/")[-1].lower()
    cands = index.get(name)
    if not cands:
        return []
    # 命中最具体的（真实路径以引用路径结尾）排前面
    exact = [c for c in cands if c.as_posix().lower().endswith(ref_path.lower())]
    rest = [c for c in cands if c not in exact]
    return exact + rest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只列出引用，不校验")
    ap.add_argument("--quiet", action="store_true", help="只打印失败项")
    args = ap.parse_args()

    cfg = load_config()
    index = build_index(cfg)
    if not index:
        print("[error] 索引为空，检查 srcref.config.json 的 roots", file=sys.stderr)
        return 2

    ignore = set(cfg.get("ignore_files", []))
    total = checked = 0
    missing: list[str] = []
    bad_line: list[str] = []

    for md in sorted(DOCS_ROOT.rglob("*.md")):
        if md.name in ignore:
            continue
        text = md.read_text(encoding="utf-8", errors="replace")
        rel = md.relative_to(DOCS_ROOT).as_posix()
        for lineno, line in enumerate(text.splitlines(), 1):
            if any(m in line for m in SKIP_MARKERS):
                continue
            for m in REF_RE.finditer(line):
                raw, start, end = m.group(1), m.group(2), m.group(3)
                if raw.startswith(("node_modules", "http")):
                    continue
                total += 1
                if args.list:
                    print(f"{rel}:{lineno}  {raw}" + (f":{start}" if start else ""))
                    continue

                cands = resolve(raw, index)
                if not cands:
                    missing.append(f"{rel}:{lineno}  找不到文件  {raw}")
                    continue

                if start is None:
                    checked += 1
                    continue

                # 同名多份时：只要有一份能装下行号就算通过（选最合适的那份）
                ok = False
                best_note = ""
                for c in cands:
                    n = total_lines(c)
                    hi = int(end or start)
                    if 1 <= int(start) <= n and 1 <= hi <= n:
                        ok = True
                        break
                    best_note = f"{c.name} 共 {n} 行"
                checked += 1
                if not ok:
                    bad_line.append(
                        f"{rel}:{lineno}  {raw}:{start}{'-' + end if end else ''}  越界（{best_note}）"
                    )

    if args.list:
        return 0

    print(f"引用总数 {total}，行号校验 {checked} 条")
    print(f"文件找不到 {len(missing)} 条，行号越界 {len(bad_line)} 条")

    if missing and not args.quiet:
        print("\n--- 找不到文件（可能路径要按 srcref.config.json 的 map 修正） ---")
        for x in missing:
            print("  " + x)
    if bad_line:
        print("\n--- 行号越界（必须修） ---")
        for x in bad_line:
            print("  " + x)

    return 1 if (missing or bad_line) else 0


if __name__ == "__main__":
    sys.exit(main())
