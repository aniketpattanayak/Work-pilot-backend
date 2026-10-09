const path = require('path');
const safePatch = require('./safe-patch');
const SERVER_ROOT = path.join(__dirname, '..', '..');

safePatch(
  path.join(SERVER_ROOT, 'middleware/tenantDb.js'),
  `      const modelFiles = [
        'Employee', 'DelegationTask', 'ChecklistTask',
        'FlowInstance', 'FlowTemplate', 'Tenant',
        'Chat', 'Conversation', 'OrderSubmission', 'Ticket'
      ];`,
  `      const modelFiles = [
        'Employee', 'DelegationTask', 'ChecklistTask',
        'FlowInstance', 'FlowTemplate', 'Tenant',
        'Chat', 'Conversation', 'Message', 'OrderSubmission', 'Ticket'
      ];`
);
