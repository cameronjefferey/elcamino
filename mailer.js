const nodemailer = require('nodemailer');
const { pool } = require('./db');
const config = require('./config.json');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || GMAIL_USER || 'Camino Blog <onboarding@resend.dev>';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

const gmailTransport = GMAIL_USER && GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    })
  : null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function sendEmail(to, subject, html) {
  if (gmailTransport) {
    await gmailTransport.sendMail({
      from: `"${config.siteTitle}" <${GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

function emailEnabled() {
  return !!(gmailTransport || RESEND_API_KEY);
}

// Fire-and-forget: never let email problems break posting.
async function notifySubscribersOfPost(post) {
  if (!emailEnabled()) {
    console.log('[mailer] no email provider configured (GMAIL_USER/GMAIL_APP_PASSWORD or RESEND_API_KEY) - skipping notifications');
    return;
  }
  try {
    const { rows: subs } = await pool.query('SELECT email, token FROM subscribers');
    if (!subs.length) return;

    const postUrl = SITE_URL ? `${SITE_URL}/post/${post.id}` : null;
    const excerpt = String(post.body || '').slice(0, 300);
    const meta = [
      post.day_number ? `Day ${post.day_number}` : null,
      post.location || null,
    ].filter(Boolean).join(' · ');

    for (const sub of subs) {
      const unsubUrl = SITE_URL
        ? `${SITE_URL}/unsubscribe?token=${sub.token}`
        : '#';
      const html = `
        <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; color: #33302a;">
          <p style="color:#b4532a; font-size:14px; letter-spacing:1px; text-transform:uppercase;">${escapeHtml(config.siteTitle)}</p>
          <h1 style="font-size:26px; margin:8px 0;">${escapeHtml(post.title)}</h1>
          ${meta ? `<p style="color:#8a8172; font-size:14px;">${escapeHtml(meta)}</p>` : ''}
          <p style="font-size:17px; line-height:1.6;">${escapeHtml(excerpt)}${post.body.length > 300 ? '…' : ''}</p>
          ${postUrl ? `<p style="margin:28px 0;"><a href="${postUrl}" style="background:#b4532a; color:#fff; padding:14px 26px; border-radius:10px; text-decoration:none; font-size:16px;">Read the full post →</a></p>` : ''}
          <hr style="border:none; border-top:1px solid #e8e0d1; margin:32px 0;">
          <p style="font-size:12px; color:#8a8172;">You're getting this because you signed up to follow along.
          <a href="${unsubUrl}" style="color:#8a8172;">Unsubscribe</a></p>
        </div>`;
      try {
        await sendEmail(sub.email, `New from the Camino: ${post.title}`, html);
      } catch (err) {
        console.error(`[mailer] failed for ${sub.email}:`, err.message);
      }
      // Gentle pacing to stay well under provider rate limits.
      await new Promise((r) => setTimeout(r, 600));
    }
    console.log(`[mailer] notified ${subs.length} subscriber(s) about post ${post.id}`);
  } catch (err) {
    console.error('[mailer] notification run failed:', err.message);
  }
}

// Reply to a reader's email, threaded into their existing conversation.
async function sendReply({ to, subject, text, inReplyTo }) {
  if (!emailEnabled()) throw new Error('Email is not configured');
  const subj = /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
  const html = `<div style="font-family: Georgia, serif; font-size:17px; line-height:1.6; color:#33302a; white-space:pre-wrap;">${escapeHtml(text)}</div>`;
  if (gmailTransport) {
    await gmailTransport.sendMail({
      from: `"${config.siteTitle}" <${GMAIL_USER}>`,
      to,
      subject: subj,
      text,
      html,
      ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
    });
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject: subj,
      html,
      ...(inReplyTo ? { headers: { 'In-Reply-To': inReplyTo, References: inReplyTo } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

// Fire-and-forget welcome note so new followers know the signup worked.
async function sendWelcomeEmail(email, token) {
  if (!emailEnabled()) return;
  try {
    const unsubUrl = SITE_URL ? `${SITE_URL}/unsubscribe?token=${token}` : '#';
    const html = `
      <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; color: #33302a;">
        <p style="color:#b4532a; font-size:14px; letter-spacing:1px; text-transform:uppercase;">${escapeHtml(config.siteTitle)}</p>
        <h1 style="font-size:26px; margin:8px 0;">You're following along! 🐚</h1>
        <p style="font-size:17px; line-height:1.6;">Thanks for signing up. Whenever ${escapeHtml(config.authors)}
        post an update from the trail, you'll get an email right here with the story and a link to the photos.</p>
        <p style="font-size:17px; line-height:1.6;">In the meantime, you can visit the site any time to see
        the latest posts, watch their progress on the map, and check the daily numbers.</p>
        ${SITE_URL ? `<p style="margin:28px 0;"><a href="${SITE_URL}" style="background:#b4532a; color:#fff; padding:14px 26px; border-radius:10px; text-decoration:none; font-size:16px;">Visit the blog →</a></p>` : ''}
        <p style="font-size:17px; line-height:1.6;">Buen Camino!</p>
        <hr style="border:none; border-top:1px solid #e8e0d1; margin:32px 0;">
        <p style="font-size:12px; color:#8a8172;">Didn't mean to sign up?
        <a href="${unsubUrl}" style="color:#8a8172;">Unsubscribe</a></p>
      </div>`;
    await sendEmail(email, `You're following ${config.siteTitle}!`, html);
    console.log(`[mailer] welcome email sent to ${email}`);
  } catch (err) {
    console.error(`[mailer] welcome email failed for ${email}:`, err.message);
  }
}

module.exports = { notifySubscribersOfPost, sendWelcomeEmail, sendReply };
