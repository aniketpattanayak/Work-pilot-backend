const nodemailer = require('nodemailer');

/**
 * LRBC EMAIL HUB v1.2
 * Purpose: Sends detailed "Who-Did-What" reports to Factory Admins (ARV, Navtech, etc.).
 * Updated: Changed attachment format to CSV for Spreadsheet support.
 */
const sendReportEmail = async (toEmail, subject, reportContent) => {
  // 1. Safety Check: Ensure Email Credentials Exist
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.error("❌ [LRBC Mail] Configuration Error: EMAIL_USER or EMAIL_PASS missing in .env");
    return false;
  }

  try {
    // 2. Configure Transport (Optimized for Indian SMTP relay)
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS  
      }
    });

    // 3. Define Email Parameters
    const mailOptions = {
      from: `"WorkPilot Reports" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: subject,
      // Simple text body for quick preview
      text: `Hello,\n\nPlease find the detailed work report for your factory attached below as a spreadsheet.\n\nSummary Preview:\n${reportContent.substring(0, 500)}...\n\n(Open the attached CSV file in Excel for full details)\n\nThis is an automated system sync from WorkPilot.`,
      
      // Mandatory .csv attachment for Spreadsheet compatibility
      attachments: [
        {
          // Filename updated to .csv so it opens in Excel/Google Sheets
          filename: `${subject.replace(/ /g, '_')}_${new Date().toISOString().split('T')[0]}.csv`,
          content: reportContent
        }
      ]
    };

    // 4. Dispatch Email
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ [LRBC Mail] Report dispatched to ${toEmail}: ${info.messageId}`);
    return true;

  } catch (error) {
    console.error("❌ [LRBC Mail] Delivery Failure:", error.message);
    
    // Detailed error logging for Gmail authentication issues
    if (error.message.includes('EAUTH')) {
      console.error("💡 Tip: Check if you are using a 'Gmail App Password' and not your regular login password.");
    }
    return false;
  }
};

module.exports = sendReportEmail;