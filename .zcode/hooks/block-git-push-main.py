#!/usr/bin/env python3
"""PreToolUse(Bash) hook — 拦截 git push 到 main（fin-trace 仓库规则）。

远程 main 是发布通道（deploy / plugin-release 都要求 tag 打在 main 提交上），
push main 一律由仓库所有者手动执行；ZCode 只负责本地 commit，可以 push feature 分支。
`git push --dry-run` 放行。

拦截范围（所有会更新远端 main 的 push 形式）：
  - refspec 目标为 main：main / HEAD:main / +main / :main（删除）/ --delete main / refs/heads/main
  - --all / --mirror（推全部分支）
  - 裸 `git push` 或 HEAD/@/@{u}/@{push} refspec（解析为当前分支，按当前分支是否 main 判定）
已知局限（工作流护栏，非安全边界）：子 shell / 续行等混淆写法、tag 推送（v* / plugin-v*）不拦截。

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
# git 全局选项中"单独跟一个值参数"的（影响定位 push 子命令）
GIT_GLOBAL_ARG_OPTS = {"-C", "-c", "--git-dir", "--work-tree"}
# git push 选项中"单独跟一个值参数"的
PUSH_ARG_OPTS = {"--receive-pack", "--exec", "--repo", "-r", "--push-option", "-o"}
# 解析为当前分支的 refspec 写法
HEAD_LIKE = {"HEAD", "@", "@{u}", "@{upstream}", "@{push}"}


def deny(reason):
    sys.stderr.write(
        "[fin-trace 规则] 已拦截 git push 到 main：远程 main 是发布通道，push main 由仓库所有者"
        "手动执行，ZCode 不直接推送。\n"
        f"触发：{reason}\n"
        "feature 分支可以推送（显式分支名，如 git push origin <branch>）；验证可使用 "
        "git push --dry-run（放行）。\n"
        "发布流程见 docs/deploy.md、docs/plugin-release.md"
        "（本拦截由 .zcode/config.json 的 PreToolUse hook 实施）。\n"
    )
    sys.exit(2)


def current_branch():
    cwd = os.environ.get("ZCODE_PROJECT_DIR") or str(Path(__file__).resolve().parent.parent)
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


def analyze_push(tokens):
    """解析 `git push` 之后的参数；会更新 main 则返回原因字符串，否则 None。"""
    dry_run = push_all = push_mirror = push_tags = False
    operands = []
    skip_next = False
    i = 0
    while i < len(tokens):
        t = tokens[i]
        i += 1
        if skip_next:
            skip_next = False
            continue
        if t == "--":
            operands.extend(tokens[i:])
            break
        if t.startswith("--"):
            if t == "--dry-run":
                dry_run = True
            elif t == "--all":
                push_all = True
            elif t == "--mirror":
                push_mirror = True
            elif t == "--tags":
                push_tags = True
            elif t in PUSH_ARG_OPTS:
                skip_next = True
        elif t.startswith("-") and len(t) > 1:
            letters = t[1:]
            if "n" in letters:  # -n = --dry-run（含 -fn 等短旗标簇）
                dry_run = True
            if "o" in letters:
                skip_next = True
        else:
            operands.append(t)

    if dry_run:
        return None
    if push_all or push_mirror:
        return "--all / --mirror 推送全部分支（含 main）"

    # operands = [repo?] + refspecs；首参数含 : / + / HEAD 形式时视为省略了 repo
    refspecs = []
    if operands:
        first = operands[0]
        if ":" in first or first.startswith("+") or first in HEAD_LIKE or first.startswith("@{"):
            refspecs = operands
        else:
            refspecs = operands[1:]

    if not refspecs:
        # --tags 且无 refspec 时只推 tags，不更新分支
        if push_tags:
            return None
        # 裸 push（可能带 repo）：push.default 语义下推当前分支
        if current_branch() == PROTECTED:
            return "裸 git push（当前在 main 分支）"
        return None

    for spec in refspecs:
        spec = spec.lstrip("+")
        src, sep, dst = spec.partition(":")
        if not sep:
            dst = src
        if dst.startswith("refs/heads/"):
            dst = dst[len("refs/heads/"):]
        if dst == PROTECTED:
            return f"refspec {spec}（目标为 main）"
        if src in HEAD_LIKE or dst in HEAD_LIKE:
            if current_branch() == PROTECTED:
                return f"refspec {spec}（解析为当前分支，当前在 main）"
    return None


def analyze_segment(tokens):
    """在子命令 token 序列中定位 git push；会更新 main 则返回原因，否则 None。"""
    for i, tok in enumerate(tokens):
        if tok != "git":
            continue
        j = i + 1
        skip = False
        subcmd = None
        while j < len(tokens):
            t = tokens[j]
            j += 1
            if skip:
                skip = False
                continue
            if t in GIT_GLOBAL_ARG_OPTS:
                skip = True
                continue
            if t.startswith("-"):
                continue
            subcmd = t
            break
        if subcmd == "push":
            reason = analyze_push(tokens[j:])
            if reason:
                return reason
    return None


try:
    event = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_input = event.get("tool_input") or {}
cmd = tool_input.get("command", "")
if not isinstance(cmd, str) or not cmd.strip():
    sys.exit(0)

# 按 shell 分隔符拆子命令，逐段检查其中的 git push
for seg in re.split(r"&&|\|\||[;|&\n]", cmd):
    try:
        tokens = shlex.split(seg)
    except ValueError:
        # 引号不完整等无法 tokenize 的情况：退化正则保守判断
        m = re.search(r"\bgit\s+push\b(.*)", seg)
        if m and re.search(rf"\b{PROTECTED}\b", m.group(1)) and "--dry-run" not in m.group(1):
            deny("命令无法解析且 git push 参数提及 main（保守拦截）")
        continue
    if not tokens:
        continue
    reason = analyze_segment(tokens)
    if reason:
        deny(reason)

sys.exit(0)
