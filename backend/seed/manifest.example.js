// Demo seed shipped with the repo. Loaded automatically on first run when no personal
// manifest.js exists. Generic, domain-neutral content that also showcases the features.
// To make this YOUR wiki: just add articles in the app, or create your own (gitignored)
// backend/seed/manifest.js + backend/seed/articles/.
export const articlesDir = 'articles.example'

export const categories = [
  { name: 'Getting Started', slug: 'getting-started', icon: '🚀', sort_order: 1 },
  { name: 'Features',        slug: 'features',        icon: '✨', sort_order: 2 },
]

export const articles = [
  {
    slug: 'welcome',
    title: 'Welcome to Wikit',
    summary: 'What this is, how it works, and how to make it your own.',
    category: 'getting-started',
    tags: ['intro', 'getting-started'],
    file: 'welcome.md',
  },
  {
    slug: 'markdown-and-code',
    title: 'Markdown & Code Highlighting',
    summary: 'Write in Markdown; code blocks are highlighted server-side with Shiki.',
    category: 'features',
    tags: ['markdown', 'code', 'shiki'],
    file: 'markdown-and-code.md',
  },
  {
    slug: 'relations-and-graph',
    title: 'Linking Articles & the Graph',
    summary: 'Connect articles with typed relations and explore them visually.',
    category: 'features',
    tags: ['graph', 'relations', 'links'],
    file: 'relations-and-graph.md',
  },
]

export const relations = [
  { source: 'welcome', target: 'markdown-and-code', type: 'related', label: 'next' },
  { source: 'welcome', target: 'relations-and-graph', type: 'related', label: 'next' },
  { source: 'relations-and-graph', target: 'markdown-and-code', type: 'related', label: 'see also' },
]
