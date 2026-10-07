// Placeholder - the UI agent replaces this file. Core modules live in ../src/core/*.js.
const root = document.getElementById('app');
root.textContent = 'ASH Draw Studio — ready';
console.log('isElectron', window.api.isElectron);
console.log('dwgAvailable', await window.api.dwgAvailable());
