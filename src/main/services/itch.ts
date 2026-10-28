import { net } from 'electron'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadGame, type DownloadGameResponse } from 'itchio-downloader'
import { slug } from './asset-store'
import { ensureProjectStateDir } from './chat-history'
import { extractZip } from './export'

/**
 * itch.io free-asset tools, exposed to the AI as `itch_search` and
 * `itch_download` (test-harness.ts / mcp-bridge.mjs). Neither needs an
 * itch.io account or API key: search fetches itch.io's anonymous browse
 * pages directly (the /search route itself is login-walled — see the Search
 * section), and downloads use itchio-downloader's direct-HTTP path (its
 * puppeteer fallback is an optional dependency we deliberately never
 * install — see .puppeteerrc.cjs).
 *
 * Downloads land in `.gamifydesktop/itch/<author>-<name>/` — a STAGING area
 * (gitignored and .gdignore'd like all of .gamifydesktop/). The agent then
 * copies just the files the user wants into assets/, exactly like the
 * user-uploaded asset-pack workflow in agent-instructions.md.
 */

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// itch.io's /search route 302s to /login for anonymous visitors, and its
// browse routes answer HTTP 403 as soon as two facets are stacked in the path
// (both verified live, cookies/referer make no difference) — anonymous
// visitors get exactly one facet. So search works like this:
//
//   1. The query is mapped onto itch.io's own tag/genre vocabulary (from
//      /tags.json, fetched once a day per app run) and the single most
//      specific facet becomes the URL filter.
//   2. https://itch.io/game-assets/free/<facet> is fetched and its game cells
//      parsed — popularity-sorted, with title, author, and a short
//      description per result.
//   3. The query's remaining words (e.g. "fox") rank the parsed results by
//      title/description relevance.
//
// itch.io also 429s request bursts aggressively (observed live: 3 requests
// within ~12s → 429, fine again after ~45s), so calls are serialized and
// spaced well apart; a search costs 1–2 requests here (+1 for the tag
// vocabulary on the first search of the day).
const SEARCH_MIN_INTERVAL_MS = 20_000
const SEARCH_TIMEOUT_MS = 30_000
const MAX_RESULTS = 10
const TAG_VOCAB_TTL_MS = 24 * 60 * 60 * 1000
const BROWSE_BASE = 'https://itch.io/game-assets/free'
// Everywhere-words that would skew relevance ranking on an assets listing.
const RANKING_STOPWORDS = new Set(
  'a an the and or of for with in on to art pack packs asset assets game games free'.split(' ')
)

let nextSearchAt = 0
let searchChain: Promise<unknown> = Promise.resolve()

function throttledSearch<T>(fn: () => Promise<T>): Promise<T> {
  const run = searchChain.then(async () => {
    const wait = nextSearchAt - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    nextSearchAt = Date.now() + SEARCH_MIN_INTERVAL_MS
    return fn()
  })
  // A failed search must not poison the chain for the next one.
  searchChain = run.catch(() => {})
  return run
}

/**
 * Fetch an itch.io page with the failure modes translated for the model.
 * Goes through Electron's net.fetch (Chromium's network stack), NOT Node's
 * global fetch: itch.io sits behind Cloudflare, which fingerprints Node/undici
 * TLS and answers HTTP 403 no matter what the headers claim (seen live —
 * identical requests: undici 403, Chromium/curl 200).
 */
async function fetchItchPage(url: string): Promise<string> {
  const res = await net.fetch(url, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { accept: 'text/html' }
  })
  if (res.url.includes('/login')) {
    throw new Error(
      'itch.io redirected this route to its login page, so it is not anonymously accessible. Suggest the user ' +
        'browse https://itch.io/game-assets/free in their browser and paste the page URL of an asset they like — ' +
        'itch_download works with any itch.io asset page URL.'
    )
  }
  if (res.status === 429) {
    throw new Error(
      'itch.io is rate-limiting requests right now. Wait a minute or two, then try ONE more search — do not retry immediately.'
    )
  }
  if (!res.ok) {
    throw new Error(`itch.io returned HTTP ${res.status} — wait a minute, then try once more.`)
  }
  const html = await res.text()
  if (/Just a moment|Performing security verification/i.test(html)) {
    throw new Error(
      'itch.io served a bot-verification page instead of results. Try again in a few minutes; the user can also browse https://itch.io/game-assets/free directly.'
    )
  }
  return html
}

interface Facet {
  kind: 'tag' | 'genre'
  slug: string
}

