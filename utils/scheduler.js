const moment = require('moment');

/**
 * UPDATED SCHEDULER v2.5
 * Calculates the next valid working day while skipping holidays and Sundays.
 * Supports: Multi-day weeks, Multi-date months, and Interval spacing.
 * * @param {String} frequency - Daily, Weekly, Monthly, Quarterly, Half-Yearly, Yearly, Interval
 * @param {Object} config - Config (daysOfWeek: [], daysOfMonth: [], intervalDays: Number)
 * @param {Array} holidays - Array of holiday objects [{date: Date}]
 * @param {Date} baseDate - The anchor date for calculation (Defaults to Now)
 */
exports.calculateNextDate = (frequency, config = {}, holidays = [], baseDate = new Date()) => {
  // Start calculation from the baseDate (useful for backlog filling)
  let nextDate = moment(baseDate).startOf('day'); 
  const isHoliday = (date) => {
    const ds = date.format('YYYY-MM-DD');
    return holidays.some(h => moment(h.date).format('YYYY-MM-DD') === ds) || date.day() === 0;
  };

  // 1. DYNAMIC CALCULATION ENGINE
  switch (frequency) {
    case 'Daily':
      nextDate.add(1, 'days');
      break;

    case 'Weekly':
      /**
       * Support for "Twice/Thrice a week" (e.g., Mon, Wed, Fri)
       * We look forward day-by-day until we hit a day included in config.daysOfWeek
       */
      const allowedWeekDays = Array.isArray(config.daysOfWeek) && config.daysOfWeek.length > 0 
        ? config.daysOfWeek 
        : [config.dayOfWeek !== undefined ? config.dayOfWeek : 0]; // Fallback to original logic

      nextDate.add(1, 'days'); 
      // Loop up to 7 days to find the next matching day
      while (!allowedWeekDays.includes(nextDate.day())) {
        nextDate.add(1, 'days');
      }
      break;

    case 'Monthly':
      /**
       * Support for "Multiple times a month" (e.g., 1st and 15th)
       */
      if (Array.isArray(config.daysOfMonth) && config.daysOfMonth.length > 0) {
        nextDate.add(1, 'days');
        // Find the next closest day from the provided array
        while (!config.daysOfMonth.includes(nextDate.date())) {
            nextDate.add(1, 'days');
        }
      } else {
        // Original logic for single day of month
        nextDate.add(1, 'months').date(config.dayOfMonth || 1);
      }
      break;

    case 'Interval':
      /**
       * Support for "Every X days" (e.g., Every 3 days = 10 times a month)
       */
      const gap = parseInt(config.intervalDays) || 1;
      nextDate.add(gap, 'days');
      break;

    case 'Quarterly':
      nextDate.add(3, 'months').date(config.dayOfMonth || 1);
      break;

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

  // 2. HOLIDAY & SUNDAY SKIP LOOP (Preserved logic)
  // If the calculated nextDate is a holiday or Sunday, we keep moving forward.
  while (isHoliday(nextDate)) {
    nextDate.add(1, 'days');
  }

  return nextDate.toDate();
};