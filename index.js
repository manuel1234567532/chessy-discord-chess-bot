const { fork } = require('child_process');

// Start dashboard.js
const dashboardProcess = fork('dashboard.js');

dashboardProcess.on('message', (msg) => {
  console.log('Message from dashboard.js:', msg);
});
