# WorkPulse authentication email setup

## Custom SMTP

In the Supabase dashboard, open **Authentication → SMTP Settings**, enable custom SMTP and enter the provisioned WorkPulse mailbox values:

- Sender email: the WorkPulse mailbox address
- Sender name: `WorkPulse`
- Host: the mailbox SMTP host
- Port: the mailbox SMTP port
- Username and password: the mailbox SMTP credentials

Use TLS/SSL exactly as specified by the mailbox provider. Save the settings and use Supabase's test facility if available. Never store the SMTP password in browser code or commit it to this repository.

## URLs

Under **Authentication → URL Configuration** set the Site URL to the deployed WorkPulse portal and allow this redirect URL:

```text
https://your-workpulse-domain/auth/accept-invite
```

Set `NEXT_PUBLIC_APP_URL` in WorkPulse to the same origin, without a trailing slash. For same-network development, the portal can be started on all interfaces and a temporary LAN address such as `http://10.7.50.72:3000` can be allow-listed. A deployed HTTPS URL is required for normal employee use.

## Branded invitation

Open **Authentication → Email Templates → Invite user**. Use this subject:

```text
Set up your WorkPulse account
```

Paste the contents of `supabase/email-templates/invite.html` into the message template and save it. The template retains Supabase's `{{ .ConfirmationURL }}` placeholder.

Under **Email Templates → Reset password**, use the subject `Set up your WorkPulse password` and paste `supabase/email-templates/recovery.html`. **Send setup email** uses this secure recovery flow for existing accounts.
