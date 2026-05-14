const moment = require('moment');

function addWorkingTime(startTime, offsetValue, offsetUnit, workingHours) {
  let current = moment(startTime);

  let remainingMinutes =
    offsetUnit === 'hours'
      ? offsetValue * 60
      : offsetUnit === 'days'
      ? offsetValue * 24 * 60
      : offsetValue;

  while (remainingMinutes > 0) {

    const dayStart = moment(current).hour(workingHours.start).minute(0).second(0);
    const dayEnd = moment(current).hour(workingHours.end).minute(0).second(0);

    // 🚫 BEFORE WORK START → jump to start
    if (current.isBefore(dayStart)) {
      current = dayStart;
    }

    // 🚫 AFTER WORK END → next day start
    if (current.isSameOrAfter(dayEnd)) {
      current = current.add(1, 'day').hour(workingHours.start).minute(0).second(0);
      continue;
    }

    // ✅ Available working minutes today
    const minutesLeftToday = dayEnd.diff(current, 'minutes');

    if (remainingMinutes <= minutesLeftToday) {
      current = current.add(remainingMinutes, 'minutes');
      remainingMinutes = 0;
    } else {
      remainingMinutes -= minutesLeftToday;

      // move to next day start
      current = current.add(1, 'day').hour(workingHours.start).minute(0).second(0);
    }
  }

  return current.toDate();
}

module.exports = { addWorkingTime };