let tagVocabulary: { fetched: number; bySlug: Map<string, Facet> } | null = null

/**
 * itch.io's asset-tag vocabulary, keyed by URL slug AND by slugified display
 * name ("Pixel Art" → pixel-art) so query phrases match either form. On fetch
 * failure returns the stale copy (or an empty map — search then degrades to
 * the unfiltered popular page plus relevance ranking) without caching, so the
 * next search retries.
 */
async function tagFacets(): Promise<Map<string, Facet>> {
  if (tagVocabulary && Date.now() - tagVocabulary.fetched < TAG_VOCAB_TTL_MS) return tagVocabulary.bySlug
  try {
    const raw = await throttledSearch(() => fetchItchPage('https://itch.io/tags.json?classification=assets&format=browse'))
    const parsed = JSON.parse(raw) as { tags?: Array<{ name?: string; url?: string }> }
    const bySlug = new Map<string, Facet>()
    for (const tag of parsed.tags ?? []) {
      const match = /^\/(tag|genre)-([a-z0-9-]+)$/.exec(tag.url ?? '')
      if (!match) continue
      const facet: Facet = { kind: match[1] as Facet['kind'], slug: match[2] }
      bySlug.set(facet.slug, facet)
      if (tag.name) bySlug.set(slugify(tag.name), facet)
    }
    if (bySlug.size > 0) tagVocabulary = { fetched: Date.now(), bySlug }
    return bySlug
  } catch {
    return tagVocabulary?.bySlug ?? new Map()
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A slug, its plural, or its singular — tags mix both ("Sprites", "Forest"). */
function lookupFacet(vocabulary: Map<string, Facet>, slug: string): Facet | undefined {
  return (
    vocabulary.get(slug) ??
    vocabulary.get(`${slug}s`) ??
    (slug.endsWith('s') ? vocabulary.get(slug.slice(0, -1)) : undefined)
  )
}

/**
 * Greedily match the query's words — longest phrase first, so "pixel art"
 * becomes the pixel-art tag rather than two misses — into itch.io facets,
 * then pick the ONE the browse URL may carry (see the section comment).
 * Later matches win and tags beat genres: queries tend to read
 * style → subject → format ("pixel art fox forest tileset"), so the last tag
 * is usually the most specific filter. Every other word — matched or not —
 * becomes a relevance-ranking term.
 */
function matchQuery(
  words: string[],
  vocabulary: Map<string, Facet>
): { primary: Facet | undefined; terms: string[] } {
  const matches: Array<{ facet: Facet; start: number; length: number }> = []
  let i = 0
  while (i < words.length) {
    let advanced = 0
    for (const window of [3, 2, 1]) {
      if (i + window > words.length) continue
      const facet = lookupFacet(vocabulary, words.slice(i, i + window).join('-'))
      if (facet) {
        matches.push({ facet, start: i, length: window })
        advanced = window
        break
      }
    }
    i += advanced || 1
  }
  const tags = matches.filter((m) => m.facet.kind === 'tag')
  const primary = (tags.length > 0 ? tags : matches).at(-1)
  const terms = words.filter(
    (_, index) => !(primary && index >= primary.start && index < primary.start + primary.length)
  )
  return { primary: primary?.facet, terms }
}

function browseUrl(facet?: Facet): string {
  return facet ? `${BROWSE_BASE}/${facet.kind}-${facet.slug}` : BROWSE_BASE
}

export async function searchItchAssets(query: string): Promise<string> {
  const q = query.trim()
  if (!q) throw new Error('Provide a non-empty search query.')

  const words = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const { primary, terms } = matchQuery(words, await tagFacets())

  let facet = primary
  let html = await throttledSearch(() => fetchItchPage(browseUrl(facet)))
  let results = parseBrowseResults(html)
  if (results.length === 0 && facet) {
    // A valid tag with no free assets — fall back to the unfiltered popular
    // list and let ranking do what it can.
    facet = undefined
    html = await throttledSearch(() => fetchItchPage(browseUrl()))
    results = parseBrowseResults(html)
  }
  if (results.length === 0) {
    // The unfiltered browse page always lists assets, so zero cells means the
    // page markup changed and the parser needs updating.
    throw new Error(
      "Could not read any results from itch.io's browse page — its layout may have changed. Tell the user " +
        'plainly; they can browse https://itch.io/game-assets/free themselves and paste an asset page URL, ' +
        'which itch_download accepts directly.'
    )
  }

  const ranked = rankResults(results, terms).slice(0, MAX_RESULTS)
  const filterNote = facet ? `, filtered by itch.io ${facet.kind} "${facet.slug}"` : ''
  const list = ranked
    .map((r, i) => `${i + 1}. [${r.title}](${r.url}) — by ${r.author}${r.description ? ` — ${r.description}` : ''}`)
    .join('\n')
  return (
    `Found ${ranked.length} free itch.io asset packs for "${q}" (most popular first${filterNote}):\n\n${list}\n\n` +
    'Relay this numbered list to the user VERBATIM (markdown links intact — they are clickable) and ask which option they want. ' +
    "Include this disclaimer: each asset has its own license — check the asset's itch.io page for usage and attribution rules " +
    'before shipping the game with it. Only call itch_download after the user picks.'
  )
}

interface SearchResult {
  title: string
  author: string
  url: string
  description: string
}

/**
 * Order results by how many ranking terms (query words that didn't become
 * facets, minus stopwords) appear in title+description; ties keep itch.io's
 * popularity order. With no usable terms the page order stands.
 */
function rankResults(results: SearchResult[], terms: string[]): SearchResult[] {
  const usable = [...new Set(terms.filter((t) => !RANKING_STOPWORDS.has(t)))]
  if (usable.length === 0) return results
  return results
    .map((result, index) => {
      const haystack = `${result.title} ${result.description}`.toLowerCase()
      const score = usable.filter((t) => haystack.includes(t) || (t.endsWith('s') && haystack.includes(t.slice(0, -1)))).length
      return { result, score, index }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.result)
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED_ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Each result on a browse page is a `game_cell` div holding a
 * `<a class="title game_link" href="https://<author>.itch.io/<name>">Title</a>`,
 * an optional `game_text` blurb, and a `game_author` link with the author's
 * display name. Splitting on the cell-open tag keeps exactly one result per
 * chunk (the similarly named game_cell_tools/game_cell_data classes never
 * start a cell div). The strict URL-shape check keeps anything unexpected out.
 */
function parseBrowseResults(html: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const cell of html.split(/<div [^>]*class="game_cell[\s"]/).slice(1)) {
    const anchor =
      /<a\b[^>]*href="(https:\/\/[a-z0-9][a-z0-9-]*\.itch\.io\/[a-z0-9][a-z0-9_-]*)\/?"[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([^<]+)<\/a>/i.exec(
        cell
      ) ??
      /<a\b[^>]*class="[^"]*\btitle\b[^"]*"[^>]*href="(https:\/\/[a-z0-9][a-z0-9-]*\.itch\.io\/[a-z0-9][a-z0-9_-]*)\/?"[^>]*>([^<]+)<\/a>/i.exec(
        cell
      )
    if (!anchor) continue
    const url = anchor[1].toLowerCase()
    const author = /class="game_author"><a\b[^>]*>([^<]+)<\/a>/i.exec(cell)
    const description = /class="game_text"[^>]*>([^<]*)</i.exec(cell)
    results.push({
      title: decodeEntities(anchor[2]),
      url,
      author: author ? decodeEntities(author[1]) : new URL(url).hostname.split('.')[0],
      description: description ? decodeEntities(description[1]) : ''
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_DOWNLOADS = 2
const MAX_TREE_DEPTH = 4
const MAX_TREE_ENTRIES = 150
const JUNK = new Set(['.DS_Store', 'Thumbs.db', '__MACOSX'])

/** Staging keys of downloads currently in flight. */
const inFlight = new Set<string>()

export async function downloadItchAsset(projectPath: string, url: string): Promise<string> {
  // The URL comes from model output — accept nothing but an itch.io page URL.
  const match = /^https?:\/\/([a-z0-9][a-z0-9-]{0,62})\.itch\.io\/([a-z0-9][a-z0-9_-]{0,120})\/?(?:[?#].*)?$/i.exec(
    url.trim()
  )
  if (!match) {
    throw new Error(
      'Not an itch.io asset page URL — expected https://<author>.itch.io/<name>. Use itch_search results or a URL the user provided.'
    )
  }
  const author = match[1].toLowerCase()
  const name = match[2].toLowerCase()
  if (author === 'www') throw new Error('That is not an asset page — use a https://<author>.itch.io/<name> URL.')
  const cleanUrl = `https://${author}.itch.io/${name}`

  const key = slug(`${author}-${name}`)
  if (inFlight.has(key)) throw new Error(`A download of ${cleanUrl} is already in progress — wait for it to finish.`)
  if (inFlight.size >= MAX_CONCURRENT_DOWNLOADS) {
    throw new Error(`Too many itch.io downloads in flight (max ${MAX_CONCURRENT_DOWNLOADS}) — wait for one to finish.`)
  }

  const stateDir = await ensureProjectStateDir(projectPath)
  const destAbs = join(stateDir, 'itch', key)
  // POSIX-style for the model, matching how other tools report project paths.
  const destRel = `.gamifydesktop/itch/${key}`

  inFlight.add(key)
  try {
    // Re-downloading the same asset starts from a clean slate — never mix
    // leftovers of a previous (possibly different) version into the listing.
    await rm(destAbs, { recursive: true, force: true })
    await mkdir(destAbs, { recursive: true })

    // Single-params calls return a single response; the array-input overload
    // is why the declared return type is a union.
    const result = (await downloadGame({
      itchGameUrl: cleanUrl,
      downloadDirectory: destAbs,
      // Keep the staging dir asset-only (no stray metadata JSON the agent
      // might copy into assets/); the title/author ride in result.metaData.
      writeMetaData: false,
      retries: 2,
      retryDelayMs: 2000
    })) as DownloadGameResponse

    if (!result.status || !result.filePath) {
      throw new Error(downloadFailureText(cleanUrl, result))
    }

    let extracted = false
    if (await isZip(result.filePath)) {
      await extractZip(result.filePath, destAbs)
      await rm(result.filePath, { force: true })
      extracted = true
    }

    const { lines, truncated } = await listTree(destAbs)
    const title = result.metaData?.title ?? name
    const by = result.metaData?.authors?.[0]?.name ?? author
    return (
      `Downloaded "${title}" by ${by} into ${destRel}/${extracted ? ' (zip auto-extracted)' : ''}.\n\n` +
      `Files${truncated ? ` (first ${MAX_TREE_ENTRIES} entries)` : ''}:\n${lines.join('\n')}\n\n` +
      'These staged files are INVISIBLE to Godot and git. Copy ONLY the pieces the user wants into the proper assets/ ' +
      'sub-folders (assets/entities/<id>/, assets/ui/, assets/shared/) with your file tools, renamed to fit the project, ' +
      'then wire them into scenes — never reference .gamifydesktop/... paths from game code. ' +
      `Remind the user to follow this asset's license terms from ${cleanUrl} (many require attribution).`
    )
  } finally {
    inFlight.delete(key)
  }
}

function downloadFailureText(url: string, result: DownloadGameResponse): string {
  switch (result.failReason) {
    case 'paid':
      return `This itch.io asset is paid — only free assets can be downloaded (${result.message}). Tell the user and offer a free alternative from itch_search.`
    case 'web_only':
    case 'no_uploads':
    case 'not_html5':
      return `${url} has no downloadable files (browser-playable or empty page) — pick a downloadable asset pack instead.`
    case 'csrf_failed':
    case 'puppeteer_missing':
      return `itch.io would not serve this download over direct HTTP (${result.message}). Suggest the user download it manually from ${url} and attach it to the chat.`
    default:
      return `itch.io download failed: ${result.message}`
  }
}

/** ZIP magic from the file header only — never buffer a whole asset pack. */
async function isZip(file: string): Promise<boolean> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fh.read(buf, 0, 4, 0)
    return bytesRead === 4 && buf.toString('latin1').startsWith('PK')
  } finally {
    await fh.close()
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Bounded indented tree of the staged files (depth- and entry-capped, junk
 * skipped, directories first) — enough for the model to pick what to copy
 * without flooding its context on huge packs; it can always list the staged
 * folder itself for more.
 */
async function listTree(root: string): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = []
  let truncated = false
  async function walk(dir: string, depth: number): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => !JUNK.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (lines.length >= MAX_TREE_ENTRIES) {
        truncated = true
        return
      }
      const indent = '  '.repeat(depth)
      if (entry.isDirectory()) {
        if (depth >= MAX_TREE_DEPTH) {
          lines.push(`${indent}${entry.name}/ …`)
          continue
        }
        lines.push(`${indent}${entry.name}/`)
        await walk(join(dir, entry.name), depth + 1)
      } else {
        const { size } = await stat(join(dir, entry.name))
        lines.push(`${indent}${entry.name} (${formatSize(size)})`)
      }
    }
  }
  await walk(root, 0)
  if (truncated) {
    lines.push(`… listing truncated at ${MAX_TREE_ENTRIES} entries — list the staged folder yourself for the rest.`)
  }
  return { lines, truncated }
}
