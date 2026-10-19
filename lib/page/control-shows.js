// What a custom select or combobox shows as its value now, or null when it left the page.
// Its own text and value only: a component's shadow root also holds every option. A
// component host shows its value through its combobox inside.
({ selector }) => {
  const el = findDeep(selector);
  if (!el || !el.isConnected) return null;
  const own = (el.shadowRoot && el.shadowRoot.querySelector('[role=combobox],select,input')) || el;
  return [own.value, own.innerText, own.getAttribute('aria-valuetext'), own.getAttribute('value')].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 300);
}
