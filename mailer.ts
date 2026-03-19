import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Interface for email options
 */
interface MailOptions {
  runId?: string;
  archiveKey?: string;
}

/**
 * Sends Decision Cards JSON via Email with production-ready features.
 * Optimized for Power Automate Flow triggers.
 * 
 * @param cardsArray Array of decision card objects
 * @param opts Optional metadata like runId or archiveKey
 */
export async function sendDecisionCardsEmail(cardsArray: any[], excelRows?: any[], opts: MailOptions = {}): Promise<void> {
  // 1. Validation
  if (!Array.isArray(cardsArray)) {
    console.error("❌ [Mailer] Validation Error: cardsArray must be an array.");
    return;
  }

  const SMTP_USER = process.env.SMTP_USER?.trim() || (process.env.EMAIL_FROM_ADDR || process.env.EMAIL_FROM_ADDRESS)?.trim();
  const SMTP_PASS = process.env.SMTP_PASS?.trim();
  const EMAIL_TO = process.env.EMAIL_TO?.trim();
  const ALERT_TO_EMAIL = process.env.ALERT_TO_EMAIL?.trim();
  const TO_ADDRESSES = [EMAIL_TO, ALERT_TO_EMAIL].filter(Boolean).join(', ');
  const FROM_NAME = process.env.EMAIL_FROM_NAME?.trim() || "Crypto Sentinel";
  const FROM_ADDR = (process.env.EMAIL_FROM_ADDR || process.env.EMAIL_FROM_ADDRESS)?.trim() || SMTP_USER;
  const SUBJECT_PREFIX = process.env.EMAIL_SUBJECT_PREFIX?.trim() || "Crypto Sentinel - Decision Cards JSON";
  const SMTP_PORT = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;

  if (!SMTP_USER || !SMTP_PASS || !TO_ADDRESSES) {
    console.warn("⚠️ [Mailer] Email skipped: SMTP_USER, SMTP_PASS, or EMAIL_TO not configured in .env");
    return;
  }

  const timestamp = new Date().toISOString();
  const subject = `${SUBJECT_PREFIX} [${timestamp}]`;
  
  // 2. Transporter Setup (Gmail App Password)
  const transporterOptions: any = {
    service: 'gmail',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  };
  if (SMTP_PORT) {
    transporterOptions.port = SMTP_PORT;
  }
  const transporter = nodemailer.createTransport(transporterOptions);

  // 3. Email Content Construction
  let body = `Terlampir Decision Cards terbaru.\n\n`;
  body += `Total pairs: ${cardsArray.length}\n`;
  body += `Generated at: ${timestamp}\n`;
  
  if (opts.runId || process.env.SENTINEL_RUN_ID) {
    body += `Run ID: ${opts.runId || process.env.SENTINEL_RUN_ID}\n`;
  }
  if (opts.archiveKey || process.env.SENTINEL_ARCHIVE_KEY) {
    body += `Archive Key: ${opts.archiveKey || process.env.SENTINEL_ARCHIVE_KEY}\n`;
  }

  const attachments: any[] = [
    {
      filename: `decision_cards_${timestamp.replace(/[:.]/g, '-')}.json`,
      content: Buffer.from(JSON.stringify(cardsArray, null, 2), 'utf8'),
      contentType: 'application/json; charset=utf-8'
    }
  ];

  if (Array.isArray(excelRows) && excelRows.length > 0) {
    attachments.push({
      filename: `Sentinel_ExcelRows_v2_${timestamp.replace(/[:.]/g, '-')}.json`,
      content: Buffer.from(JSON.stringify(excelRows, null, 2), 'utf-8'),
      contentType: 'application/json; charset=utf-8'
    });
  }

  const mailOptions = {
    from: `"${FROM_NAME}" <${FROM_ADDR}>`,
    to: TO_ADDRESSES,
    subject: subject,
    text: body,
    headers: {
      'X-Sentinel': 'DecisionCards'
    },
    attachments
  };

  // 4. Send with Light Retry Logic
  const send = async (attempt: number = 1): Promise<void> => {
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ [Mailer] Email sent successfully (Attempt ${attempt}): ${info.messageId}`);
      console.log(`   Subject: ${subject}`);
      console.log(`   Recipients: ${TO_ADDRESSES}`);
      console.log(`   Payload: ${cardsArray.length} pairs`);
    } catch (error: any) {
      const retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ESOCKET'];
      const isRetryable = retryableErrors.some(code => error.code === code || error.message?.includes(code));

      if (isRetryable && attempt < 2) {
        console.warn(`⚠️ [Mailer] Network error (${error.code || 'Unknown'}). Retrying... (Attempt ${attempt + 1})`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
        return send(attempt + 1);
      }

      const errorMsg = error.message || error;
      console.error(`❌ [Mailer] Failed to send email:`, errorMsg);
      if (errorMsg.includes('535-5.7.8')) {
        console.error("💡 ACTION REQUIRED: Your Gmail login was rejected. Please ensure you are using a 16-character 'App Password' (not your regular password) and that 2FA is enabled on your Google Account.");
      }
    }
  };

  await send();
}
