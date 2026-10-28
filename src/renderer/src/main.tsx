import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

// Versions ≤ 0.1.2 (then called GenieEngine) stored these UI preferences —
// sidebar width, aspect ratio, console height, chat model — under
// "genieengine:" keys; carry them over once.
for (const key of Object.keys(localStorage)) {
  if (!key.startsWith('genieengine:')) continue
  const renamed = `gamifydesktop:${key.slice('genieengine:'.length)}`
  if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key) ?? '')
  localStorage.removeItem(key)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
