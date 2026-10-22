() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const loaded = nav?.loadEventEnd;
  return { age: loaded ? performance.now() - loaded : document.readyState === 'complete' ? Infinity : 0,
    overlay: !!viewText().overlay?.trim() };
}
