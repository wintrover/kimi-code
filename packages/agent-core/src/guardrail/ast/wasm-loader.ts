/**
 * wasm-loader — Generic tree-sitter WASM grammar loader.
 *
 * HARD CONSTRAINT: Uses web-tree-sitter WASM ONLY.
 * ❌ NEVER import from 'tree-sitter' (native addon, ABI fragmentation)
 * ❌ NEVER use relative './vendor/...' paths (CWD-dependent)
 *
 * Loads arbitrary tree-sitter WASM grammars on demand, caching by name.
 * Follows the wasm-locator.ts pattern for CDN download + atomic install.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GrammarSpec {
  name: string;
  wasmFilename: string;
  cdnUrl: string;
}

export interface LoadedGrammar {
  name: string;
  language: unknown;
}

// ---------------------------------------------------------------------------
// Minimal web-tree-sitter type definitions
// ---------------------------------------------------------------------------

interface TreeSitterNode {
  type: string;
  childCount: number;
  children: TreeSitterNode[];
  text: string;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterParser {
  parse(source: string): TreeSitterTree;
}

interface TreeSitterStatic {
  Language: {
    load(wasmPath: string): Promise<unknown>;
  };
  Parser: new () => TreeSitterParser & {
    setLanguage(lang: unknown): void;
  };
}

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

// One global Parser instance — languages are swapped via setLanguage()
let parserInstance: (TreeSitterParser & { setLanguage(lang: unknown): void }) | undefined;
let staticModule: TreeSitterStatic | undefined;

// Cache: loaded language objects keyed by grammar name
const loadedLanguages = new Map<string, LoadedGrammar>();

// Per-grammar download promise locks to prevent duplicate downloads
const downloadLocks = new Map<string, Promise<string>>();

const DOWNLOAD_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Share dir + file helpers (same pattern as wasm-locator.ts)
// ---------------------------------------------------------------------------

function getShareDir(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.kimi-code');
}

async function isFile(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// web-tree-sitter singleton init
// ---------------------------------------------------------------------------

async function getStaticModule(): Promise<TreeSitterStatic> {
  if (staticModule !== undefined) return staticModule;
  // Dynamic import for web-tree-sitter (WASM-only, no native addons)
  staticModule = (await import('web-tree-sitter')) as unknown as TreeSitterStatic;
  return staticModule;
}

async function getParser(): Promise<TreeSitterParser & { setLanguage(lang: unknown): void }> {
  if (parserInstance !== undefined) return parserInstance;
  const mod = await getStaticModule();
  parserInstance = new mod.Parser();
  return parserInstance;
}

// ---------------------------------------------------------------------------
// WASM download + cache
// ---------------------------------------------------------------------------

async function downloadAndInstallWasm(spec: GrammarSpec, shareDir: string): Promise<string> {
  const shareSubdir = join(shareDir, 'share');
  await mkdir(shareSubdir, { recursive: true });

  const tmp = await mkdtemp(join(tmpdir(), 'kimi-wasm-'));
  try {
    const tmpWasmPath = join(tmp, spec.wasmFilename);

    // Download with timeout via AbortController
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(spec.cdnUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (!resp.ok || resp.body === null) {
      throw new Error(
        `Failed to download ${spec.wasmFilename}: HTTP ${String(resp.status)} ${resp.statusText}`,
      );
    }
    const write = createWriteStream(tmpWasmPath);
    await pipeline(Readable.fromWeb(resp.body as never), write);

    // Atomic install: write to tmp then rename
    const destination = join(shareSubdir, spec.wasmFilename);
    await rename(tmpWasmPath, destination);
    return destination;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Resolve the absolute path to a grammar's WASM binary.
 * Returns cached path if available, otherwise downloads from CDN.
 */
async function resolveWasmPath(spec: GrammarSpec): Promise<string> {
  const shareDir = getShareDir();
  const cachePath = join(shareDir, 'share', spec.wasmFilename);

  // 1-2. Check cache
  if (await isFile(cachePath)) return cachePath;

  // 3. CDN download with per-grammar lock
  let lock = downloadLocks.get(spec.name);
  if (lock === undefined) {
    lock = (async () => {
      try {
        // Double-check after acquiring the lock
        if (await isFile(cachePath)) return cachePath;
        return await downloadAndInstallWasm(spec, shareDir);
      } finally {
        downloadLocks.delete(spec.name);
      }
    })();
    downloadLocks.set(spec.name, lock);
  }
  return lock;
}

// ---------------------------------------------------------------------------
// Legacy compat interface (used by bash-analyzer.ts)
// ---------------------------------------------------------------------------

interface WasmLoaderOptions {
  filename: string;
  cdnUrl: string;
}

/**
 * Resolve the absolute path to a tree-sitter WASM binary.
 * Downloads from CDN if not already cached.
 * This is a convenience wrapper around `loadGrammar` for callers that
 * only need the resolved path (e.g. bash-analyzer which does its own init).
 *
 * @throws {Error} if download fails.
 */
export async function resolveTreeSitterWasm(opts: WasmLoaderOptions): Promise<string> {
  const shareDir = getShareDir();
  const cachePath = join(shareDir, 'share', opts.filename);

  // Check cache
  if (await isFile(cachePath)) return cachePath;

  // Build a minimal spec for the download
  const spec: GrammarSpec = {
    name: opts.filename,
    wasmFilename: opts.filename,
    cdnUrl: opts.cdnUrl,
  };
  return resolveWasmPath(spec);
}

/**
 * User-facing error message when WASM resolution fails.
 */
export function wasmUnavailableMessage(cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error';
  return (
    `tree-sitter WASM is not available and automatic download failed.\n` +
    `\n` +
    `Error: ${detail}\n` +
    `\n` +
    `Fix options:\n` +
    `  1. Ensure network connectivity and retry\n` +
    `  2. Manually download the WASM binary and place it in ~/.kimi-code/share/\n` +
    `  3. Set KIMI_CODE_HOME to a directory with share/<wasm-filename>`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a tree-sitter language grammar from a WASM binary.
 * Caches loaded languages by grammar name — subsequent calls for the same
 * grammar return instantly without re-downloading or re-initializing.
 *
 * @throws {Error} if the WASM binary cannot be downloaded or loaded.
 */
export async function loadGrammar(spec: GrammarSpec): Promise<LoadedGrammar> {
  // Check in-memory cache
  const cached = loadedLanguages.get(spec.name);
  if (cached !== undefined) return cached;

  const wasmPath = await resolveWasmPath(spec);
  const mod = await getStaticModule();
  const language = await mod.Language.load(wasmPath);

  const result: LoadedGrammar = { name: spec.name, language };
  loadedLanguages.set(spec.name, result);
  return result;
}

/**
 * Get a tree-sitter parser configured with the given grammar.
 * Reuses a single global Parser instance and swaps the language.
 * The returned parser is only valid until the next call to getParserForGrammar.
 *
 * @throws {Error} if the grammar cannot be loaded.
 */
export async function getParserForGrammar(spec: GrammarSpec): Promise<TreeSitterParser> {
  const grammar = await loadGrammar(spec);
  const parser = await getParser();
  parser.setLanguage(grammar.language);
  return parser;
}
