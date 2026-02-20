require('dotenv').config();

// Single process starter for all 3 bots (Render Background Worker üçün rahat)
console.log('Starting PayTaksi bots...');

require('./passenger_bot');
require('./driver_bot');
require('./admin_bot');
