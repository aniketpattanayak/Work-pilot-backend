// server/utils/scheduler.js
const moment = require('moment');

/**
 * Calculates the next valid working day while skipping holidays and weekends.
 * @param {String} frequency - Daily, Weekly, Monthly, Quarterly, Half-Yearly, Yearly, etc.
 * @param {Object} config - Config for specific days (dayOfWeek, dayOfMonth, month, etc.)
 * @param {Array} holidays - Array of holiday objects [{date: Date}]
 */
exports.calculateNextDate = (frequency, config = {}, holidays = []) => {
  // Start from "Now"
  let nextDate = moment().startOf('day'); 

  // 1. Initial calculation based on frequency
  switch (frequency) {
    case 'Daily':
      nextDate.add(1, 'days');
      break;

    case 'Weekly':
      const targetDay = config.dayOfWeek !== undefined ? config.dayOfWeek : 0; 
      nextDate.add(1, 'days'); 
      while (nextDate.day() !== targetDay) {
        nextDate.add(1, 'days');
      }
      break;

    case 'Monthly':
      nextDate.add(1, 'months').date(config.dayOfMonth || 1);
      break;

    // NEW: Quarterly Logic - Jumps exactly 3 months ahead
    case 'Quarterly':
      nextDate.add(3, 'months').date(config.dayOfMonth || 1);
      break;

    // NEW: Half-Yearly Logic - Jumps exactly 6 months ahead
    case 'Half-Yearly':
      nextDate.add(6, 'months').date(config.dayOfMonth || 1);
      break;

    case 'Yearly':
      nextDate.add(1, 'years')
              .month(config.month || 0)
              .date(config.dayOfMonth || 1);
      break;

    default:
      nextDate.add(1, 'days');
  }

  // 2. Holiday & Weekend Skip Loop
  let isValidDay = false;
  while (!isValidDay) {
    const dateString = nextDate.format('YYYY-MM-DD');
    
    // Check if date is in holiday list
    const isHoliday = holidays.some(h => moment(h.date).format('YYYY-MM-DD') === dateString);
    
    // Auto-skip Sundays
    const isSunday = nextDate.day() === 0; 

    if (isHoliday || isSunday) {
      nextDate.add(1, 'days');
    } else {
      isValidDay = true; 
    }
  }

  return nextDate.toDate();
};