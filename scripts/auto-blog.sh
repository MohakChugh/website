#!/bin/bash
# auto-blog.sh — Automated blog post generation every 4 hours.
# Runs Claude Code headlessly to research + write + push a new blog post.
#
# Scheduled via crontab: 0 */4 * * * /Users/chumohak/website/scripts/auto-blog.sh
#
# What it does:
# 1. Invokes Claude Code with a prompt that:
#    - Picks a novel, deeply technical topic (recent papers, state-of-the-art techniques)
#    - Writes a complete blog post in markdown with frontmatter
#    - Saves it to content/blog/
#    - Runs the generator
#    - Commits and pushes
# 2. Logs output to ~/auto-blog.log
#
# Safety: no Amazon-internal info; only generic engineering concepts.

set -euo pipefail

LOG="$HOME/auto-blog.log"
REPO="/Users/chumohak/website"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

echo "[$TIMESTAMP] auto-blog starting" >> "$LOG"

# Environment for Claude Code (Bedrock)
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1
export AWS_PROFILE=aki
export ANTHROPIC_MODEL='us.anthropic.claude-fable-5'
export DISABLE_PROMPT_CACHING=0
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"

# GitHub auth: cron shells can't access macOS keyring, so inject token via env var.
# gh auth token reads from keyring in interactive shells; for cron we cache it.
GH_TOKEN_FILE="$HOME/.gh-token-cache"
if [ -f "$GH_TOKEN_FILE" ]; then
  export GH_TOKEN=$(cat "$GH_TOKEN_FILE")
  # Set git to use gh as credential helper for this session
  export GIT_ASKPASS="/opt/homebrew/bin/gh"
  export GIT_TERMINAL_PROMPT=0
fi

cd "$REPO"

# The prompt that drives the entire generation
PROMPT='You are an automated blog post generator for mohakchugh.is-a.dev (an Angular 22 portfolio).

Your task: write ONE new, novel, deeply technical blog post and publish it.

RULES:
1. Pick a topic that is: (a) deeply technical, (b) novel/state-of-the-art, (c) would interest senior engineers. Good topics: a recent research paper explained practically, a system design pattern, a performance optimization technique, a distributed systems concept, an AI/ML architecture deep-dive, a data engineering pattern. Bad topics: tutorials, beginner guides, opinion pieces.
2. NEVER mention Amazon internal systems, tools, codenames, or proprietary information. Use only publicly available knowledge. Frame everything generically (e.g. "at a large-scale tech company" if needed).
3. The post must be 800-1500 words, technically rigorous, with code examples where relevant.
4. Check what posts already exist in content/blog/ and pick a DIFFERENT topic. Do not repeat.
5. Use today'"'"'s date in the frontmatter.
6. The filename must be kebab-case, descriptive, and end in .md.
7. Tags should be 3-5 relevant lowercase keywords.

STEPS (execute ALL of them):
1. Run: ls content/blog/ to see existing posts and avoid duplicates.
2. Research a topic using web search. Find a specific, recent (2024-2026) paper or technique.
3. Write the complete markdown file with proper frontmatter (title, date, tags, excerpt).
4. Save it to content/blog/<slug>.md
5. Run: export PATH="/opt/homebrew/opt/node@24/bin:$PATH" && node scripts/generate-blog.mjs
6. Verify it says "N blog post(s) processed" with no errors.
7. Run: git add -A && git commit -m "blog: <short title of the post>" && git branch -f master redesign-angular-modern && git push origin master && git push origin redesign-angular-modern
8. Report what you published (title + slug).

Do all steps now. Do not ask questions.'

# Run Claude Code headlessly (non-interactive, skip permissions, auto-accept)
claude --dangerously-skip-permissions \
  --effort high \
  -p "$PROMPT" \
  >> "$LOG" 2>&1

EXIT_CODE=$?
echo "[$TIMESTAMP] auto-blog finished (exit: $EXIT_CODE)" >> "$LOG"
echo "---" >> "$LOG"
