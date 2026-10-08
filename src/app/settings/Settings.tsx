import React, { useState } from 'react';
import { Alert, Button, Flex, Input, Text, hubspot } from '@hubspot/ui-extensions';

/** Keep equal to permittedUrls.fetch in app-hsmeta.json (a test checks this). */
const BACKEND_URL = 'https://YOUR-BACKEND.example.com';

type SaveAnswer = { ok: boolean; message?: string; error?: { message: string } };

hubspot.extend<'settings'>(() => <Settings />);

const Settings = () => {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [answer, setAnswer] = useState<SaveAnswer | null>(null);

  const save = async () => {
    setSaving(true);
    setAnswer(null);
    try {
      const response = await hubspot.fetch(`${BACKEND_URL}/api/looot-token`, { method: 'POST', body: { token } });
      const body = (await response.json()) as SaveAnswer;
      setAnswer(body);
      if (body.ok) setToken('');
    } catch (error) {
      setAnswer({ ok: false, error: { message: error instanceof Error ? error.message : 'The backend did not answer.' } });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex direction="column" gap="medium">
      <Text>
        Paste a looot agent token. Create one in the looot dashboard under Settings, Agent tokens, with catalog.read, runs.read, runs.execute and usage.read.
        The backend checks it with a free balance read, saves it for this HubSpot account and never shows it again.
      </Text>
      <Input
        label="looot agent token"
        name="loootToken"
        type="password"
        value={token}
        onChange={(value: string) => setToken(value)}
      />
      <Button variant="primary" disabled={saving || token.trim() === ''} onClick={() => void save()}>
        {saving ? 'Checking' : 'Save token'}
      </Button>
      {answer ? (
        <Alert title={answer.ok ? 'Saved' : 'Not saved'} variant={answer.ok ? 'success' : 'danger'}>
          {answer.ok ? (answer.message ?? 'Token saved.') : (answer.error?.message ?? 'Unknown error.')}
        </Alert>
      ) : null}
    </Flex>
  );
};
