export const docsSidebar = [
  {
    heading: 'Get Started',
    links: [
      { href: '#setup', label: 'Installation' },
      { href: '#projects', label: 'Creating Projects' },
    ],
  },
  {
    heading: 'The Workspace',
    links: [
      { href: '#kanban', label: 'The Kanban Board' },
      { href: '#terminal', label: 'Using Terminals' },
      { href: '#browser', label: 'Using the Browser' },
      { href: '#git', label: 'Working with Git' },
    ],
  },
  {
    heading: 'AI Agents',
    links: [
      { href: '#agent-modes', label: 'AI Modes & Keys' },
      { href: '#slay-cli', label: '`slay` CLI' },
    ],
  },
  {
    heading: 'Misc',
    links: [
      { href: '#linear', label: 'Linear Sync' },
      { href: '#privacy', label: 'Privacy & Data' },
    ],
  },
]

export const docsSections = [
  {
    id: 'setup',
    title: 'Installation',
    body: `
      <p>SlayZone is a desktop app for macOS, Windows, and Linux. It is signed and notarized, so it installs just like any other app.</p>
      <ol>
        <li>Download the installer for your OS from the <a href="/">homepage</a>.</li>
        <li>Run the installer and launch the app.</li>
        <li>That's it. No cloud accounts required.</li>
      </ol>
    `,
  },
  {
    id: 'projects',
    title: 'Creating Projects',
    body: `
      <p>SlayZone works with the folders already on your computer. You don't need to move or copy your code.</p>
      <ul>
        <li>Click the <strong>+</strong> button in the left sidebar.</li>
        <li>Pick any folder (usually the root of a Git repo).</li>
        <li>SlayZone will show your branches and files immediately.</li>
      </ul>
      <div class="highlight-box">
        <p><strong>Good to know:</strong> SlayZone terminals use your existing shell. All your usual commands, versions (like <code>nvm</code>), and shortcuts will work perfectly.</p>
      </div>
    `,
  },
  {
    id: 'kanban',
    title: 'The Kanban Board',
    body: `
      <p>The board helps you keep track of what you and your AI agents are doing. It's split into simple columns: Backlog, In Progress, Review, and Done.</p>
      <ul>
        <li><strong>Tasks:</strong> Click <strong>+</strong> in a column to create a task.</li>
        <li><strong>Opening Tasks:</strong> Click any card to open its workspace. Each task has its own terminals and browser.</li>
        <li><strong>Auto-Status:</strong> SlayZone watches your terminal. When an agent starts working, the card on the board will visually update to show it's active.</li>
      </ul>
    `,
  },
  {
    id: 'terminal',
    title: 'Using Terminals',
    body: `
      <p>Every task card has its own terminals. These aren't just for AI—you can use them for anything.</p>
      <ul>
        <li><strong>Persistence:</strong> If you close SlayZone, your terminals keep running. When you reopen the app, your history and logs are still there.</li>
        <li><strong>Multiple Tabs:</strong> You can have one tab running a dev server (like <code>npm run dev</code>) and another for your AI agent.</li>
      </ul>
    `,
  },
  {
    id: 'browser',
    title: 'Using the Browser',
    body: `
      <p>The embedded browser lets you see your app or read docs without leaving SlayZone.</p>
      <ul>
        <li><strong>Live Preview:</strong> Set a URL in project settings to have it load automatically when you open a task.</li>
        <li><strong>Mobile Testing:</strong> Use the device icons to see how your site looks on different screen sizes.</li>
        <li><strong>AI Control:</strong> AI agents can "pilot" this browser—clicking buttons and taking screenshots to verify their work.</li>
      </ul>
    `,
  },
  {
    id: 'git',
    title: 'Working with Git',
    body: `
      <p>SlayZone helps you work on multiple things at once without making a mess of your repo.</p>
      <ul>
        <li><strong>Worktrees:</strong> When you start a task, SlayZone can create a temporary "worktree." This lets you have different branches open in different tasks at the same time.</li>
        <li><strong>Commit UI:</strong> Review your changes and commit them directly from the task sidebar.</li>
        <li><strong>Conflicts:</strong> If a merge has conflicts, SlayZone provides a clear view to help you resolve them.</li>
      </ul>
    `,
  },
  {
    id: 'agent-modes',
    title: 'AI Modes & Keys',
    body: `
      <p>SlayZone supports any AI agent that runs in a terminal. To use them, make sure your API keys are set in your system shell (like in your <code>.zshrc</code> or <code>.bashrc</code> file).</p>
      <h3>Supported Modes:</h3>
      <ul>
        <li><code>claude-code</code>: Best for Anthropic's Claude. It tracks Thinking and Working states.</li>
        <li><code>gemini</code>: For Google's Gemini. Includes real-time usage tracking.</li>
        <li><code>cursor-agent</code>: Full support for the Cursor CLI.</li>
        <li><code>opencode</code>: For running local models via Ollama.</li>
      </ul>
    `,
  },
  {
    id: 'slay-cli',
    title: '\`slay\` CLI Reference',
    body: `
      <p>You can control SlayZone from your regular terminal using the <code>slay</code> command. (Install it via <strong>Settings &rarr; About</strong>).</p>
      <pre><code># List your tasks
slay tasks list

# Create a new task
slay tasks create "Fix nav bug" --project "My App"

# Open a task in the desktop app
slay tasks open &lt;id&gt;

# See running background processes
slay processes list</code></pre>
    `,
  },
  {
    id: 'linear',
    title: 'Linear Sync',
    body: `
      <p>If you use Linear, you can connect it to SlayZone to keep your issues in sync.</p>
      <ul>
        <li><strong>Import:</strong> Pull your assigned Linear issues onto your SlayZone board.</li>
        <li><strong>Two-Way Sync:</strong> When you finish a task in SlayZone, it can automatically update the status in Linear for your team.</li>
      </ul>
    `,
  },
  {
    id: 'privacy',
    title: 'Privacy & Data',
    body: `
      <p>SlayZone is <strong>Local-First</strong>. This is important:</p>
      <ul>
        <li><strong>Your code stays local:</strong> We never upload your source code to our servers.</li>
        <li><strong>No accounts:</strong> You don't need to sign up or log in to use SlayZone.</li>
        <li><strong>Your keys:</strong> We don't store your AI API keys. Your agents use the keys already on your machine.</li>
      </ul>
    `,
  },
]
