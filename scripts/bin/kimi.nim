import std/[os, osproc, posix, algorithm, strutils, sets, json]
import checksums/sha1

const
  defaultHashFileName = ".build-hash"
  defaultLockFileName = ".build-hash.lock"
  markerFile = "pnpm-workspace.yaml"
  configFileName = ".kimi-gate.json"
  hashConfigFileName = ".build-hash-config.json"
  buildFailTailLines = 20
  defaultBuildCmd = "pnpm --filter=@moonshot-ai/kimi-code run build"
  defaultExcludedDirs = ["node_modules", ".git", "dist", "dist-native",
                         ".turbo", ".changeset", "node"]
  defaultSourceExts = [".ts", ".md", ".json"]

var
  hashFileName = defaultHashFileName
  lockFileName = defaultLockFileName
  excludedSet = defaultExcludedDirs.toHashSet()
  sourceExts: seq[string] = @[".ts", ".md", ".json"]

# ── Path Resolution ──

proc findProjectRoot(): string =
  let envRoot = getEnv("KIMI_ROOT", "")
  if envRoot.len > 0 and dirExists(envRoot):
    return envRoot
  var dir = getCurrentDir()
  while true:
    if fileExists(dir / markerFile):
      return dir
    let parent = dir.parentDir()
    if parent == dir:
      break
    dir = parent
  stderr.writeLine("[gate] error: cannot find project root (no " & markerFile & " found)")
  quit(1)

# ── Config ──

proc loadHashConfig(rootDir: string) =
  let configPath = rootDir / hashConfigFileName
  if not fileExists(configPath):
    return
  try:
    let config = parseFile(configPath)
    if config.hasKey("sourceExts"):
      sourceExts = @[]
      for ext in config["sourceExts"]:
        sourceExts.add(ext.getStr())
    if config.hasKey("excludedDirs"):
      excludedSet = initHashSet[string]()
      for d in config["excludedDirs"]:
        excludedSet.incl(d.getStr())
    if config.hasKey("hashFile"):
      let v = config["hashFile"].getStr()
      if v.len > 0:
        hashFileName = v
    if config.hasKey("lockFile"):
      let v = config["lockFile"].getStr()
      if v.len > 0:
        lockFileName = v
  except:
    # Malformed config — fall back to defaults
    discard

proc loadBuildCommand(rootDir: string): string =
  let configPath = rootDir / configFileName
  if not fileExists(configPath):
    return defaultBuildCmd
  try:
    let config = parseFile(configPath)
    result = config["build_command"].getStr()
    if result.len == 0: return defaultBuildCmd
  except:
    return defaultBuildCmd

# ── Hashing ──

proc isExcluded(relPath: string): bool {.inline.} =
  for part in relPath.split('/'):
    if part in excludedSet:
      return true
  return false

proc computeSourceHash(rootDir: string): string =
  var state = newSha1State()
  var files: seq[string]
  for path in walkDirRec(rootDir, relative = false):
    let (_, _, ext) = path.splitFile()
    if ext notin sourceExts: continue
    let relPath = path.relativePath(rootDir)
    if isExcluded(relPath): continue
    files.add(path)
  files.sort()
  for f in files:
    state.update(readFile(f))
  return $SecureHash(state.finalize())

proc readStoredHash(rootDir: string): string =
  let hf = rootDir / hashFileName
  if not fileExists(hf): return ""
  return readFile(hf).strip()

proc writeHash(rootDir: string, h: string) =
  writeFile(rootDir / hashFileName, h)

# ── Build ──

proc rebuild(rootDir: string): bool =
  let buildCmd = loadBuildCommand(rootDir)
  stderr.writeLine("[gate] source changed, running: " & buildCmd)
  let (output, exitCode) = execCmdEx(buildCmd, workingDir = rootDir)
  if exitCode != 0:
    let lines = output.splitLines()
    let tail = if lines.len > buildFailTailLines:
                 lines[^buildFailTailLines .. ^1].join("\n")
               else:
                 output
    stderr.writeLine("[gate] build FAILED (exit " & $exitCode & "), last " &
                     $min(lines.len, buildFailTailLines) & " lines:\n" & tail)
    return false
  stderr.writeLine("[gate] build OK")
  return true

# ── Lock (fcntl-based) ──

proc withBuildLock(rootDir: string, action: proc() {.closure.}) =
  let lockPath = rootDir / lockFileName
  let fd = open(lockPath.cstring, O_CREAT or O_WRONLY, 0o644)
  if fd < 0:
    action()
    return
  var fl: Tflock
  fl.l_type = F_WRLCK.cshort
  fl.l_whence = 0.cshort  # SEEK_SET
  fl.l_start = 0
  fl.l_len = 0  # lock entire file
  if fcntl(fd, F_SETLKW, addr fl) == -1:
    discard close(fd)
    action()
    return
  action()
  fl.l_type = F_UNLCK.cshort
  discard fcntl(fd, F_SETLK, addr fl)
  discard close(fd)

# ── Main ──

proc checkAndRebuild(rootDir: string) =
  withBuildLock(rootDir) do ():
    let currentHash = computeSourceHash(rootDir)
    let storedHash = readStoredHash(rootDir)
    if currentHash == storedHash:
      return
    if not rebuild(rootDir):
      quit(1)
    writeHash(rootDir, currentHash)

proc main() =
  let rootDir = findProjectRoot()
  loadHashConfig(rootDir)
  checkAndRebuild(rootDir)
  let distPath = rootDir / "apps" / "kimi-code" / "dist" / "main.mjs"
  let args = @["node", distPath] & commandLineParams()
  let cArgs = allocCStringArray(args)
  let err = execvp("node", cArgs)
  deallocCStringArray(cArgs)
  if err != 0:
    stderr.writeLine("[gate] execvp failed: " & $err)
    quit(1)

main()
