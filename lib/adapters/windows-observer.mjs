const WINDOWS_OBSERVER_LIMITS = {
  timeout: 5000,
  maxBuffer: 1024 * 1024,
  encoding: 'utf8',
  windowsHide: true,
};

function snapshotScript(port, ignorePids) {
  const ignored = ignorePids.length ? ignorePids.join(',') : '';
  return `
$ErrorActionPreference = 'Stop'
$ignoredPids = @(${ignored})
try {
  $tcp = @(Get-NetTCPConnection -RemotePort ${port} -State Established -ErrorAction Stop)
} catch {
  if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { $tcp = @() } else { throw }
}
$allPids = @(
  $tcp |
    ForEach-Object { [int]$_.OwningProcess } |
    Where-Object { $_ -gt 0 -and $_ -notin $ignoredPids } |
    Sort-Object -Unique
)
$selectedPids = @($allPids | Select-Object -First 33)
$clientPids = @($selectedPids | Select-Object -First 32)
$processes = [System.Collections.Generic.List[object]]::new()
$visited = [System.Collections.Generic.HashSet[int]]::new()
foreach ($clientPid in $clientPids) {
  $currentPid = [int]$clientPid
  for ($depth = 0; $depth -le 4 -and $currentPid -gt 0; $depth++) {
    if (!$visited.Add($currentPid)) { break }
    $process = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath -Filter "ProcessId = $currentPid" |
      Select-Object ProcessId, ParentProcessId, ExecutablePath
    if (!$process) { break }
    $processes.Add($process)
    $currentPid = [int]$process.ParentProcessId
  }
}
$result = [PSCustomObject]@{
  pids = @($selectedPids)
  processes = @($processes.ToArray())
}
ConvertTo-Json -InputObject $result -Depth 5 -Compress
`;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseSnapshot(stdout) {
  const snapshot = JSON.parse(stdout);
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.pids)) {
    throw new Error('Invalid Windows connection snapshot');
  }
  const processRows = asArray(snapshot.processes);
  const processes = new Map();
  for (const row of processRows) {
    const pid = Number(row.ProcessId);
    const ppid = Number(row.ParentProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    processes.set(pid, {
      pid,
      ppid,
      executable: typeof row.ExecutablePath === 'string' ? row.ExecutablePath : null,
    });
  }
  return { pids: snapshot.pids.map(Number), processes };
}

/** Passive, bounded snapshot of existing TCP clients on Windows. */
export async function observeWindowsConnections(port, { daemonPid = null, ignorePids = [], run }) {
  const safeIgnored = ignorePids.filter(pid => Number.isSafeInteger(pid) && pid > 0);
  const script = snapshotScript(port, safeIgnored);
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    WINDOWS_OBSERVER_LIMITS,
  );
  const { pids, processes } = parseSnapshot(stdout);
  const boundedPids = pids.slice(0, 32);
  const warnings = pids.length > 32
    ? ['Connection observation is limited to 32 client processes.']
    : [];

  const connections = boundedPids.map(pid => {
    const own = processes.get(pid);
    if (!own) {
      return {
        pid,
        ppid: null,
        executable: null,
        ancestors: [],
        sharedDaemon: daemonPid === null ? null : pid === daemonPid,
        processExited: true,
      };
    }

    const ancestors = [];
    const seen = new Set([pid]);
    let parent = own.ppid;
    for (let depth = 0; depth < 4 && parent > 0 && !seen.has(parent); depth++) {
      seen.add(parent);
      const ancestor = processes.get(parent);
      if (!ancestor) break;
      ancestors.push(ancestor);
      parent = ancestor.ppid;
    }

    return { ...own, ancestors, sharedDaemon: daemonPid === null ? null : pid === daemonPid };
  });

  return { available: true, connections, warnings };
}
