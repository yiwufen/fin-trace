#!/usr/bin/env python3
"""PreToolUse(Bash) hook — 拦截在 main 分支上创建提交的 git 命令（fin-trace 仓库规则）。

main 是发布通道，只经 PR 合并更新；开发工作一律在 feature 分支上进行（启动流程见
AGENTS.md「开发任务启动流程」）。若忘了切分支就已开始编辑，未提交改动会随
`git checkout -b <branch>` 带到新分支——补切分支后再提交即可，不丢工作。

拦截范围（当前分支为 main 时）：
  - git commit（含 --amend；--dry-run 放行，-n 是 --no-verify 不放行）
  - git merge / git cherry-pick / git revert / git rebase（都会在 main 上产生或改写提交）
  - `git -C <path>` 指向其他仓库时，按该仓库的当前分支判定
已知局限（工作流护栏，非安全边界）：`--git-dir` 等其余全局选项、子 shell/续行等混淆写法
不覆盖；`git pull` 放行（同步远程 main 的 fast-forward 是允许的准备工作）。

退出码契约（PreToolUse）：0 放行，2 拦截（deny），其他非零为错误。
输入解析失败时放行（fail-open，不阻塞正常工作）。
"""
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

PROTECTED = "main"
# 会在当前分支上创建/改写提交的 git 子命令
BLOCKED_SUBCMDS = {"commit", "merge", "cherry-pick", "revert", "rebase"}
# git 全局选项中"单独跟一个值参数"的（影响定位子命令；-C 的值另作仓库定位用）
GIT_GLOBAL_ARG_OPTS = {"-C", "-c", "--git-dir", "--work-tree"}


def deny(reason):
    sys.stderr.write(
        "[fin-trace 规则] 已拦截在 main 分支上创建提交：main 是发布通道，只经 PR 合并更新，\n"
        "开发工作必须在 feature 分支上进行。\n"
        f"触发：{reason}\n"
        "补救：未提交改动会随 `git checkout -b <type>/<short-desc>` 带到新分支"
        "（feature/fix/chore/docs），补切后再提交即可。\n"
        "完整启动流程见 AGENTS.md「开发任务启动流程」"
        "（本拦截由 .zcode/config.json 的 PreToolUse hook 实施）。\n"
    )
    sys.exit(2)


def current_branch(cwd):
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=3, cwd=cwd,
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return ""


def default_repo_dir():
    return os.environ.get("ZCODE_PROJECT_DIR") or str(Path(__file__).resolve().parent.parent)


def has_dry_run(tokens):
    # 注意：git commit 的 -n 是 --no-verify（不是 dry-run），只认长选项
    return "--dry-run" in tokens


def analyze_segment(tokens):
    """定位 git 提交类子命令；在 main 上执行则返回原因字符串，否则 None。"""
    for i, tok in enumerate(tokens):
        if tok != "git":
            continue
        j = i + 1
        skip = False
        repo_dir = default_repo_dir()
        subcmd = None
        while j < len(tokens):
            t = tokens[j]
            j += 1
            if skip:
                skip = False
                continue
            if t in GIT_GLOBAL_ARG_OPTS:
                if t == "-C":
                    if j < len(tokens):
                        repo_dir = tokens[j]
                        j += 1
                else:
                    skip = True
                continue
            if t.startswith("-"):
                continue
            subcmd = t
            break
        if subcmd == "commit":
            rest = tokens[j:]
            if has_dry_run(rest):
                continue
            if current_branch(repo_dir) == PROTECTED:
                return "git commit（当前在 main 分支）"
        elif subcmd in BLOCKED_SUBCMDS:
            if current_branch(repo_dir) == PROTECTED:
                return f"git {subcmd}（当前在 main 分支）"
    return None


try:
    event = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_input = event.get("tool_input") or {}
cmd = tool_input.get("command", "")
if not isinstance(cmd, str) or not cmd.strip():
    sys.exit(0)

# 按 shell 分隔符拆子命令，逐段检查其中的 git 提交类命令
for seg in re.split(r"&&|\|\||[;|&\n]", cmd):
    try:
        tokens = shlex.split(seg)
    except ValueError:
        # 引号不完整等无法 tokenize 的情况：退化正则保守判断
        if re.search(r"\bgit\s+(commit|merge|cherry-pick|revert|rebase)\b", seg) \
                and "--dry-run" not in seg \
                and current_branch(default_repo_dir()) == PROTECTED:
            deny("命令无法解析且包含 git 提交类子命令（保守拦截）")
        continue
    if not tokens:
        continue
    reason = analyze_segment(tokens)
    if reason:
        deny(reason)

sys.exit(0)
