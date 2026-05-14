// server/utils/briefingEngine.js
// FIX P-1: Replaces the N+1 dispatchDailyBriefings implementation in taskController.js.
//
// OLD APPROACH (runs every minute):
//   for each tenant:
//     for each employee:
//       DelegationTask.find({ doerId: employee._id, ... })  ← 1 query PER employee
//   Total: tenants × employees DB queries per minute, 24/7.
//   With 10 tenants × 50 employees = 500 queries/minute = 720,000 queries/day.
//
// NEW APPROACH:
//   Single aggregation pipeline per qualifying tenant, grouping all task counts
//   in one MongoDB round-trip. Reduces to ~1-2 queries per tenant per dispatch.
//
// USAGE: Call scheduleBriefings() once on server start. It registers each
// tenant's cron job at exactly the right time, so the every-minute polling
// loop in index.js can be removed entirely.

const cron = require('node-cron');
const moment = require('moment');
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const Employee = require('../models/Employee');
const DelegationTask = require('../models/DelegationTask');
const sendWhatsAppMessage = require('./whatsappNotify');

/**
 * Dispatches morning briefings for a single tenant using a
 * batched aggregation query instead of per-employee lookups.
 */
const dispatchBriefingForTenant = async (tenant) => {
  try {
    const todayStart = moment().startOf('day').toDate();
    const todayEnd   = moment().endOf('day').toDate();

    // Single aggregation: count tasks per employee in one round-trip
    const taskCounts = await DelegationTask.aggregate([
      {
        $match: {
          tenantId: tenant._id,
          status: { $in: ['Pending', 'Accepted', 'Revision Requested'] },
        },
      },
      {
        $group: {
          _id: '$doerId',
          todaysTasks: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$deadline', todayStart] }, { $lte: ['$deadline', todayEnd] }] },
                1, 0,
              ],
            },
          },
          backlogTasks: {
            $sum: { $cond: [{ $lt: ['$deadline', todayStart] }, 1, 0] },
          },
        },
      },
      // Only include employees who have at least one actionable item
      { $match: { $expr: { $gt: [{ $add: ['$todaysTasks', '$backlogTasks'] }, 0] } } },
    ]);

    if (taskCounts.length === 0) {
      console.log(`[Briefing] No pending tasks for ${tenant.companyName}. Skipping.`);
      return;
    }

    // Build a lookup map: employeeId → counts
    const countMap = Object.fromEntries(
      taskCounts.map(c => [c._id.toString(), c])
    );

    const employeeIds = taskCounts.map(c => c._id);
    const employees = await Employee.find({
      _id: { $in: employeeIds },
      tenantId: tenant._id,
    }).select('name whatsappNumber');

    const loginLink = `https://${tenant.subdomain}.lrbcloud.ai/dashboard/my-tasks`;
    const dateStr   = moment().format('DD MMM YYYY');

    const dispatches = employees
      .filter(emp => emp.whatsappNumber)
      .map(async (emp) => {
        const counts = countMap[emp._id.toString()];
        if (!counts) return;

        const payload = {
          templateName: 'daily_morning_briefing',
          variables: [
            emp.name,
            dateStr,
            String(counts.todaysTasks),
            String(counts.backlogTasks),
            String(counts.todaysTasks + counts.backlogTasks),
            loginLink,
          ],
        };

        try {
          await sendWhatsAppMessage(emp.whatsappNumber, payload);
        } catch (waErr) {
          console.error(`[Briefing] WA failed for ${emp.name}:`, waErr.message);
        }
      });

    await Promise.allSettled(dispatches);
    console.log(`🌅 [Briefing] Dispatched for ${tenant.companyName} (${employees.length} staff notified)`);
  } catch (err) {
    console.error(`[Briefing] Error for tenant ${tenant.companyName}:`, err.message);
  }
};

/**
 * Schedules a cron job for each tenant at their exact 2-hour lead time.
 * Call this once after the DB connects — no polling loop needed.
 *
 * @returns {Function} cleanup function that destroys all scheduled jobs
 */
const scheduleBriefings = async () => {
  const tenants = await Tenant.find().select('companyName subdomain officeHours');
  const jobs = [];

  for (const tenant of tenants) {
    const openingTime = tenant.officeHours?.opening || '09:00';
    const [hh, mm] = openingTime.split(':').map(Number);

    // Calculate target time (2 hours before opening)
    const targetHour   = (hh - 2 + 24) % 24;
    const targetMinute = mm;

    // Cron expression: run once per day at the exact target time
    const cronExpr = `${targetMinute} ${targetHour} * * *`;

    try {
      const job = cron.schedule(cronExpr, () => dispatchBriefingForTenant(tenant), {
        scheduled: true,
        timezone: 'Asia/Kolkata', // set to your server's local timezone
      });
      jobs.push(job);
      console.log(
        `📅 [Briefing] ${tenant.companyName} scheduled at ${String(targetHour).padStart(2,'0')}:${String(targetMinute).padStart(2,'0')} IST`
      );
    } catch (err) {
      console.error(`[Briefing] Failed to schedule for ${tenant.companyName}:`, err.message);
    }
  }

  console.log(`✅ [Briefing] ${jobs.length} tenant schedules registered.`);

  // Return a cleanup function so new tenants added later can be re-scheduled
  return () => jobs.forEach(j => j.destroy());
};

module.exports = { scheduleBriefings, dispatchBriefingForTenant };
