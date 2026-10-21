// Switches use the steps' absolute timestamps; the initial source row starts at zero.
export function panelTimeline(steps, sourceTab) {
  const switches = [{ at: 0, tab: sourceTab, label: '', url: '' }];
  const tracks = new Map();
  let active = sourceTab;
  for (const step of [...steps].filter(s => typeof s.at === 'number').sort((a, b) => a.at - b.at)) {
    if (!step.tab) continue;
    const info = tracks.get(step.tab) || { label: '', url: '' };
    if (step.label) info.label = step.label;
    if (step.url) info.url = step.url;
    tracks.set(step.tab, info);
    const tab = ['tab-close', 'track-stop'].includes(step.event) ? (step.sourceTab || sourceTab) : step.tab;
    if (tab === active) continue;
    const target = tab === sourceTab ? { label: '', url: '' } : tracks.get(tab) || info;
    switches.push({ at: step.at, tab, ...target });
    active = tab;
  }
  return switches;
}
