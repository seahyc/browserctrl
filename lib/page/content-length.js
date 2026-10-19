// How much text the page has, and whether it has finished loading.
() => ({ n: (document.body && document.body.innerText || '').replace(/\s+/g, ' ').length, done: document.readyState === 'complete' })
