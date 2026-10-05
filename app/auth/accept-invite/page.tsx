'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '../../../lib/supabase';

type AccountLinkType = 'invite' | 'recovery';

export default function AcceptInvitePage() {
  const [checking, setChecking] = useState(true);
  const [linkType, setLinkType] = useState<AccountLinkType>('invite');
  const [tokenHash, setTokenHash] = useState('');
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setMessage('WorkPulse authentication is not configured.');
      setChecking(false);
      return;
    }

    const client = supabase;
    const parameters = new URLSearchParams(window.location.search);
    const requestedType = parameters.get('type');
    const nextLinkType: AccountLinkType = requestedType === 'recovery' ? 'recovery' : 'invite';
    const nextTokenHash = parameters.get('token_hash')?.trim() ?? '';

    setLinkType(nextLinkType);

    // A token hash is deliberately not verified on page load. Corporate email
    // scanners may open links automatically, so verification only happens after
    // the employee presses the Continue button below.
    if (nextTokenHash && (requestedType === 'recovery' || requestedType === 'invite')) {
      setTokenHash(nextTokenHash);
      setAwaitingVerification(true);
      setChecking(false);
      return;
    }

    const loadExistingSession = async () => {
      const { data } = await client.auth.getSession();
      setEmail(data.session?.user.email || '');

      if (data.session) {
        setMessage(null);
      } else {
        const providerError = parameters.get('error_description');
        setMessage(
          providerError
            ? providerError.replaceAll('+', ' ')
            : nextLinkType === 'recovery'
              ? 'This password reset link is invalid or has expired. Request a new password reset email.'
              : 'This invitation link is invalid or has expired. Ask HR to send a new account setup email.',
        );
      }
      setChecking(false);
    };

    void loadExistingSession();
    const { data: listener } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setLinkType('recovery');
      if (session) {
        setEmail(session.user.email || '');
        setMessage(null);
        setAwaitingVerification(false);
        setChecking(false);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function verifySecureLink() {
    if (!supabase || !tokenHash || verifying) return;

    setVerifying(true);
    setMessage(null);
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: linkType,
    });

    if (error || !data.session) {
      setMessage(
        linkType === 'recovery'
          ? 'This password reset link is invalid or has expired. Request a new password reset email.'
          : 'This invitation link is invalid or has expired. Ask HR to send a new account setup email.',
      );
      setVerifying(false);
      return;
    }

    setEmail(data.session.user.email || '');
    setTokenHash('');
    setAwaitingVerification(false);
    setVerifying(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    if (password.length < 8) {
      setMessage('Use at least 8 characters for your password.');
      return;
    }
    if (password !== confirmation) {
      setMessage('The passwords do not match.');
      return;
    }

    setSaving(true);
    setMessage(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setMessage(error.message);
      setSaving(false);
      return;
    }
    setComplete(true);
    setSaving(false);
  }

  const isRecovery = linkType === 'recovery';

  return (
    <main className="invite-page">
      <section className="invite-brand">
        <img src="/workpulse-app-icon.png" alt="" />
        <span>WorkPulse</span>
      </section>
      <section className="invite-card">
        {checking ? (
          <>
            <div className="loader" />
            <h1>Checking your secure link</h1>
            <p>Please wait while WorkPulse prepares your account.</p>
          </>
        ) : complete ? (
          <>
            <div className="invite-success">✓</div>
            <p className="eyebrow">{isRecovery ? 'PASSWORD UPDATED' : 'ACCOUNT READY'}</p>
            <h1>{isRecovery ? 'Password updated' : 'Welcome to WorkPulse'}</h1>
            <p>
              {isRecovery
                ? 'Your WorkPulse password has been updated. You can now sign in using your new password.'
                : 'Your password has been created. You can now use this account in the WorkPulse portal and mobile app.'}
            </p>
            <Link className="primary-button invite-link" href="/">
              Continue to WorkPulse
            </Link>
          </>
        ) : awaitingVerification ? (
          <>
            <p className="eyebrow">SECURE VERIFICATION</p>
            <h1>{isRecovery ? 'Reset your password' : 'Set up your account'}</h1>
            <p>
              {isRecovery
                ? 'Continue to verify this password reset request. Your secure link will only be used when you press the button below.'
                : 'Continue to verify your WorkPulse invitation. Your secure link will only be used when you press the button below.'}
            </p>
            <button
              type="button"
              className="primary-button invite-continue"
              disabled={verifying}
              onClick={verifySecureLink}
            >
              {verifying
                ? 'Verifying…'
                : isRecovery
                  ? 'Continue to reset password'
                  : 'Continue account setup'}
            </button>
            {message && (
              <div className="invite-error" role="alert">
                {message}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="eyebrow">{isRecovery ? 'PASSWORD RECOVERY' : 'WORKPULSE ACCOUNT SETUP'}</p>
            <h1>{isRecovery ? 'Create a new password' : 'Create your password'}</h1>
            <p>
              {isRecovery ? 'Update the password for ' : 'Your invitation is for '}
              <strong>{email || 'this employee account'}</strong>.
            </p>
            {email && (
              <form onSubmit={submit}>
                <label>
                  New password
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    minLength={8}
                  />
                </label>
                <label>
                  Confirm password
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    required
                    minLength={8}
                  />
                </label>
                <button type="submit" className="primary-button" disabled={saving}>
                  {saving ? 'Saving…' : isRecovery ? 'Update password' : 'Create password'}
                </button>
              </form>
            )}
            {message && (
              <div className="invite-error" role="alert">
                {message}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
