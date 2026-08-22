#!/usr/bin/env python3
"""PreToolUse(Bash) hook — 拦截本地 npm publish（fin-trace 仓库规则）。

发布唯一通道是 git tag plugin-vX.Y.Z → .github/workflows/plugin-release.yml
（npm 账号启用 2FA，本地 publish 一律 403）。--dry-run 与 npm pack 放行。
完整发布流程见 docs/plugin-release.md。

退出码契约（PreToolUse）：0 放行，2 拦截（deny），其他非零为错误。
输入解析失败时放行（fail-open，不阻塞正常工作）。
"""
import json
import re
import sys

try:
    event = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_input = event.get("tool_input") or {}
cmd = tool_input.get("command", "")
if not isinstance(cmd, str):
    sys.exit(0)

if re.search(r"\bnpm\s+publish\b", cmd) and "--dry-run" not in cmd:
    sys.stderr.write(
        "[fin-trace 规则] 已拦截本地 npm publish：npm 账号启用 2FA，本地发布一律 403。\n"
        "正确流程：commit → push main → git tag plugin-v<X.Y.Z>（与 packages/dsh-fin-trace/"
        "package.json 的 version 一致）→ push tag，由 plugin-release.yml 以 provenance 发布。\n"
        "详见 docs/plugin-release.md（本拦截由 .zcode/config.json 的 PreToolUse hook 实施）。\n"
    )
    sys.exit(2)

sys.exit(0)
