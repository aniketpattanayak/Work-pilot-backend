const path = require('path');
const safePatch = require('./safe-patch');
const SERVER_ROOT = path.join(__dirname, '..', '..');

safePatch(
  path.join(SERVER_ROOT, 'controllers/tenantController.js'),
  `        const welcomeData = {
          templateName: "mployee_onboarding_welcome",
          variables: [
            name,                              // {{1}}
            tenant.companyName || "WorkPilot", // {{2}}
            roles.join(', '),                  // {{3}}
            department || "Operations",         // {{4}}
            loginLink                          // {{5}}
          ]
        };`,
  `        const welcomeData = {
          templateName: "mployee_onboarding_welcome",
          variables: [
            name,                              // {{1}}
            tenant.companyName || "WorkPilot", // {{2}}
            roles.join(', '),                  // {{3}}
            department || "Operations",         // {{4}}
            loginLink                          // {{5}}
          ],
          // Only read by the Maytapi renderer (tenants using their own
          // configured WhatsApp API) — never sent to DoubleTick/WATI.
          password,
        };`
);
