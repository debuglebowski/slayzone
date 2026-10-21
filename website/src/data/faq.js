export const faqGroups = [
  {
    id: 'workflow',
    title: 'Workflow & Git',
    items: [
      {
        question: 'Can I work on multiple branches at the same time?',
        answer:
          "Yes. SlayZone's <strong>Worktree Isolation</strong> creates a separate physical folder for each active task. You can have a frontend refactor running in one task card and a backend bug fix in another—each on its own branch—without ever having to switch contexts or stash half-finished code."
      },
      {
        question: 'Does SlayZone modify my existing Git repository?',
        answer:
          "No. SlayZone uses standard Git Worktrees. It doesn't add any <code>.slayzone</code> folders or custom metadata to your repo. All SlayZone-specific data (task notes, logs, board state) lives in a private SQLite database on your machine."
      },
      {
        question: 'How do I resolve merge conflicts when finishing a task?',
        answer:
          'SlayZone includes a specialized <strong>Unified Diff</strong> viewer. If a task\'s branch has diverged from your main branch, you can resolve conflicts directly in the Workbench UI with a clear "Ours vs. Theirs" view, or even ask an agent in the terminal to handle the merge for you.'
      }
    ]
  },
  {
    id: 'ai',
    title: 'AI & Terminals',
    items: [
      {
        question: 'Which AI providers are supported?',
        answer:
          'SlayZone supports <strong>any</strong> AI agent or provider that runs in a standard terminal. We offer specialized adapters for <code>claude-code</code>, <code>gemini</code>, <code>cursor-agent</code>, <code>opencode</code>, and <code>codex</code>. These adapters provide enhanced features like automatic "Thinking" state detection and real-time usage tracking. However, you can use any other tool in "raw terminal" mode and it will work perfectly.'
      },
      {
        question: 'Do I need to re-configure my environment inside SlayZone?',
        answer:
          "No. SlayZone terminals are real PTY sessions that inherit your system's login shell. If a command works in your standard terminal (like <code>zsh</code> or <code>bash</code>), it will work exactly the same way inside a SlayZone task card—including your <code>nvm</code> versions, aliases, and system tools."
      },
      {
        question: 'What happens to my terminal sessions if I restart the app?',
        answer:
          'SlayZone features <strong>Terminal Persistence</strong>. Sessions stay alive in the background. When you reopen the app or return to a task, your full scrollback history, running processes (like dev servers), and agent conversations are exactly where you left them.'
      },
      {
        question: 'Can I run local AI models like Ollama?',
        answer:
          'Absolutely. By using the <code>opencode</code> terminal mode, SlayZone is optimized to work with local-first agents. Since everything is a local terminal session, you can run any AI that has a CLI interface without any data leaving your machine.'
      }
    ]
  },
  {
    id: 'browser',
    title: 'The Browser & CLI',
    items: [
      {
        question: 'Can agents really "drive" the embedded browser?',
        answer:
          'Yes. Via the <code>slay tasks browser</code> command, agents can navigate to your local dev server, click buttons, type into forms, and capture screenshots. This allows agents to verify their own code changes by running "visual" tests while they work.'
      },
      {
        question: 'How does the app know when my agent is "Thinking"?',
        answer:
          "SlayZone uses specialized output adapters (for Claude Code, Gemini, etc.) that parse the terminal's data stream in real-time. It detects specific patterns to update the task card's status on the board automatically, giving you a high-level view of agent progress."
      },
      {
        question: 'How do I use SlayZone alongside VS Code or Cursor?',
        answer:
          "Most users keep SlayZone open on a side monitor as an <strong>Orchestration Hub</strong>. You can use the <code>slay</code> CLI from inside your IDE's terminal to create tasks or update the board, while letting SlayZone handle the isolated worktrees and long-running agent sessions in the background."
      }
    ]
  },
  {
    id: 'data',
    title: 'Data & Privacy',
    items: [
      {
        question: 'Where exactly is my data stored?',
        answer:
          'Everything is stored locally on your machine, in <code>~/.slayzone/stable/hub</code> (on Windows, the same folder under your user profile). The database is <code>slayzone.data.sqlite</code>, and artifact files sit beside it. To back up or move your whole board and history, quit SlayZone and copy that folder.'
      },
      {
        question: 'Are my AI API keys stored in the app?',
        answer:
          "No. SlayZone never asks for or stores your API keys. It simply passes your system's environment variables to the terminal sessions. This ensures your keys stay in your encrypted shell profile and are never written to the SlayZone database."
      }
    ]
  }
]
