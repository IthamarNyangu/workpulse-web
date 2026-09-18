'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';

export default function AcceptInvitePage() {
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!supabase) { setMessage('WorkPulse authentication is not configured.'); setChecking(false); return; }
    const client = supabase;
    const load = async () => {
      const { data } = await client.auth.getSession();
      setEmail(data.session?.user.email || '');
      setMessage(data.session ? null : 'This invitation link is invalid or has expired. Ask HR to send a new account setup email.');
      setChecking(false);
    };
    void load();
    const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
      if (session) { setEmail(session.user.email || ''); setMessage(null); setChecking(false); }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    if (password.length < 8) { setMessage('Use at least 8 characters for your password.'); return; }
    if (password !== confirmation) { setMessage('The passwords do not match.'); return; }
    setSaving(true); setMessage(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setMessage(error.message); setSaving(false); return; }
    setComplete(true); setSaving(false);
  }

  return <main className="invite-page"><section className="invite-brand"><img src="/workpulse-app-icon.png" alt="" /><span>WorkPulse</span></section><section className="invite-card">
    {checking ? <><div className="loader" /><h1>Confirming your invitation</h1><p>Please wait while WorkPulse verifies your secure link.</p></> : complete ? <><div className="invite-success">✓</div><p className="eyebrow">ACCOUNT READY</p><h1>Welcome to WorkPulse</h1><p>Your password has been created. You can now use this account in the WorkPulse portal and mobile app.</p><Link className="primary-button invite-link" href="/">Continue to WorkPulse</Link></> : <><p className="eyebrow">WORKPULSE ACCOUNT SETUP</p><h1>Create your password</h1><p>Your invitation is for <strong>{email || 'this employee account'}</strong>.</p>{email && <form onSubmit={submit}><label>New password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} /></label><label>Confirm password<input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required minLength={8} /></label><button type="submit" className="primary-button" disabled={saving}>{saving ? 'Creating password…' : 'Create password'}</button></form>}{message && <div className="invite-error" role="alert">{message}</div>}</>}
  </section></main>;
}
