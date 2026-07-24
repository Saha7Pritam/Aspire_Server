// test-log.js
const { log, flush } = require('./blobLogger');
log('INFO', 'test-log.js', 'manualTest', 'Testing hourly blob logging setup');
flush().then(() => console.log('Flushed to blob'));