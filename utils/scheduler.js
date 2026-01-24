const moment = require('moment');

/**
 * SCHEDULER v3.2
 * Purpose: Industrial-grade task scheduling with multi-day support.
 * FIXED: Look-ahead scan for Weekly/Monthly start dates.
 * * Logic Highlights:
 * 1. Initial Scan: If isInitial is true, it checks if the baseDate matches your selection.
 * 2. Iterative Discovery: Walks forward day-by-day until a match is found in authorized arrays.
 * 3. Factory Guard: Skips Sundays/Holidays and re-verifies day selection after the skip.
 */
exports.calculateNextDate = (frequency, config = {}, holidays = [], baseDate = new Date(), isInitial = false) => {
  // Normalize date to start of day to prevent timing drift
  let nextDate = moment(baseDate).startOf('day'); 
  
  /**
   * FACTORY GUARD CHECK
   * Returns true if the day is a Sunday or in the holiday registry.
   */
  const isHolidayOrSunday = (date) => {
    const dateStr = date.format('YYYY-MM-DD');
    const isRegisteredHoliday = holidays.some(h => moment(h.date).format('YYYY-MM-DD') === dateStr);
    const isSunday = date.day() === 0; 
    return isRegisteredHoliday || isSunday;
  };

  // 1. PRIMARY FREQUENCY ENGINE
  switch (frequency) {
    case 'Daily':
      /**
       * DAILY ANCHOR: 
       * If initial setup, use Start Date. Otherwise, add 1 day.
       */
      if (!isInitial) {
        nextDate.add(1, 'days');
      }
      break;

    case 'Weekly':
      /**
       * SMART WEEKLY SCAN (v3.2)
       * Logic: If not initial, move to next day first. 
       * Then, while current day is NOT in authorized list (Mon, Tue, etc.), move to next day.
       */
      const allowedWeekDays = Array.isArray(config.daysOfWeek) && config.daysOfWeek.length > 0 
        ? config.daysOfWeek 
        : [config.dayOfWeek !== undefined ? config.dayOfWeek : 1];

      if (!isInitial) {
        nextDate.add(1, 'days');
      }

      // Look-ahead: Find the first authorized day on or after nextDate
      while (!allowedWeekDays.includes(nextDate.day())) {
        nextDate.add(1, 'days');
      }
      break;

    case 'Monthly':
      /**
       * SMART MONTHLY SCAN (v3.2)
       * Logic: Scans for the next valid date (e.g., 1st, 15th) on or after baseDate.
       */
      const allowedMonthDates = Array.isArray(config.daysOfMonth) && config.daysOfMonth.length > 0 
        ? config.daysOfMonth 
        : [config.dayOfMonth || 1];

      if (!isInitial) {
        nextDate.add(1, 'days');
      }

      // Look-ahead: Find the first authorized calendar date
      while (!allowedMonthDates.includes(nextDate.date())) {
        nextDate.add(1, 'days');
      }
      break;

    case 'Interval':
      if (!isInitial) {
        const gap = parseInt(config.intervalDays) || 1;
        nextDate.add(gap, 'days');
      }
      break;

    case 'Quarterly':
      if (!isInitial) {
        nextDate.add(3, 'months');
      }
      break;

    case 'Half-Yearly':
      if (!isInitial) {
        nextDate.add(6, 'months');
      }
      break;

    case 'Yearly':
      if (!isInitial) {
        nextDate.add(1, 'years');
      }
      break;

    default:
      if (!isInitial) nextDate.add(1, 'days');
  }

  // 2. HOLIDAY & SUNDAY SKIP LOOP (RE-VALIDATED)
  /**
   * Final validation: If the landing date is a Sunday or Holiday, we move forward.
   * If it's a Weekly/Monthly task, we must continue "walking" until we hit 
   * BOTH an authorized day AND a valid factory working day.
   */
  while (isHolidayOrSunday(nextDate)) {
    nextDate.add(1, 'days');

    // For Weekly/Monthly, ensure we don't land on an unauthorized day after skipping a holiday
    if (frequency === 'Weekly') {
      const allowedWeekDays = Array.isArray(config.daysOfWeek) && config.daysOfWeek.length > 0 
        ? config.daysOfWeek : [1];
      while (!allowedWeekDays.includes(nextDate.day())) {
        nextDate.add(1, 'days');
      }
    }

    if (frequency === 'Monthly') {
      const allowedMonthDates = Array.isArray(config.daysOfMonth) && config.daysOfMonth.length > 0 
        ? config.daysOfMonth : [1];
      while (!allowedMonthDates.includes(nextDate.date())) {
        nextDate.add(1, 'days');
      }
    }
  }

  return nextDate.toDate();
};