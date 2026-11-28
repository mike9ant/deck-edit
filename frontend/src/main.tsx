import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { installShortcutLabels } from './shortcutLabels'

// Windows / Linux: tooltips say Ctrl+… where the app writes ⌘….
installShortcutLabels()

// Saved UI state from before the rename to Deck Edit (pdfedit-… / pptxedit-… keys: open project,
// tabs, panel sizes, drafts…) carries over once.
for (const store of [localStorage, sessionStorage]) {
  for (const key of Object.keys(store)) {
    const m = /^(?:pdfedit|pptxedit)-(.+)$/.exec(key)
    if (m && store.getItem(`deckedit-${m[1]}`) === null) store.setItem(`deckedit-${m[1]}`, store.getItem(key)!)
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
