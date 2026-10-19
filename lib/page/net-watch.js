// Start counting the page's fetch and XHR requests (shared.mjs bcNetWatch), so the first
// step's requests count toward its settle.
({ longPoll }) => bcNetWatch(longPoll)
