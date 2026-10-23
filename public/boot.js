// Runs before first paint so a saved light/dark choice never flashes the other theme.
// Without a saved choice the app starts in light mode.
var t = 'light';
try { t = JSON.parse(localStorage.getItem('cohort:theme')) || 'light'; } catch (e) { /* storage unavailable: light */ }
if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
