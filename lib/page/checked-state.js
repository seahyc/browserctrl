// Whether a checkbox, radio, switch or toggle button is on (null when it left the page).
({ selector }) => {
  const el = findDeep(selector);
  return el && el.isConnected ? elementInfo(el).checked : null;
}
